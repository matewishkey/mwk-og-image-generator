/**
 * The web<->engine seam: what a run request and a take event look like on the wire,
 * and how both directions are signed.
 *
 * Pure on purpose — no node imports — so the same module runs in the Worker and in
 * the engine container. One definition, so the two sides cannot drift.
 *
 * Web -> engine: POST /run with an EngineRunRequest.
 * Engine -> web: POST /internal/events with an EngineEvent per transition.
 * Both carry `x-seam-ts` (unix seconds) and `x-seam-sig` = HMAC-SHA256(secret, `${ts}.${body}`).
 */

import { z } from 'zod';
import type { Style } from './style.ts';

export interface SeamIdea {
  shotId: string;
  /**
   * The shot's RAW idea — what is happening, nothing else. The engine composes
   * it with the style exactly once (compose() in prompt.ts). Never send a
   * composed prompt here: that is how the 2026-08-16 double-compose bug
   * happened, where every take's billed prompt carried the style text twice.
   */
  prompt: string;
  /** Per-shot style override; absent = the run-level style(s). */
  style?: Style;
  /**
   * R2 keys of reference images that apply to THIS shot only — character-chain
   * art first, then shot-scoped uploads. They come BEFORE the run-level refKeys
   * in the model's ref list (specific beats general, and single-reference models
   * only ever see the first image), matching the numbering the composed prompt uses.
   */
  refKeys?: string[];
  /** Per-shot "who the reference person is"; absent = the run-level refRole. */
  refRole?: string;
}

export interface EngineRunRequest {
  runId: string;
  /** R2 prefix this run writes under: teams/<team>/runs/<run> */
  r2Prefix: string;
  /** Idea i (1-based, as in run.ts) is ideas[i-1]; its takes belong to that shot. */
  ideas: SeamIdea[];
  style: Style;
  /**
   * Multi-style runs: every shot renders once per style (shots with a SeamIdea
   * style override render ONLY their override). Absent = [style]. The slugs must
   * be distinct within one run — the cell event correlates takes by style slug.
   */
  styles?: Style[];
  /** Model aliases, resolved against src/models.ts on the engine side. */
  models: string[];
  iterations: number;
  tier?: string;
  /** R2 keys of reference images, downloaded by the engine before the sweep. */
  refKeys: string[];
  title: string;
  kicker?: string;
  tagline?: string;
  allowText?: boolean;
  refRole?: string;
  extra?: string;
  concurrency?: number;
  /**
   * The project's brand kit config (BrandConfig shape); absent = the engine's
   * baked-in brand/brand.json. Without this, a team kit affects designs but
   * never take cards.
   */
  brand?: unknown;
  /** R2 key of an uploaded logo mark; overrides config.logo.mark when present. */
  markKey?: string;
}

/**
 * A layout is DATA. A model can write one, a human can tweak one, and the engine
 * renders either for $0.00. Proven by the 20-variant prototype (2026-08-14).
 *
 * Two authoring levels share this one schema and one renderer:
 * - PRESETS: `archetype` picks one of seven hand-tuned arrangements (their
 *   pixel maths lives in the renderer and never changes shape).
 * - FREEFORM: `cells` places 1-8 panels directly; `texts` and `shapes` add
 *   typography and furniture. All geometry is 0-1 fractions of the canvas.
 *
 * Colors are always brand TOKENS, never hex — the rendering kit resolves them,
 * so the same template serves every brand.
 */

/** The nine BrandConfig color roles a template may name. */
export const ColorTokenSchema = z.enum([
  'paper', 'ink', 'mute', 'faint', 'red', 'redField', 'redDeep', 'line', 'onRed',
]);
export type ColorToken = z.infer<typeof ColorTokenSchema>;

const frac = z.number().min(0).max(1);

/** A freeform panel cell. x/y/w/h are fractions of the panel area (the canvas
 *  minus any reserved band). Freeform feather fades INSIDE the cell's own rect
 *  on the listed edges — unlike preset feathering, which grows a panel over
 *  its neighbour. */
export const CellSchema = z.object({
  x: frac,
  y: frac,
  w: z.number().min(0.02).max(1),
  h: z.number().min(0.02).max(1),
  feather: z.array(z.enum(['left', 'right', 'top', 'bottom'])).optional(),
  fit: z.enum(['cover', 'contain']).default('cover'),
  crop: z.enum(['attention', 'entropy', 'centre']).optional(),
  treat: z.enum(['none', 'desaturate', 'dim', 'tint']).optional(),
  z: z.number().int().min(0).max(30).default(0),
});
export type Cell = z.infer<typeof CellSchema>;

/** A text layer. content is either a literal string or a role binding that
 *  pulls the design's own title/kicker/tagline; an unbound role renders
 *  nothing. font names one of the kit's three faces. */
export const TextSpecSchema = z.object({
  content: z.union([
    z.string().min(1).max(200),
    z.object({ role: z.enum(['projectTitle', 'projectKicker', 'projectTagline']) }),
  ]),
  font: z.enum(['title', 'kicker', 'tagline']),
  x: frac,
  y: frac,
  w: z.number().min(0.05).max(1),
  align: z.enum(['left', 'center', 'right']).default('left'),
  sizeScale: z.number().min(0.3).max(4).default(1),
  color: ColorTokenSchema.default('ink'),
  /** *asterisked runs* render in this token (defaults to redDeep — the only
   *  red permitted at text size). */
  accentColor: ColorTokenSchema.optional(),
  case: z.enum(['upper', 'none']).default('none'),
  trackingEm: z.number().min(0).max(1).optional(),
  z: z.number().int().min(0).max(100).default(60),
});
export type TextSpec = z.infer<typeof TextSpecSchema>;

export const ShapeSchema = z.object({
  kind: z.enum(['rect', 'rule', 'gradient']),
  x: frac,
  y: frac,
  w: frac,
  h: frac,
  color: ColorTokenSchema,
  opacity: z.number().min(0).max(1).default(1),
  /** gradient only: fade direction in degrees; 0 = fades out toward the right. */
  angle: z.number().min(0).max(360).optional(),
  z: z.number().int().min(0).max(100).default(40),
});
export type Shape = z.infer<typeof ShapeSchema>;

export const ChipStyleSchema = z.object({
  plate: ColorTokenSchema.default('paper'),
  text: ColorTokenSchema.default('redDeep'),
  rule: ColorTokenSchema.default('red'),
  /** Which corner of its cell a chip sits in. */
  corner: z.enum(['tl', 'tr', 'bl', 'br']).default('tl'),
});
export type ChipStyle = z.infer<typeof ChipStyleSchema>;

export const LockupBoxSchema = z.object({
  /** Width as a fraction of the canvas (corner/inset lockups only). */
  width: frac.optional(),
  x: frac.optional(),
  y: frac.optional(),
  /** Reserve the band's height under the panel area. Default: lockup === 'bottom'. */
  reserve: z.boolean().optional(),
  scrim: z.boolean().optional(),
});
export type LockupBox = z.infer<typeof LockupBoxSchema>;

/**
 * Extendable base — generate.ts wraps it with a name field. Use
 * LayoutConfigSchema (below) everywhere a config is actually validated: it
 * adds the archetype-or-cells refinement.
 */
export const LayoutConfigObject = z.object({
  /** Preset arrangement; optional when `cells` places panels directly. */
  archetype: z.enum(['hero', 'diptych', 'stack', 'triptych', 'mosaic', 'quad', 'filmstrip']).optional(),
  seam: z.enum(['butt', 'hairline', 'feather']).default('feather'),
  /** Feather width in px at 1200 canvas width; scaled with the canvas. */
  feather: z.number().int().min(20).max(600).optional(),
  lockup: z.enum(['bottom', 'top', 'corner', 'inset', 'rail', 'none']).default('bottom'),
  /** Draw each panel's label chip. Pointless on single-panel layouts. */
  labels: z.boolean().default(true),
  /** Panel order: indexes into the inventory. Extra entries are ignored. */
  order: z.array(z.number().int().min(0)).optional(),
  treats: z.array(z.enum(['none', 'desaturate', 'dim', 'tint']).nullable()).optional(),
  crop: z.enum(['attention', 'entropy', 'centre']).default('attention'),
  /** Freeform panel placement; presence overrides archetype. */
  cells: z.array(CellSchema).min(1).max(8).optional(),
  texts: z.array(TextSpecSchema).max(6).optional(),
  shapes: z.array(ShapeSchema).max(8).optional(),
  /** Canvas ground token; the renderer's default stays `line`. */
  background: ColorTokenSchema.optional(),
  chipStyle: ChipStyleSchema.optional(),
  /** Preset ratio knob: mosaic feature width, diptych split, stack split. */
  split: z.number().min(0.2).max(0.8).optional(),
  lockupBox: LockupBoxSchema.optional(),
});

export const LayoutConfigSchema = LayoutConfigObject.refine(
  (c) => c.archetype != null || (c.cells?.length ?? 0) > 0,
  { message: 'a layout needs an archetype or cells' },
);
export type LayoutConfig = z.infer<typeof LayoutConfigObject>;

/** Panels a given archetype needs. The UI must not offer a triptych to two picks. */
export const ARCHETYPE_PANELS: Record<NonNullable<LayoutConfig['archetype']>, number> = {
  hero: 1,
  diptych: 2,
  stack: 2,
  triptych: 3,
  mosaic: 3,
  quad: 4,
  filmstrip: 4,
};

/** How many panels a config consumes — cells win over the archetype table. */
export function layoutPanels(cfg: LayoutConfig): number {
  return cfg.cells?.length ?? (cfg.archetype ? ARCHETYPE_PANELS[cfg.archetype] : 0);
}

export interface RenderOutput {
  outKey: string;
  thumbKey: string;
  width: number;
  height: number;
}

export interface EngineRenderRequest {
  designId: string;
  /** R2 keys the finished design is written to. */
  outKey: string;
  thumbKey: string;
  width: number;
  height: number;
  /** Batch mode: render the same layout+panels at each size. Panels are fetched
   *  once, which is the whole point — outKey/width/height above are ignored. */
  outputs?: RenderOutput[];
  layout: LayoutConfig;
  /** The brand kit's config JSON — exactly the BrandConfig shape brand.ts reads. */
  brand: unknown;
  /** Finish-pass preset (src/effects.ts) burned in as the last render step. */
  effect?: string;
  /** R2 key of an uploaded logo mark; overrides config.logo.mark when present. */
  markKey?: string;
  text: { title?: string; kicker?: string; tagline?: string };
  /** R2 art keys (never card keys — a band per panel looks absurd), inventory order. */
  panels: { key: string; label?: string }[];
}

export interface EngineRenderResponse {
  ok: true;
  width: number;
  height: number;
  /** Batch mode: one entry per requested output, same order. */
  results?: { outKey: string; ok: boolean; error?: string }[];
}

export interface EngineGenerateRequest {
  prompt: string;
  system?: string;
  /** R2 keys of images the model should look at (sent as data URIs). */
  imageKeys?: string[];
}

export interface EngineGenerateResponse {
  ok: true;
  text: string;
}

export type EngineEvent =
  | { kind: 'run-started'; runId: string; total: number; estimatedUsd: number }
  | {
      kind: 'cell';
      runId: string;
      shotId: string;
      /** Slug of the style this cell rendered in — the take key under multi-style. */
      styleSlug: string;
      modelAlias: string;
      modelId: string;
      iteration: number;
      tier: string;
      ok: boolean;
      /** The EXACT composed string sent to the model. */
      prompt: string;
      costUsd: number;
      seconds: number;
      retries?: number;
      error?: string;
      artKey?: string;
      cardKey?: string;
      thumbKey?: string;
      width?: number;
      height?: number;
    }
  | { kind: 'run-finished'; runId: string; estimatedUsd: number; actualUsd: number };

const te = new TextEncoder();

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    te.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, te.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Headers for an outgoing seam request whose body is `body`. */
export async function seamHeaders(secret: string, body: string): Promise<Record<string, string>> {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    'content-type': 'application/json',
    'x-seam-ts': ts,
    'x-seam-sig': await hmacHex(secret, `${ts}.${body}`),
  };
}

/** True when the signature matches and the timestamp is within `skewSeconds`. */
export async function seamVerify(
  secret: string,
  headers: { get(name: string): string | null },
  body: string,
  skewSeconds = 300,
): Promise<boolean> {
  const ts = headers.get('x-seam-ts');
  const sig = headers.get('x-seam-sig');
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > skewSeconds) return false;
  const expected = await hmacHex(secret, `${ts}.${body}`);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
