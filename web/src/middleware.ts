import { defineMiddleware } from 'astro:middleware';
import { sha256Hex } from './lib/crypto';
import { ENV, waitUntil } from './lib/runtime';

const PUBLIC = [/^\/login$/, /^\/auth\//, /^\/internal\//, /^\/pack\//, /^\/fonts\//, /^\/_astro\//, /^\/favicon/];

const SESSION_DAYS = 30;

async function loadTeams(env: Env, userId: string): Promise<TeamRef[]> {
  const teams = await env.DB.prepare(
    `SELECT t.id, t.slug, t.name, m.role
       FROM team_member m JOIN team t ON t.id = m.team_id
      WHERE m.user_id = ?1 AND t.kind = 'normal' ORDER BY m.joined_at`,
  )
    .bind(userId)
    .all<TeamRef>();
  return teams.results;
}

export const onRequest = defineMiddleware(async (ctx, next) => {
  ctx.locals.user = null;
  ctx.locals.teams = [];
  ctx.locals.team = null;

  const env = ENV;
  const now = new Date();
  // /api/* speaks JSON both ways: bearer tokens are honoured there (and only
  // there), and auth failures answer 401/403 JSON instead of redirecting.
  const isApi = ctx.url.pathname.startsWith('/api/');

  const auth = ctx.request.headers.get('authorization');
  const cookie = ctx.cookies.get('mwk_session')?.value;

  if (isApi && auth?.startsWith('Bearer ')) {
    const hash = await sha256Hex(auth.slice(7).trim());
    const row = await env.DB.prepare(
      `SELECT k.id AS token_id, k.last_used_at, u.id AS user_id, u.email, u.name
         FROM api_token k JOIN user u ON u.id = k.user_id
        WHERE k.token_hash = ?1 AND k.revoked_at IS NULL AND u.deactivated_at IS NULL`,
    )
      .bind(hash)
      .first<{ token_id: string; last_used_at: string | null; user_id: string; email: string; name: string | null }>();

    if (row) {
      ctx.locals.user = { id: row.user_id, email: row.email, name: row.name };
      ctx.locals.teams = await loadTeams(env, row.user_id);
      ctx.locals.team = ctx.locals.teams[0] ?? null;

      const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : 0;
      if (now.getTime() - lastUsed > 3_600_000) {
        waitUntil(
          env.DB.prepare(`UPDATE api_token SET last_used_at = ?1 WHERE id = ?2`)
            .bind(now.toISOString(), row.token_id)
            .run(),
        );
      }
    }
  } else if (cookie) {
    const sid = await sha256Hex(cookie);
    const row = await env.DB.prepare(
      `SELECT s.last_seen_at, u.id, u.email, u.name
         FROM session s JOIN user u ON u.id = s.user_id
        WHERE s.id = ?1 AND s.expires_at > ?2 AND u.deactivated_at IS NULL`,
    )
      .bind(sid, now.toISOString())
      .first<{ last_seen_at: string | null; id: string; email: string; name: string | null }>();

    if (row) {
      ctx.locals.user = { id: row.id, email: row.email, name: row.name };
      ctx.locals.teams = await loadTeams(env, row.id);
      ctx.locals.team = ctx.locals.teams[0] ?? null;

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

  if (!ctx.locals.user) {
    if (isApi) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (!PUBLIC.some((re) => re.test(ctx.url.pathname))) return ctx.redirect('/login');
  }

  // Viewers read and download; every mutation is a POST, so one check covers them all.
  if (
    ctx.request.method === 'POST' &&
    ctx.locals.user &&
    ctx.locals.team?.role === 'viewer' &&
    !ctx.url.pathname.startsWith('/auth/')
  ) {
    const msg = 'Viewers cannot change things. Ask an owner for the editor role.';
    return isApi ? Response.json({ error: msg }, { status: 403 }) : new Response(msg, { status: 403 });
  }
  return next();
});
