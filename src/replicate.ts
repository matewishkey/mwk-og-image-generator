/**
 * Thin wrapper over the Replicate client.
 *
 * Everything — image models and the text model used for brainstorming — goes through
 * one account and one token, which is the reason this project uses Replicate at all
 * rather than talking to OpenAI, Google and BFL separately.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import Replicate from 'replicate';

// The model choice + input shapes live in a pure module both sides can import.
export {
  buildTextInput,
  textFamily,
  TEXT_MODEL_DEFAULT,
  TEXT_MODEL_VISION,
  type TextFamily,
} from './text-models.ts';

let client: Replicate | null = null;

export function replicate(): Replicate {
  if (client) return client;
  const auth = process.env.REPLICATE_API_TOKEN;
  if (!auth) {
    throw new Error(
      'REPLICATE_API_TOKEN is not set.\n' +
        'It lives in td-sops: sops -d ~/projects/td-sops/apps/mwk-og-image-generator.enc.env',
    );
  }
  client = new Replicate({
    auth,
    // Cancel-After (verified 2026-08-19: integer seconds or 30s/5m/2h, range
    // 5s–24h, on prediction-creation requests): if this process dies mid-run,
    // Replicate cancels the orphaned prediction instead of billing it to
    // completion unattended. 15m clears even the slowest gpt2/video cells.
    fetch: (input, init) => {
      // The client passes string | URL | Request — derive the path defensively;
      // an unparseable input just goes through without the header.
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      try {
        if (init?.method === 'POST' && /\/predictions$/.test(new URL(url).pathname)) {
          init = { ...init, headers: { ...(init.headers as Record<string, string>), 'Cancel-After': '15m' } };
        }
      } catch {
        /* pass through untouched */
      }
      return globalThis.fetch(input as string | Request, init);
    },
  });
  return client;
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * Reference images are sent as data URIs so a local file works with no upload step and
 * no public bucket. An http(s) path is passed through untouched.
 */
export async function toDataUri(path: string): Promise<string> {
  if (/^https?:\/\//i.test(path) || path.startsWith('data:')) return path;
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`Unsupported reference image type: ${path}`);
  const bytes = await readFile(path);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/**
 * Replicate returns a FileOutput, a URL string, or an array of either. Flatten to bytes.
 * Used for video as much as stills — the shapes are identical, only the bytes differ.
 */
export async function firstOutput(output: unknown): Promise<Buffer> {
  const one = Array.isArray(output) ? output[0] : output;
  if (one == null) throw new Error('Model returned no output');

  if (typeof one === 'string') {
    const res = await fetch(one);
    if (!res.ok) throw new Error(`Fetching model output failed: ${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  }

  const asFile = one as { blob?: () => Promise<Blob>; url?: () => URL };
  if (typeof asFile.blob === 'function') {
    return Buffer.from(await (await asFile.blob()).arrayBuffer());
  }
  if (typeof asFile.url === 'function') {
    const res = await fetch(asFile.url().toString());
    return Buffer.from(await res.arrayBuffer());
  }

  throw new Error(`Unrecognised model output shape: ${Object.prototype.toString.call(one)}`);
}

/** Run a text model and return its completion as one string. */
export async function runText(
  model: string,
  input: Record<string, unknown>,
): Promise<string> {
  const out = await replicate().run(model as `${string}/${string}`, { input });
  return Array.isArray(out) ? out.join('') : String(out);
}
