import type { APIRoute } from 'astro';
import { ENV } from '../../../../lib/runtime';
import { err, ok, readJson } from '../../../../lib/api';
import { loadProject } from '../../../../lib/data';
import { applyTakeAction } from '../../../../lib/takes';
import { sweepLeases } from '../../../../lib/sweep';
import { takesPayload } from '../../../../lib/workspace';

export const GET: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team) return err(403, 'no team');

  const bundle = await loadProject(ENV, team.id, ctx.params.slug!);
  if (!bundle) return err(404, 'no such project');

  await sweepLeases(ENV);
  return ok(await takesPayload(ENV, bundle));
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
  if (
    action !== 'pick' &&
    action !== 'hide' &&
    action !== 'unhide' &&
    action !== 'reroll' &&
    action !== 'giveup'
  )
    return err(400, 'action must be pick, hide, unhide, reroll or giveup');
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
