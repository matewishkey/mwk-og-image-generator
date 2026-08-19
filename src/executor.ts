/**
 * The run executor: everything between an EngineRunRequest and its HMAC events.
 *
 * Extracted from engine/container/server.ts so the SAME code runs in two homes:
 * the engine container (site-clicked runs) and the studio CLI on the dev box
 * (`studio run` — round 8b's direct-ingest). A factory, not module state,
 * because the container reads env at boot while the CLI passes what it loaded
 * from td-sops — importing this from the CLI must never demand engine env.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { AwsClient } from 'aws4fetch';
import sharp from 'sharp';
import { estimate, refMegapixels, runSweep, type Cell } from './run.ts';
import { resolveModel } from './models.ts';
import { seamHeaders, type EngineEvent, type EngineRunRequest } from './seam.ts';
import { loadBrand, type BrandConfig } from './brand.ts';
import { BrandConfigSchema } from './brand-config.ts';

export interface ExecutorConfig {
  seamSecret: string;
  eventsUrl: string;
  r2: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
  /** Progress hook for interactive callers (the CLI prints cells as they land). */
  onCell?: (cell: Cell, done: number, total: number) => void;
}

export interface Executor {
  r2Get(key: string): Promise<Buffer>;
  r2Put(key: string, body: Buffer, contentType: string): Promise<void>;
  postEvent(event: EngineEvent): Promise<void>;
  resolveBrand(raw: unknown, markKey?: string, theme?: 'light' | 'dark'): Promise<BrandConfig>;
  /** Fetch every ref and validate the kit BEFORE any billing — a bad key or a
   * broken kit must fail the caller's request, never a half-billed run. */
  prepareRun(req: EngineRunRequest): Promise<{ refBytes: Map<string, Buffer>; brand: BrandConfig }>;
  executeRun(req: EngineRunRequest, refBytes: Map<string, Buffer>, brand: BrandConfig): Promise<void>;
}

export function createExecutor(cfg: ExecutorConfig): Executor {
  const r2 = new AwsClient({
    accessKeyId: cfg.r2.accessKeyId,
    secretAccessKey: cfg.r2.secretAccessKey,
    region: 'auto',
    service: 's3',
  });

  async function r2Put(key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await r2.fetch(`${cfg.r2.endpoint}/${cfg.r2.bucket}/${key}`, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: new Uint8Array(body),
    });
    if (!res.ok) throw new Error(`R2 PUT ${key}: ${res.status} ${await res.text()}`);
  }

  async function r2Get(key: string): Promise<Buffer> {
    const res = await r2.fetch(`${cfg.r2.endpoint}/${cfg.r2.bucket}/${key}`);
    if (!res.ok) throw new Error(`R2 GET ${key}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Events must arrive; a lost cell event is a take stuck 'running' until the sweeper. */
  async function postEvent(event: EngineEvent): Promise<void> {
    const body = JSON.stringify(event);
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await fetch(cfg.eventsUrl, {
          method: 'POST',
          headers: await seamHeaders(cfg.seamSecret, body),
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

  /**
   * Materialise an uploaded logo mark (R2) as a local file so brand.ts's
   * readFile path works unchanged. Keys are content-addressed, so caching by
   * key is sound for the life of the process.
   */
  const markCache = new Map<string, string>();
  async function localMark(markKey: string): Promise<string> {
    const hit = markCache.get(markKey);
    if (hit) return hit;
    const p = join(tmpdir(), `mark-${markKey.split('/').pop()}`);
    await writeFile(p, new Uint8Array(await r2Get(markKey)));
    markCache.set(markKey, p);
    return p;
  }

  /** Materialise an uploaded font (R2 fileKey), same content-addressed cache. */
  const fontCache = new Map<string, string>();
  async function localFont(fileKey: string): Promise<string> {
    const hit = fontCache.get(fileKey);
    if (hit) return hit;
    const p = join(tmpdir(), `font-${fileKey.split('/').pop()}`);
    await writeFile(p, new Uint8Array(await r2Get(fileKey)));
    fontCache.set(fileKey, p);
    return p;
  }

  /** Validate a kit off the seam (a cast let a broken kit crash pango mid-render). */
  async function resolveBrand(
    raw: unknown,
    markKey?: string,
    theme?: 'light' | 'dark',
  ): Promise<BrandConfig> {
    let brand = raw ? BrandConfigSchema.parse(raw) : await loadBrand();
    // Dark theme: overlay the kit's dark palette when it has one; a kit without
    // colorsDark renders identically in both themes rather than erroring.
    if (theme === 'dark' && brand.colorsDark) {
      brand = { ...brand, colors: { ...brand.colors, ...brand.colorsDark } };
    }
    if (markKey) brand = { ...brand, logo: { ...brand.logo, mark: await localMark(markKey) } };
    for (const role of ['title', 'kicker', 'tagline'] as const) {
      const fk = brand[role].fileKey;
      if (fk) brand = { ...brand, [role]: { ...brand[role], file: await localFont(fk) } };
    }
    return brand;
  }

  async function prepareRun(
    req: EngineRunRequest,
  ): Promise<{ refBytes: Map<string, Buffer>; brand: BrandConfig }> {
    const refKeys = new Set<string>(req.refKeys);
    for (const idea of req.ideas) for (const k of idea.refKeys ?? []) refKeys.add(k);
    const refBytes = new Map<string, Buffer>();
    for (const key of refKeys) refBytes.set(key, await r2Get(key));
    const brand = await resolveBrand(req.brand, req.markKey);
    return { refBytes, brand };
  }

  async function executeRun(
    req: EngineRunRequest,
    refBytes: Map<string, Buffer>,
    brand: BrandConfig,
  ): Promise<void> {
    const outDir = join(tmpdir(), `run-${req.runId}`);
    await mkdir(outDir, { recursive: true });
    const uploads: Promise<void>[] = [];

    try {
      // References arrive as R2 keys; runSweep gets ordinary file paths. A key
      // shared by several ideas (the same chained character) is written once.
      const refPathByKey = new Map<string, string>();
      let refN = 0;
      const localRef = async (key: string): Promise<string> => {
        const hit = refPathByKey.get(key);
        if (hit) return hit;
        const bytes = refBytes.get(key);
        if (!bytes) throw new Error(`ref ${key} was not prefetched`);
        const p = join(outDir, `ref-${refN++}${extname(key) || '.png'}`);
        await writeFile(p, new Uint8Array(bytes));
        refPathByKey.set(key, p);
        return p;
      };
      const refPaths: string[] = [];
      for (const key of req.refKeys) refPaths.push(await localRef(key));
      const ideaRefs: (string[] | null)[] = [];
      for (const idea of req.ideas) {
        if (!idea.refKeys?.length) {
          ideaRefs.push(null);
          continue;
        }
        const paths: string[] = [];
        for (const key of idea.refKeys) paths.push(await localRef(key));
        ideaRefs.push(paths);
      }

      const models = req.models.map(resolveModel);
      // SeamIdea.prompt is the RAW shot idea; runSweep composes it with the style
      // exactly once. Per-shot style overrides ride along in ideaStyles.
      const ideas = req.ideas.map((i) => i.prompt);
      const styles = req.styles?.length ? req.styles : [req.style];
      const opts = {
        ideas,
        ideaStyles: req.ideas.map((i) => i.style ?? null),
        ideaRefs,
        ideaRefRoles: req.ideas.map((i) => i.refRole ?? null),
        styles,
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
        brand,
        outDir,
        concurrency: req.concurrency ?? 4,
      };

      const refMp = await refMegapixels(refPaths);
      // Mirrors runSweep's queue: an overridden idea renders once, not per style.
      const overridden = req.ideas.filter((i) => i.style).length;
      const total =
        (overridden + (ideas.length - overridden) * styles.length) * models.length * req.iterations;
      await postEvent({
        kind: 'run-started',
        runId: req.runId,
        total,
        estimatedUsd: estimate(opts, refMp),
      });

      const manifest = await runSweep({
        ...opts,
        onCell: (cell: Cell, done: number, totalCells: number) => {
          uploads.push(reportCell(req, outDir, cell));
          cfg.onCell?.(cell, done, totalCells);
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
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function reportCell(req: EngineRunRequest, outDir: string, cell: Cell): Promise<void> {
    const shotId = req.ideas[cell.ideaIndex - 1]?.shotId ?? 'unknown';
    // The style is part of the key: under multi-style the same shot × model ×
    // iteration renders once PER style, and identical keys would silently overwrite.
    const base = `${req.r2Prefix}/takes/${shotId}__${cell.style}__${cell.model}__${cell.iteration}`;

    let artKey: string | undefined;
    let artThumbKey: string | undefined;
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
        artThumbKey = `${base}/art-thumb.webp`;
        cardKey = `${base}/card.png`;
        thumbKey = `${base}/thumb.webp`;
        // Two thumbs on purpose: the CARD thumb for design/pack contexts, the raw
        // ART thumb for shot-context grids (the band does not belong there).
        const thumb = await sharp(card).resize({ width: 640 }).webp({ quality: 80 }).toBuffer();
        const artThumb = await sharp(art).resize({ width: 640 }).webp({ quality: 80 }).toBuffer();
        await r2Put(artKey, art, 'image/png');
        await r2Put(artThumbKey, artThumb, 'image/webp');
        await r2Put(cardKey, card, 'image/png');
        await r2Put(thumbKey, thumb, 'image/webp');
      }
    } catch (e) {
      // The model was already billed even though storage failed; the event still goes
      // out (with the cost) so the ledger row is written — the take fails at 'upload'.
      cell.error = `upload: ${(e as Error).message}`;
      artKey = undefined;
      artThumbKey = undefined;
      cardKey = undefined;
      thumbKey = undefined;
    }

    await postEvent({
      kind: 'cell',
      runId: req.runId,
      shotId,
      styleSlug: cell.style,
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
      artThumbKey,
      cardKey,
      thumbKey,
      width,
      height,
    });
  }

  return { r2Get, r2Put, postEvent, resolveBrand, prepareRun, executeRun };
}
