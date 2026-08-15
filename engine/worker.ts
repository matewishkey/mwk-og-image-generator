/**
 * The engine worker: a thin Durable-Object front for the container.
 *
 * One NAMED instance ('main') on purpose — an unnamed container is a global
 * singleton by accident rather than by choice. Concurrency lives inside the
 * container process, exactly like the CLI's -c. No public route: the web app
 * reaches this worker over a service binding only.
 */

import { Container, getContainer } from '@cloudflare/containers';
import { MODELS } from '../src/models.ts';
import { seamHeaders } from '../src/seam.ts';

interface EngineEnv {
  ENGINE_CONTAINER: DurableObjectNamespace<EngineContainer>;
  /** Bump in wrangler.jsonc on image changes: a fresh named instance starts a fresh
   *  container on the LATEST image, instead of waiting out the old one's sleep. */
  INSTANCE_NAME: string;
  REPLICATE_API_TOKEN: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ENDPOINT: string;
  R2_BUCKET: string;
  SEAM_SECRET: string;
  EVENTS_URL: string;
}

export class EngineContainer extends Container<EngineEnv> {
  defaultPort = 8080;
  // Longer than any plausible sweep; the lease sweeper covers a killed container.
  sleepAfter = '30m';

  constructor(ctx: DurableObjectState, env: EngineEnv) {
    super(ctx, env);
    this.envVars = {
      REPLICATE_API_TOKEN: env.REPLICATE_API_TOKEN,
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      R2_ENDPOINT: env.R2_ENDPOINT,
      R2_BUCKET: env.R2_BUCKET,
      SEAM_SECRET: env.SEAM_SECRET,
      EVENTS_URL: env.EVENTS_URL,
    };
  }
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Nightly catalog sync: observed facts from each model's own Replicate record.
 * A changed input fingerprint means the model's schema moved under us — that
 * surfaces as a diff to review rather than as a 422 mid-run. Prices are NOT
 * synced; src/models.ts is their single source of truth.
 */
async function syncCatalog(env: EngineEnv): Promise<void> {
  const syncedAt = new Date().toISOString();
  const rows = [];
  for (const m of MODELS) {
    try {
      const res = await fetch(`https://api.replicate.com/v1/models/${m.id}`, {
        headers: { authorization: `Bearer ${env.REPLICATE_API_TOKEN}` },
      });
      if (!res.ok) {
        rows.push({ modelId: m.id, alias: m.alias, modality: m.modality, error: `HTTP ${res.status}` });
        continue;
      }
      const data = (await res.json()) as {
        run_count?: number;
        latest_version?: {
          created_at?: string;
          openapi_schema?: { components?: { schemas?: { Input?: unknown } } };
        };
      };
      const input = data.latest_version?.openapi_schema?.components?.schemas?.Input ?? null;
      rows.push({
        modelId: m.id,
        alias: m.alias,
        modality: m.modality,
        runCount: data.run_count ?? null,
        modelUpdatedAt: data.latest_version?.created_at ?? null,
        inputFingerprint: input ? await sha256Hex(JSON.stringify(input)) : null,
      });
    } catch (e) {
      rows.push({ modelId: m.id, alias: m.alias, modality: m.modality, error: (e as Error).message });
    }
  }
  const body = JSON.stringify({ syncedAt, rows });
  const url = env.EVENTS_URL.replace('/internal/events', '/internal/catalog');
  const res = await fetch(url, { method: 'POST', headers: await seamHeaders(env.SEAM_SECRET, body), body });
  if (!res.ok) console.error(`catalog sync: web replied ${res.status}`);
}

export default {
  async fetch(request: Request, env: EngineEnv): Promise<Response> {
    const url = new URL(request.url);
    if (['/run', '/render', '/generate'].includes(url.pathname) && request.method === 'POST') {
      return getContainer(env.ENGINE_CONTAINER, env.INSTANCE_NAME ?? 'main').fetch(request);
    }
    return new Response('not found', { status: 404 });
  },
  async scheduled(_event: unknown, env: EngineEnv): Promise<void> {
    await syncCatalog(env);
  },
};
