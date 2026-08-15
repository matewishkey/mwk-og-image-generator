/**
 * Cron-driven lease sweep (engine fires this every 10 minutes, HMAC-signed).
 * The opportunistic sweep on the contact sheet stays — this one covers takes
 * nobody is watching.
 */

import type { APIRoute } from 'astro';
import { seamVerify } from '../../../../src/seam.ts';
import { ENV } from '../../lib/runtime';
import { sweepLeases } from '../../lib/sweep';

export const POST: APIRoute = async (ctx) => {
  const body = await ctx.request.text();
  if (!(await seamVerify(ENV.SEAM_SECRET, ctx.request.headers, body))) {
    return new Response('bad signature', { status: 401 });
  }
  await sweepLeases(ENV);
  return Response.json({ ok: true });
};
