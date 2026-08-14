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
