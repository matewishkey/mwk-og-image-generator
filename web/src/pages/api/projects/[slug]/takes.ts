import type { APIRoute } from 'astro';
import { ENV } from '../../../../lib/runtime';
import { err, ok, readJson } from '../../../../lib/api';
import { loadProject } from '../../../../lib/data';
import { applyTakeAction } from '../../../../lib/takes';
import { sweepLeases } from '../../../../lib/sweep';

const LIVE = ['queued', 'running', 'rendering'];

export const GET: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team) return err(403, 'no team');

  const bundle = await loadProject(ENV, team.id, ctx.params.slug!);
  if (!bundle) return err(404, 'no such project');

  await sweepLeases(ENV);

  const [runs, takes] = await Promise.all([
    ENV.DB.prepare(
      `SELECT id, kind, status, estimated_micros, started_at, finished_at
         FROM run WHERE project_id = ?1 ORDER BY started_at DESC`,
    )
      .bind(bundle.project.id)
      .all<{ id: string; kind: string; status: string; estimated_micros: number; started_at: string; finished_at: string | null }>(),
    ENV.DB.prepare(
      `SELECT t.id, t.shot_id, t.model_alias, t.iteration, t.status, t.cost_micros,
              t.error_kind, t.error_message, t.created_at, t.hidden_at,
              (t.id = sh.picked_take_id) AS picked,
              (t.superseded_by_id IS NOT NULL) AS superseded
         FROM take t JOIN run r ON r.id = t.run_id JOIN shot sh ON sh.id = t.shot_id
        WHERE r.project_id = ?1
        ORDER BY sh.position, t.model_alias, t.iteration, t.created_at`,
    )
      .bind(bundle.project.id)
      .all<{
        id: string; shot_id: string; model_alias: string; iteration: number; status: string;
        cost_micros: number; error_kind: string | null; error_message: string | null;
        created_at: string; hidden_at: string | null; picked: number; superseded: number;
      }>(),
  ]);

  return ok({
    runs: runs.results,
    takes: takes.results.map((t) => ({
      ...t,
      picked: !!t.picked,
      superseded: !!t.superseded,
      hidden: !!t.hidden_at,
    })),
    shots: bundle.shots.map((s) => ({ id: s.id, position: s.position, label: s.label, prompt: s.prompt })),
    live: takes.results.some((t) => LIVE.includes(t.status)),
    url: `/projects/${bundle.project.slug}/takes`,
  });
};

export const POST: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  const user = ctx.locals.user;
  if (!team || !user) return err(403, 'no team');

  const bundle = await loadProject(ENV, team.id, ctx.params.slug!);
  if (!bundle) return err(404, 'no such project');

  const body = await readJson<{ action?: string; take?: string }>(ctx.request);
  if (!body) return err(400, 'send a JSON body (content-type: application/json)');
  const action = body.action;
  if (action !== 'pick' && action !== 'hide' && action !== 'unhide' && action !== 'reroll')
    return err(400, 'action must be pick, hide, unhide or reroll');
  if (!body.take) return err(400, 'take is required');

  const result = await applyTakeAction(ENV, {
    team,
    userId: user.id,
    bundle,
    action,
    takeId: body.take,
  });
  if ('error' in result) return err(result.status, result.error);
  return ok(result, action === 'reroll' ? 201 : 200);
};
