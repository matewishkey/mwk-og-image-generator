import type { APIRoute } from 'astro';
import { ENV } from '../../../lib/runtime';
import { sweepLeases } from '../../../lib/sweep';

/** Status poll for the contact sheet. Team-scoped like every query. */
export const GET: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team) return new Response('forbidden', { status: 403 });

  await sweepLeases(ENV);

  const rows = await ENV.DB.prepare(
    `SELECT t.id, t.status FROM take t
       JOIN run r ON r.id = t.run_id
       JOIN project p ON p.id = r.project_id
      WHERE p.team_id = ?1 AND p.slug = ?2 AND t.superseded_by_id IS NULL`,
  )
    .bind(team.id, ctx.params.slug!)
    .all<{ id: string; status: string }>();

  return Response.json(rows.results, { headers: { 'cache-control': 'no-store' } });
};
