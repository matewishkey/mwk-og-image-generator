import type { APIRoute } from 'astro';
import { sha256Hex } from '../../lib/crypto';
import { ENV } from '../../lib/runtime';

export const POST: APIRoute = async (ctx) => {
  const env = ENV;
  const cookie = ctx.cookies.get('mwk_session')?.value;
  if (cookie) {
    await env.DB.prepare(`DELETE FROM session WHERE id = ?1`).bind(await sha256Hex(cookie)).run();
    ctx.cookies.delete('mwk_session', { path: '/' });
  }
  return ctx.redirect('/login', 303);
};
