import type { APIRoute } from 'astro';
import { ENV } from '../../../../lib/runtime';
import { err, ok, readJson } from '../../../../lib/api';
import { loadProject } from '../../../../lib/data';
import { ulid } from '../../../../lib/ulid';

interface ShotBody {
  action?: 'add' | 'edit' | 'delete';
  prompt?: string;
  label?: string;
  /** Shot id for edit/delete. */
  shot?: string;
}

export const POST: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team) return err(403, 'no team');

  const bundle = await loadProject(ENV, team.id, ctx.params.slug!);
  if (!bundle) return err(404, 'no such project');

  const body = await readJson<ShotBody>(ctx.request);
  if (!body) return err(400, 'send a JSON body (content-type: application/json)');
  const now = new Date().toISOString();

  if (body.action === 'add') {
    const prompt = (body.prompt ?? '').trim();
    if (!prompt) return err(400, 'prompt is required');
    const position = (bundle.shots.at(-1)?.position ?? 0) + 1;
    const id = ulid();
    await ENV.DB.prepare(
      `INSERT INTO shot (id, project_id, position, label, prompt, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
    )
      .bind(id, bundle.project.id, position, (body.label ?? '').trim() || null, prompt, now)
      .run();
    return ok({ shotId: id, position }, 201);
  }

  if (body.action === 'edit' || body.action === 'delete') {
    const shot = bundle.shots.find((s) => s.id === body.shot);
    if (!shot) return err(404, 'no such shot');

    if (body.action === 'edit') {
      const prompt = (body.prompt ?? shot.prompt).trim();
      if (!prompt) return err(400, 'prompt cannot be empty');
      const label = body.label !== undefined ? body.label.trim() || null : shot.label;
      await ENV.DB.prepare(
        `UPDATE shot SET prompt=?1, label=?2, version=version+1, updated_at=?3 WHERE id=?4`,
      )
        .bind(prompt, label, now, shot.id)
        .run();
      return ok({ ok: true });
    }

    await ENV.DB.prepare(`UPDATE shot SET deleted_at=?1 WHERE id=?2`).bind(now, shot.id).run();
    return ok({ ok: true });
  }

  return err(400, 'action must be add, edit or delete');
};
