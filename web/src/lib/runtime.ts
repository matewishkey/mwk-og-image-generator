/**
 * The one place that touches `cloudflare:workers`. Astro v6+ removed
 * Astro.locals.runtime.env; bindings and secrets come from this module import.
 */
import { env as rawEnv, waitUntil } from 'cloudflare:workers';

export const ENV = rawEnv as unknown as Env;
export { waitUntil };
