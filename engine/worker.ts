/**
 * The engine worker: a thin Durable-Object front for the container.
 *
 * One NAMED instance ('main') on purpose — an unnamed container is a global
 * singleton by accident rather than by choice. Concurrency lives inside the
 * container process, exactly like the CLI's -c. No public route: the web app
 * reaches this worker over a service binding only.
 */

import { Container, getContainer } from '@cloudflare/containers';

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

export default {
  async fetch(request: Request, env: EngineEnv): Promise<Response> {
    const url = new URL(request.url);
    if ((url.pathname === '/run' || url.pathname === '/render') && request.method === 'POST') {
      return getContainer(env.ENGINE_CONTAINER, env.INSTANCE_NAME ?? 'main').fetch(request);
    }
    return new Response('not found', { status: 404 });
  },
};
