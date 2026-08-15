/**
 * The engine: the CLI's own runner behind one HTTP endpoint.
 *
 * POST /run drives src/run.ts runSweep unchanged — queue, concurrency, retries and
 * the brand band are exactly what the CLI does. Take outputs go to R2 over its S3
 * API; every transition is reported back to the web app as an HMAC-signed event.
 * All secrets (Replicate token, R2 keys) live HERE, never in the web app.
 */

import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { AwsClient } from 'aws4fetch';
import sharp from 'sharp';
import { estimate, refMegapixels, runSweep, type Cell } from '../../src/run.ts';
import { resolveModel } from '../../src/models.ts';
import {
  LayoutConfigSchema,
  seamHeaders,
  seamVerify,
  type EngineEvent,
  type EngineGenerateRequest,
  type EngineRenderRequest,
  type EngineRunRequest,
} from '../../src/seam.ts';
import { runText } from '../../src/replicate.ts';
import { loadBrand, type BrandConfig } from '../../src/brand.ts';
import { renderDesign } from './layout.ts';

const PORT = 8080;

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

const SEAM_SECRET = need('SEAM_SECRET');
const EVENTS_URL = need('EVENTS_URL');
const R2_ENDPOINT = need('R2_ENDPOINT');
const R2_BUCKET = need('R2_BUCKET');

const r2 = new AwsClient({
  accessKeyId: need('R2_ACCESS_KEY_ID'),
  secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
  region: 'auto',
  service: 's3',
});

async function r2Put(key: string, body: Buffer, contentType: string): Promise<void> {
  const res = await r2.fetch(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(body),
  });
  if (!res.ok) throw new Error(`R2 PUT ${key}: ${res.status} ${await res.text()}`);
}

async function r2Get(key: string): Promise<Buffer> {
  const res = await r2.fetch(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
  if (!res.ok) throw new Error(`R2 GET ${key}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Events must arrive; a lost cell event is a take stuck 'running' until the sweeper. */
async function postEvent(event: EngineEvent): Promise<void> {
  const body = JSON.stringify(event);
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(EVENTS_URL, {
        method: 'POST',
        headers: await seamHeaders(SEAM_SECRET, body),
        body,
      });
      if (res.ok) return;
      console.error(`event ${event.kind}: web replied ${res.status}`);
    } catch (e) {
      console.error(`event ${event.kind}: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  console.error(`event ${event.kind} DROPPED after 5 attempts`);
}

const activeRuns = new Set<string>();

async function executeRun(req: EngineRunRequest, refBytes: Buffer[]): Promise<void> {
  const outDir = join(tmpdir(), `run-${req.runId}`);
  await mkdir(outDir, { recursive: true });
  const uploads: Promise<void>[] = [];

  try {
    // References arrive as R2 keys; runSweep gets ordinary file paths.
    const refPaths: string[] = [];
    for (const [i, key] of req.refKeys.entries()) {
      const p = join(outDir, `ref-${i}${extname(key) || '.png'}`);
      await writeFile(p, new Uint8Array(refBytes[i]!));
      refPaths.push(p);
    }

    const models = req.models.map(resolveModel);
    const ideas = req.ideas.map((i) => i.prompt);
    const opts = {
      ideas,
      styles: [req.style],
      models,
      iterations: req.iterations,
      refs: refPaths,
      title: req.title,
      kicker: req.kicker,
      tagline: req.tagline,
      tier: req.tier,
      allowText: req.allowText,
      refRole: req.refRole,
      extra: req.extra,
      outDir,
      concurrency: req.concurrency ?? 4,
    };

    const refMp = await refMegapixels(refPaths);
    const total = ideas.length * models.length * req.iterations;
    await postEvent({
      kind: 'run-started',
      runId: req.runId,
      total,
      estimatedUsd: estimate(opts, refMp),
    });

    const manifest = await runSweep({
      ...opts,
      onCell: (cell: Cell) => {
        uploads.push(reportCell(req, outDir, cell));
      },
    });

    await Promise.all(uploads);
    await postEvent({
      kind: 'run-finished',
      runId: req.runId,
      estimatedUsd: manifest.estimatedUsd,
      actualUsd: manifest.actualUsd,
    });
  } finally {
    activeRuns.delete(req.runId);
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function reportCell(req: EngineRunRequest, outDir: string, cell: Cell): Promise<void> {
  const shotId = req.ideas[cell.ideaIndex - 1]?.shotId ?? 'unknown';
  const base = `${req.r2Prefix}/takes/${shotId}__${cell.model}__${cell.iteration}`;

  let artKey: string | undefined;
  let cardKey: string | undefined;
  let thumbKey: string | undefined;
  let width: number | undefined;
  let height: number | undefined;

  try {
    if (!cell.error && cell.artFile && cell.ogFile) {
      const art = await readFile(join(outDir, cell.artFile));
      const card = await readFile(join(outDir, cell.ogFile));
      const meta = await sharp(art).metadata();
      width = meta.width;
      height = meta.height;
      artKey = `${base}/art.png`;
      cardKey = `${base}/card.png`;
      thumbKey = `${base}/thumb.webp`;
      const thumb = await sharp(card).resize({ width: 640 }).webp({ quality: 80 }).toBuffer();
      await r2Put(artKey, art, 'image/png');
      await r2Put(cardKey, card, 'image/png');
      await r2Put(thumbKey, thumb, 'image/webp');
    }
  } catch (e) {
    // The model was already billed even though storage failed; the event still goes
    // out (with the cost) so the ledger row is written — the take fails at 'upload'.
    cell.error = `upload: ${(e as Error).message}`;
    artKey = undefined;
    cardKey = undefined;
    thumbKey = undefined;
  }

  await postEvent({
    kind: 'cell',
    runId: req.runId,
    shotId,
    modelAlias: cell.model,
    modelId: cell.modelId,
    iteration: cell.iteration,
    tier: cell.tier,
    ok: !cell.error,
    prompt: cell.prompt,
    costUsd: cell.costUsd,
    seconds: cell.seconds ?? 0,
    retries: cell.retries,
    error: cell.error,
    artKey,
    cardKey,
    thumbKey,
    width,
    height,
  });
}

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
        const brand = r.brand ? (r.brand as BrandConfig) : await loadBrand();
        const panels = [];
        for (const pnl of r.panels) panels.push({ buf: await r2Get(pnl.key), label: pnl.label });

        if (r.outputs?.length) {
          // Batch: same layout + panels at every size; panels fetched exactly once.
          const results = [];
          for (const out of r.outputs) {
            try {
              const png = await renderDesign(cfg, brand, out.width, out.height, r.text, panels);
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

        const png = await renderDesign(cfg, brand, r.width, r.height, r.text, panels);
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
      // Fetch refs before acknowledging, so a bad key fails the request, not the run.
      const refBytes: Buffer[] = [];
      for (const key of parsed.refKeys) refBytes.push(await r2Get(key));
      activeRuns.add(parsed.runId);
      executeRun(parsed, refBytes).catch((e) => console.error(`run ${parsed.runId}:`, e));
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: parsed.runId }));
    } catch (e) {
      console.error('request error:', e);
      res.writeHead(500).end((e as Error).message);
    }
  });
});

server.listen(PORT, () => console.log(`engine listening on :${PORT}`));
