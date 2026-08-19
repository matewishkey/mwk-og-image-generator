/**
 * The engine: the CLI's own runner behind one HTTP endpoint.
 *
 * POST /run drives the shared executor (src/executor.ts — the same code the
 * studio CLI runs for direct-ingest local runs). Take outputs go to R2 over its
 * S3 API; every transition is reported back to the web app as an HMAC-signed
 * event. All secrets (Replicate token, R2 keys) live HERE, never in the web app.
 */

import { createServer } from 'node:http';
import sharp from 'sharp';
import { createExecutor } from '../../src/executor.ts';
import {
  LayoutConfigSchema,
  seamVerify,
  type EngineGenerateRequest,
  type EngineRenderRequest,
  type EngineRunRequest,
} from '../../src/seam.ts';
import { runText } from '../../src/replicate.ts';
import { renderDesign } from './layout.ts';
import { applyEffect } from './effects.ts';

const PORT = 8080;

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

const SEAM_SECRET = need('SEAM_SECRET');

const executor = createExecutor({
  seamSecret: SEAM_SECRET,
  eventsUrl: need('EVENTS_URL'),
  r2: {
    endpoint: need('R2_ENDPOINT'),
    bucket: need('R2_BUCKET'),
    accessKeyId: need('R2_ACCESS_KEY_ID'),
    secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
  },
});
const { r2Get, r2Put, resolveBrand } = executor;

const activeRuns = new Set<string>();

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      if (req.method === 'GET' && req.url === '/ping') {
        res.writeHead(200).end('ok');
        return;
      }
      if (req.method !== 'POST' || !['/run', '/render', '/generate'].includes(req.url ?? '')) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const headers = {
        get: (n: string) => (req.headers[n.toLowerCase()] as string | undefined) ?? null,
      };
      if (!(await seamVerify(SEAM_SECRET, headers, body))) {
        res.writeHead(401).end('bad signature');
        return;
      }
      if (req.url === '/generate') {
        // The knobs are pinned on purpose — an upstream default is not a promise
        // (see PROMPT_FIDELITY in models.ts). Same pins as the CLI's brainstorm.
        const g = JSON.parse(body) as EngineGenerateRequest;
        const images: string[] = [];
        for (const key of g.imageKeys ?? []) {
          images.push(`data:image/png;base64,${(await r2Get(key)).toString('base64')}`);
        }
        const text = await runText('openai/gpt-5.6-terra', {
          prompt: g.prompt,
          ...(g.system ? { system_prompt: g.system } : {}),
          ...(images.length ? { image_input: images } : {}),
          reasoning_effort: 'low',
          verbosity: 'medium',
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, text }));
        return;
      }
      if (req.url === '/render') {
        const r = JSON.parse(body) as EngineRenderRequest;
        const cfg = LayoutConfigSchema.parse(r.layout);
        const brand = await resolveBrand(r.brand, r.markKey, r.theme);
        const panels = [];
        for (const pnl of r.panels) panels.push({ buf: await r2Get(pnl.key), label: pnl.label });

        if (r.inline) {
          // Live preview: PNG bytes straight back, nothing persisted anywhere.
          let png = await renderDesign(cfg, brand, r.width, r.height, r.text, panels);
          if (r.effect) png = await applyEffect(png, r.effect, r.width, r.height);
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(png);
          return;
        }

        if (r.outputs?.length) {
          // Batch: same layout + panels at every size; panels fetched exactly once.
          const results = [];
          for (const out of r.outputs) {
            try {
              let png = await renderDesign(cfg, brand, out.width, out.height, r.text, panels);
              if (r.effect) png = await applyEffect(png, r.effect, out.width, out.height);
              const thumb = await sharp(png).resize({ width: 640 }).webp({ quality: 80 }).toBuffer();
              await r2Put(out.outKey, png, 'image/png');
              await r2Put(out.thumbKey, thumb, 'image/webp');
              results.push({ outKey: out.outKey, ok: true });
            } catch (e) {
              results.push({ outKey: out.outKey, ok: false, error: (e as Error).message });
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, width: 0, height: 0, results }));
          return;
        }

        let png = await renderDesign(cfg, brand, r.width, r.height, r.text, panels);
        if (r.effect) png = await applyEffect(png, r.effect, r.width, r.height);
        const thumb = await sharp(png).resize({ width: 640 }).webp({ quality: 80 }).toBuffer();
        await r2Put(r.outKey, png, 'image/png');
        await r2Put(r.thumbKey, thumb, 'image/webp');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, width: r.width, height: r.height }));
        return;
      }
      const parsed = JSON.parse(body) as EngineRunRequest;
      if (activeRuns.has(parsed.runId)) {
        res.writeHead(202).end('already running');
        return;
      }
      // Resolve refs and the kit before acknowledging, so a bad key or a broken
      // kit fails the request (createRun marks the run failed/dispatch), not the run.
      const { refBytes, brand: runBrand } = await executor.prepareRun(parsed);
      activeRuns.add(parsed.runId);
      executor
        .executeRun(parsed, refBytes, runBrand)
        .catch((e) => console.error(`run ${parsed.runId}:`, e))
        .finally(() => activeRuns.delete(parsed.runId));
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: parsed.runId }));
    } catch (e) {
      console.error('request error:', e);
      res.writeHead(500).end((e as Error).message);
    }
  });
});

server.listen(PORT, () => console.log(`engine listening on :${PORT}`));
