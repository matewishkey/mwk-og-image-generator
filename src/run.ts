/**
 * A run is a set of idea variants, shot through a set of styles and a set of models.
 *
 * The grid is ideas x styles x models x iterations. Every cell is independent, so cells run
 * concurrently and a cell that fails is recorded and skipped rather than taking the
 * run down — a sweep that loses one model to a content filter is still worth looking at.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { applyBrand, loadBrand, type BrandConfig } from './brand.ts';
import { compose } from './prompt.ts';
import { pickSeconds, pickTier, priceOf, type ModelSpec } from './models.ts';
import { firstOutput, replicate, toDataUri } from './replicate.ts';
import { brandVideo, posterFrame } from './video.ts';
import type { Style } from './style.ts';

export interface Cell {
  /** Which idea variant this cell rendered, and its 1-based position in the run. */
  idea: string;
  ideaIndex: number;
  style: string;
  model: string;
  modelId: string;
  iteration: number;
  tier: string;
  /** Relative to the run directory. */
  artFile?: string;
  ogFile?: string;
  /** Video cells only: the raw clip and the one with the band burned in. */
  rawVideoFile?: string;
  videoFile?: string;
  seconds_?: number;
  prompt: string;
  costUsd: number;
  seconds?: number;
  /** How many times this cell was retried past a transient platform error. */
  retries?: number;
  error?: string;
}

export interface RunManifest {
  runId: string;
  startedAt: string;
  ideas: string[];
  title: string;
  kicker?: string;
  tagline?: string;
  refs: string[];
  estimatedUsd: number;
  actualUsd: number;
  cells: Cell[];
}

export interface RunOpts {
  /** One or more idea variants. The grid is ideas x styles x models x iterations. */
  ideas: string[];
  styles: Style[];
  /**
   * Per-idea style override, parallel to `ideas` (studio: per-shot styles).
   * An overridden idea renders in ITS style instead of the loop style. Only
   * meaningful with a single loop style; a multi-style sweep would render the
   * overridden idea identically in every loop pass.
   */
  ideaStyles?: (Style | null)[];
  models: ModelSpec[];
  iterations: number;
  refs: string[];
  /**
   * Per-idea EXTRA refs (paths/URIs), parallel to `ideas` — character-chain art
   * and shot-scoped uploads. They come BEFORE the run-level refs in the cell's
   * list (single-reference models only ever see the first image).
   */
  ideaRefs?: (string[] | null)[];
  /** Per-idea refRole override, parallel to `ideas`; null = the run-level refRole. */
  ideaRefRoles?: (string | null)[];
  title: string;
  kicker?: string;
  tagline?: string;
  tier?: string;
  /** Requested clip length for video models. */
  seconds?: number;
  /** Allow text inside the picture. See ComposeOpts.allowText. */
  allowText?: boolean;
  /** Who the reference person is in the scene. See ComposeOpts.refRole. */
  refRole?: string;
  extra?: string;
  /** Brand to composite; absent = load brand/brand.json off disk (CLI path). */
  brand?: BrandConfig;
  outDir: string;
  concurrency: number;
  /** Called as each cell settles, for progress output. */
  onCell?: (cell: Cell, done: number, total: number) => void;
  /** Called when a cell hits a transient error and is about to wait and retry. */
  onRetry?: (cell: Cell, attempt: number, waitMs: number, message: string) => void;
}

/**
 * Total megapixels of a set of reference images.
 *
 * Measured, not assumed: the FLUX 2 family bills per input megapixel, so the difference
 * between a phone photo and a downscaled thumbnail is real money.
 */
export async function refMegapixels(paths: string[]): Promise<number> {
  const sizes = await Promise.all(
    paths.map(async (p) => {
      try {
        const { width = 0, height = 0 } = await sharp(p).metadata();
        return (width * height) / 1_000_000;
      } catch {
        return 0;
      }
    }),
  );
  return sizes.reduce((a, b) => a + b, 0);
}

/** Cost of a run before it starts. Cheap insurance against a typo in `-n`. */
export function estimate(
  opts: Pick<RunOpts, 'ideas' | 'styles' | 'models' | 'iterations' | 'tier' | 'seconds'>,
  refMp = 0,
): number {
  const perRound = opts.models.reduce(
    (sum, m) =>
      sum +
      priceOf(
        m,
        pickTier(m, opts.tier),
        m.refStyle === 'single' ? 0 : refMp,
        pickSeconds(m, opts.seconds),
      ),
    0,
  );
  return perRound * opts.styles.length * opts.ideas.length * opts.iterations;
}

/**
 * Transient failures worth retrying rather than losing the cell.
 *
 * Two have actually bitten us: a 429 when the account balance drops under $5 (Replicate
 * throttles hard to 6/min with a burst of 1), and Replicate's own "Prediction interrupted;
 * please retry (code: PA)". Both are the platform asking us to wait, not the prompt being
 * wrong, so a sweep should absorb them instead of reporting a hole.
 */
function retryDelayMs(message: string, attempt: number): number | null {
  const throttled = /\b429\b|too many requests|throttled/i.test(message);
  const interrupted = /prediction interrupted|code: PA\b|\b5\d\d\b/i.test(message);
  if (!throttled && !interrupted) return null;

  // Replicate tells us exactly how long to wait; trust it over a guessed backoff.
  const hinted = message.match(/"retry_after"\s*:\s*(\d+)/);
  if (hinted) return (Number(hinted[1]) + 1) * 1000;
  return Math.min(30_000, 2 ** attempt * 2_000);
}

const MAX_ATTEMPTS = 4;

async function runCell(
  cell: Cell,
  model: ModelSpec,
  style: Style,
  opts: RunOpts,
  brand: BrandConfig,
  refUris: string[],
): Promise<Cell> {
  const started = Date.now();
  try {
    const usable = model.refStyle === 'none' ? [] : refUris.slice(0, model.maxRefs);
    const seconds = pickSeconds(model, opts.seconds);
    const input = model.buildInput({ prompt: cell.prompt, refs: usable, tier: cell.tier, seconds });

    let bytes: Buffer | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const output = await replicate().run(model.id as `${string}/${string}`, { input });
        bytes = await firstOutput(output);
        break;
      } catch (e) {
        const msg = (e as Error).message;
        const wait = attempt < MAX_ATTEMPTS ? retryDelayMs(msg, attempt) : null;
        if (wait === null) throw e;
        cell.retries = attempt;
        opts.onRetry?.(cell, attempt, wait, msg);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (!bytes) throw new Error('Exhausted retries with no output');

    const stem = `i${cell.ideaIndex}__${style.slug}__${model.alias}__${cell.iteration}`;
    const text = { title: opts.title, kicker: opts.kicker, tagline: opts.tagline };

    if (model.modality === 'video') {
      cell.seconds_ = seconds;
      cell.rawVideoFile = join('raw', `${stem}.mp4`);
      await writeFile(join(opts.outDir, cell.rawVideoFile), bytes);

      cell.videoFile = join('video', `${stem}.mp4`);
      await brandVideo(
        join(opts.outDir, cell.rawVideoFile),
        join(opts.outDir, cell.videoFile),
        brand,
        text,
      );

      // A poster doubles as the OG card for the clip, so a video run still yields
      // something shareable that is not a video.
      const poster = await posterFrame(join(opts.outDir, cell.rawVideoFile));
      cell.artFile = join('art', `${stem}.png`);
      await writeFile(join(opts.outDir, cell.artFile), poster);
      cell.ogFile = join('og', `${stem}.png`);
      await writeFile(
        join(opts.outDir, cell.ogFile),
        await applyBrand({ art: poster, brand, ...text }),
      );
    } else {
      cell.artFile = join('art', `${stem}.png`);
      await writeFile(join(opts.outDir, cell.artFile), bytes);
      cell.ogFile = join('og', `${stem}.png`);
      await writeFile(
        join(opts.outDir, cell.ogFile),
        await applyBrand({ art: bytes, brand, ...text }),
      );
    }
  } catch (e) {
    cell.error = (e as Error).message;
    // A cell that never produced an image was never billed.
    cell.costUsd = 0;
  }
  cell.seconds = Math.round((Date.now() - started) / 100) / 10;
  return cell;
}

export async function runSweep(opts: RunOpts): Promise<RunManifest> {
  const brand = opts.brand ?? (await loadBrand());
  await mkdir(join(opts.outDir, 'art'), { recursive: true });
  await mkdir(join(opts.outDir, 'og'), { recursive: true });
  if (opts.models.some((m) => m.modality === 'video')) {
    await mkdir(join(opts.outDir, 'raw'), { recursive: true });
    await mkdir(join(opts.outDir, 'video'), { recursive: true });
  }

  /** A ref resolved for the models (URI) plus its measured megapixels (0 when unmeasurable). */
  interface RefEntry {
    uri: string;
    mp: number;
  }
  const toEntries = async (paths: string[]): Promise<RefEntry[]> =>
    Promise.all(
      paths.map(async (p) => ({
        uri: await toDataUri(p),
        mp: /^https?:|^data:/i.test(p) ? 0 : await refMegapixels([p]),
      })),
    );

  const runRefs = await toEntries(opts.refs);
  const runRefMp = runRefs.reduce((s, e) => s + e.mp, 0);
  const ideaRefEntries = await Promise.all(
    opts.ideas.map((_, i) => toEntries(opts.ideaRefs?.[i] ?? [])),
  );

  /** Bill what the model actually receives: none sees nothing, single sees the
   *  first image only, the rest are capped at maxRefs — never the whole pile. */
  const billedMp = (model: ModelSpec, entries: RefEntry[]): number => {
    if (model.refStyle === 'none') return 0;
    const seen = entries.slice(0, model.refStyle === 'single' ? 1 : model.maxRefs);
    return seen.reduce((s, e) => s + e.mp, 0);
  };

  interface Job {
    cell: Cell;
    model: ModelSpec;
    style: Style;
    /** Style refs plus run refs, already resolved to data URIs. */
    refs: string[];
  }

  // Style-level refs come first: a style that ships its own reference means it, and
  // the single-reference models would otherwise never see it.
  const styleRefCache = new Map<string, RefEntry[]>();
  const refsOf = async (style: Style): Promise<RefEntry[]> => {
    const hit = styleRefCache.get(style.slug);
    if (hit) return hit;
    const entries = style.refs.length ? await toEntries(style.refs) : [];
    styleRefCache.set(style.slug, entries);
    return entries;
  };

  const queue: Job[] = [];
  for (const [styleIndex, loopStyle] of opts.styles.entries()) {
    for (const [ideaIndex, idea] of opts.ideas.entries()) {
      const override = opts.ideaStyles?.[ideaIndex] ?? null;
      // An overridden idea renders ONLY its override — once, not once per loop
      // style, which would bill N identical cells under multi-style.
      if (override && styleIndex > 0) continue;
      const style = override ?? loopStyle;
      const cellEntries = [
        ...(await refsOf(style)),
        ...ideaRefEntries[ideaIndex]!,
        ...runRefs,
      ];
      const cellRefs = cellEntries.map((e) => e.uri);
      for (const model of opts.models) {
        const tier = pickTier(model, opts.tier);
        for (let i = 1; i <= opts.iterations; i++) {
          queue.push({
            style,
            model,
            refs: cellRefs,
            cell: {
              idea,
              ideaIndex: ideaIndex + 1,
              style: style.slug,
              model: model.alias,
              modelId: model.id,
              iteration: i,
              tier,
              prompt: compose({
                style,
                idea,
                hasRefs: cellRefs.length > 0,
                refRole: opts.ideaRefRoles?.[ideaIndex] ?? opts.refRole,
                allowText: opts.allowText,
                extra: opts.extra,
              }),
              costUsd: priceOf(
                model,
                tier,
                billedMp(model, cellEntries),
                pickSeconds(model, opts.seconds),
              ),
            },
          });
        }
      }
    }
  }

  const total = queue.length;
  let done = 0;
  const results: Cell[] = [];

  let next = 0;
  const workers = Array.from({ length: Math.min(opts.concurrency, total) }, async () => {
    while (next < queue.length) {
      const job = queue[next++];
      const settled = await runCell(job.cell, job.model, job.style, opts, brand, job.refs);
      results.push(settled);
      opts.onCell?.(settled, ++done, total);
    }
  });
  await Promise.all(workers);

  results.sort(
    (a, b) =>
      a.ideaIndex - b.ideaIndex ||
      a.style.localeCompare(b.style) ||
      a.model.localeCompare(b.model) ||
      a.iteration - b.iteration,
  );

  const manifest: RunManifest = {
    runId: opts.outDir.split('/').pop() ?? 'run',
    startedAt: new Date().toISOString(),
    ideas: opts.ideas,
    title: opts.title,
    kicker: opts.kicker,
    tagline: opts.tagline,
    refs: opts.refs,
    estimatedUsd: estimate(opts, runRefMp),
    actualUsd: results.reduce((s, c) => s + c.costUsd, 0),
    cells: results,
  };

  await writeFile(join(opts.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
