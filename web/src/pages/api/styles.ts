import type { APIRoute } from 'astro';
import { ENV } from '../../lib/runtime';
import { err, ok } from '../../lib/api';

export const GET: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team) return err(403, 'no team');

  const styles = await ENV.DB.prepare(
    `SELECT s.id, s.slug, s.name, s.description, s.origin, (t.kind = 'house') AS house
       FROM style s JOIN team t ON t.id = s.team_id
      WHERE (s.team_id = ?1 OR t.kind = 'house') AND s.archived_at IS NULL
      ORDER BY t.kind DESC, s.name`,
  )
    .bind(team.id)
    .all<{ id: string; slug: string; name: string; description: string; origin: string; house: number }>();

  return ok({ styles: styles.results.map((s) => ({ ...s, house: !!s.house })) });
};
