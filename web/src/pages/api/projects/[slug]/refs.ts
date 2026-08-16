/**
 * Reference photos on a project: the round-3 gap cluster. Attach/detach at
 * project scope ("every shot") or shot scope, set the project ref-role, and
 * upload straight into the library + attach. GET returns the full ref state
 * the workspace island renders.
 */

import type { APIRoute } from 'astro';
import { ENV } from '../../../../lib/runtime';
import { err, ok, readJson } from '../../../../lib/api';
import { loadProject } from '../../../../lib/data';
import { refState, uploadReferences } from '../../../../lib/media';

async function nextPosition(ownerType: string, ownerId: string): Promise<number> {
  const row = await ENV.DB.prepare(
    `SELECT coalesce(max(position), 0) AS p FROM reference_use WHERE owner_type=?1 AND owner_id=?2`,
  )
    .bind(ownerType, ownerId)
    .first<{ p: number }>();
  return (row?.p ?? 0) + 1;
}

export const GET: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team) return err(403, 'no team');
  const bundle = await loadProject(ENV, team.id, ctx.params.slug!);
  if (!bundle) return err(404, 'no such project');
  return ok(await refState(ENV, team.id, bundle.project.id, bundle.shots.map((s) => s.id)));
};

export const POST: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  const user = ctx.locals.user;
  if (!team || !user) return err(403, 'no team');
  const bundle = await loadProject(ENV, team.id, ctx.params.slug!);
  if (!bundle) return err(404, 'no such project');

  const done = async () =>
    ok(await refState(ENV, team.id, bundle.project.id, bundle.shots.map((s) => s.id)));

  const resolveOwner = (shot?: string): { type: 'project' | 'shot'; id: string } | null => {
    if (!shot) return { type: 'project', id: bundle.project.id };
    const s = bundle.shots.find((x) => x.id === shot || String(x.position) === shot);
    return s ? { type: 'shot', id: s.id } : null;
  };

  const body = await readJson<{ action?: string; ref?: string; shot?: string; refRole?: string }>(
    ctx.request,
  );

  if (body) {
    const owner = resolveOwner(body.shot);
    if (!owner) return err(404, 'no such shot');

    if (body.action === 'attach') {
      const refRow = await ENV.DB.prepare(
        `SELECT id FROM reference WHERE id=?1 AND team_id=?2 AND deleted_at IS NULL`,
      )
        .bind(body.ref ?? '', team.id)
        .first();
      if (!refRow) return err(404, 'no such reference in the library');
      await ENV.DB.prepare(
        `INSERT OR IGNORE INTO reference_use (reference_id, owner_type, owner_id, position)
         VALUES (?1, ?2, ?3, ?4)`,
      )
        .bind(body.ref, owner.type, owner.id, await nextPosition(owner.type, owner.id))
        .run();
      return done();
    }

    if (body.action === 'remove') {
      await ENV.DB.prepare(
        `DELETE FROM reference_use WHERE owner_type=?1 AND owner_id=?2 AND reference_id=?3`,
      )
        .bind(owner.type, owner.id, body.ref ?? '')
        .run();
      return done();
    }

    if (body.action === 'role') {
      await ENV.DB.prepare(`UPDATE project SET ref_role=?1, updated_at=?2 WHERE id=?3`)
        .bind((body.refRole ?? '').trim() || null, new Date().toISOString(), bundle.project.id)
        .run();
      return ok({ ok: true, refRole: (body.refRole ?? '').trim() || null });
    }

    return err(400, 'action must be attach, remove or role');
  }

  // Multipart: upload files into the library, then attach where asked.
  const ct = ctx.request.headers.get('content-type') ?? '';
  if (!ct.includes('multipart/form-data'))
    return err(400, 'send JSON (attach/remove/role) or multipart form-data (upload)');
  const form = await ctx.request.formData();
  const files = form.getAll('photos').filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return err(400, 'no files in "photos"');
  const owner = resolveOwner(String(form.get('shot') ?? '') || undefined);
  if (!owner) return err(404, 'no such shot');

  const outcome = await uploadReferences(ENV, team.id, files);
  let pos = await nextPosition(owner.type, owner.id);
  for (const refId of outcome.ids) {
    await ENV.DB.prepare(
      `INSERT OR IGNORE INTO reference_use (reference_id, owner_type, owner_id, position)
       VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(refId, owner.type, owner.id, pos++)
      .run();
  }
  const state = await refState(ENV, team.id, bundle.project.id, bundle.shots.map((s) => s.id));
  return ok({ ...state, errors: outcome.errors });
};
