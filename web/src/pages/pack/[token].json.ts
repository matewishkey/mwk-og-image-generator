import type { APIRoute } from 'astro';
import { ENV } from '../../lib/runtime';
import { loadPack } from '../../lib/pack';

export const GET: APIRoute = async (ctx) => {
  const pack = await loadPack(ENV, ctx.params.token ?? '');
  if (!pack) return new Response('not found', { status: 404 });
  return Response.json(pack, { headers: { 'cache-control': 'no-store' } });
};
