import type { APIRoute } from 'astro';
import { ENV } from '../../lib/runtime';
import { err, ok, readJson } from '../../lib/api';
import { listLibrary, renameReference } from '../../lib/media';

export const GET: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team) return err(403, 'no team');
  const refs = await listLibrary(ENV, team.id);
  return ok({
    references: refs.map((r) => ({
      id: r.id,
      name: r.name,
      filename: r.filename,
      width: r.width,
      height: r.height,
      uses: r.uses,
      created_at: r.created_at,
    })),
  });
};

export const POST: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team) return err(403, 'no team');
  const body = await readJson<{ action?: string; ref?: string; name?: string }>(ctx.request);
  if (!body) return err(400, 'send a JSON body (content-type: application/json)');
  if (body.action !== 'rename') return err(400, 'action must be rename');
  if (!body.ref) return err(400, 'ref is required');
  const done = await renameReference(ENV, team.id, body.ref, body.name ?? '');
  if (!done) return err(404, 'no such reference');
  return ok({ ok: true });
};
