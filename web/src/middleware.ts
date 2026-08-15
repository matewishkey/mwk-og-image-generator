import { defineMiddleware } from 'astro:middleware';
import { sha256Hex } from './lib/crypto';
import { ENV, waitUntil } from './lib/runtime';

const PUBLIC = [/^\/login$/, /^\/auth\//, /^\/internal\//, /^\/fonts\//, /^\/_astro\//, /^\/favicon/];

const SESSION_DAYS = 30;

export const onRequest = defineMiddleware(async (ctx, next) => {
  ctx.locals.user = null;
  ctx.locals.teams = [];
  ctx.locals.team = null;

  const env = ENV;
  const cookie = ctx.cookies.get('mwk_session')?.value;
  if (cookie) {
    const sid = await sha256Hex(cookie);
    const now = new Date();
    const row = await env.DB.prepare(
      `SELECT s.last_seen_at, u.id, u.email, u.name
         FROM session s JOIN user u ON u.id = s.user_id
        WHERE s.id = ?1 AND s.expires_at > ?2 AND u.deactivated_at IS NULL`,
    )
      .bind(sid, now.toISOString())
      .first<{ last_seen_at: string | null; id: string; email: string; name: string | null }>();

    if (row) {
      ctx.locals.user = { id: row.id, email: row.email, name: row.name };
      const teams = await env.DB.prepare(
        `SELECT t.id, t.slug, t.name, m.role
           FROM team_member m JOIN team t ON t.id = m.team_id
          WHERE m.user_id = ?1 AND t.kind = 'normal' ORDER BY m.joined_at`,
      )
        .bind(row.id)
        .all<TeamRef>();
      ctx.locals.teams = teams.results;
      ctx.locals.team = teams.results[0] ?? null;

      // Sliding expiry, bumped at most hourly so reads stay reads.
      const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
      if (now.getTime() - lastSeen > 3_600_000) {
        const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString();
        waitUntil(
          env.DB.prepare(`UPDATE session SET last_seen_at = ?1, expires_at = ?2 WHERE id = ?3`)
            .bind(now.toISOString(), expires, sid)
            .run(),
        );
      }
    }
  }

  if (!ctx.locals.user && !PUBLIC.some((re) => re.test(ctx.url.pathname))) {
    return ctx.redirect('/login');
  }

  // Viewers read and download; every mutation is a POST, so one check covers them all.
  if (
    ctx.request.method === 'POST' &&
    ctx.locals.user &&
    ctx.locals.team?.role === 'viewer' &&
    !ctx.url.pathname.startsWith('/auth/')
  ) {
    return new Response('Viewers cannot change things. Ask an owner for the editor role.', {
      status: 403,
    });
  }
  return next();
});
