import type { APIRoute } from 'astro';
import { ENV } from '../../../lib/runtime';
import { err, ok, readJson } from '../../../lib/api';
import { createProject } from '../../../lib/projects';

export const GET: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team) return err(403, 'no team');

  const rows = await ENV.DB.prepare(
    `SELECT slug, name, description, models, iterations, created_at
       FROM project WHERE team_id = ?1 AND archived_at IS NULL ORDER BY created_at DESC`,
  )
    .bind(team.id)
    .all<{ slug: string; name: string; description: string; models: string; iterations: number; created_at: string }>();

  return ok({
    projects: rows.results.map((p) => ({
      ...p,
      models: JSON.parse(p.models) as string[],
      url: `/projects/${p.slug}/shots`,
    })),
  });
};

export const POST: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  const user = ctx.locals.user;
  if (!team || !user) return err(403, 'no team');

  const body = await readJson<{
    name?: string;
    description?: string;
    style?: string;
    brandKit?: string;
    models?: string[];
    iterations?: number;
  }>(ctx.request);
  if (!body) return err(400, 'send a JSON body (content-type: application/json)');
  if (!body.name || !body.style || !Array.isArray(body.models))
    return err(400, 'name, style and models are required');

  const result = await createProject(ENV, {
    teamId: team.id,
    userId: user.id,
    name: body.name,
    description: body.description,
    style: body.style,
    brandKit: body.brandKit,
    models: body.models,
    iterations: body.iterations,
  });
  if ('error' in result) return err(result.status, result.error);
  return ok({ slug: result.slug, url: `/projects/${result.slug}/shots` }, 201);
};
