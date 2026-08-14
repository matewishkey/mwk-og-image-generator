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
  prompt: string;
}

export interface EngineRunRequest {
  runId: string;
  /** R2 prefix this run writes under: teams/<team>/runs/<run> */
  r2Prefix: string;
  /** Idea i (1-based, as in run.ts) is ideas[i-1]; its takes belong to that shot. */
  ideas: SeamIdea[];
  style: Style;
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
}

/**
 * A layout is DATA. A model can write one, a human can tweak one, and the engine
 * renders either for $0.00. Proven by the 20-variant prototype (2026-08-14).
 */
export const LayoutConfigSchema = z.object({
  archetype: z.enum(['hero', 'diptych', 'stack', 'triptych', 'mosaic', 'quad', 'filmstrip']),
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
});
export type LayoutConfig = z.infer<typeof LayoutConfigSchema>;

/** Panels a given archetype needs. The UI must not offer a triptych to two picks. */
export const ARCHETYPE_PANELS: Record<LayoutConfig['archetype'], number> = {
  hero: 1,
  diptych: 2,
  stack: 2,
  triptych: 3,
  mosaic: 3,
  quad: 4,
  filmstrip: 4,
};

export interface EngineRenderRequest {
  designId: string;
  /** R2 keys the finished design is written to. */
  outKey: string;
  thumbKey: string;
  width: number;
  height: number;
  layout: LayoutConfig;
  /** The brand kit's config JSON — exactly the BrandConfig shape brand.ts reads. */
  brand: unknown;
  text: { title?: string; kicker?: string; tagline?: string };
  /** R2 art keys (never card keys — a band per panel looks absurd), inventory order. */
  panels: { key: string; label?: string }[];
}

export interface EngineRenderResponse {
  ok: true;
  width: number;
  height: number;
}

export type EngineEvent =
  | { kind: 'run-started'; runId: string; total: number; estimatedUsd: number }
  | {
      kind: 'cell';
      runId: string;
      shotId: string;
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
