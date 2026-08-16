/**
 * R2 objects served through the app after a team check — the bucket is never public.
 * Takes are immutable, so the cache header is honest.
 */

import type { APIRoute } from 'astro';
import { ENV } from '../../lib/runtime';

export const GET: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team) return new Response('forbidden', { status: 403 });

  const key = ctx.params.key ?? '';
  if (!key.startsWith(`teams/${team.id}/`)) return new Response('forbidden', { status: 403 });

  const obj = await ENV.BUCKET.get(key);
  if (!obj) return new Response('not found', { status: 404 });

  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'image/png',
      'cache-control': 'private, max-age=31536000, immutable',
      etag: obj.httpEtag,
      // Uploaded SVG marks are served from here; a script inside one must
      // never run in the app's origin when navigated to directly.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
    },
  });
};
