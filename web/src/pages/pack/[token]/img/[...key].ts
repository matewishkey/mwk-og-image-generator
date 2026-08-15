import type { APIRoute } from 'astro';
import { ENV } from '../../../../lib/runtime';
import { packTeam } from '../../../../lib/pack';

/** Pack images: token-gated, scoped to the pack's team. Keys are ULID-based and
 *  unguessable; the token is the credential. */
export const GET: APIRoute = async (ctx) => {
  const teamId = await packTeam(ENV, ctx.params.token ?? '');
  if (!teamId) return new Response('not found', { status: 404 });

  const key = ctx.params.key ?? '';
  if (!key.startsWith(`teams/${teamId}/`)) return new Response('forbidden', { status: 403 });

  const obj = await ENV.BUCKET.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'image/png',
      'cache-control': 'public, max-age=3600',
      etag: obj.httpEtag,
    },
  });
};
