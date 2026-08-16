import type { APIRoute } from 'astro';
import { ENV } from '../../../../lib/runtime';
import { err, ok, readJson } from '../../../../lib/api';
import { loadProject, type ProjectBundle } from '../../../../lib/data';
import { createRun } from '../../../../lib/runs';
import { ulid } from '../../../../lib/ulid';

interface ShotBody {
  action?: 'add' | 'edit' | 'delete' | 'set-style' | 'reshoot';
  prompt?: string;
  label?: string;
  /** Shot id, position (as number or numeric string), or label. */
  shot?: string | number;
  /** Style id or slug for add/edit/set-style; empty string clears the override. */
  style?: string;
}

/** A shot can be addressed by id, position, or label — 'Shot 2' beats a ULID in conversation. */
function findShot(bundle: ProjectBundle, ref: string | number | undefined) {
  if (ref === undefined || ref === '') return undefined;
  const s = String(ref).trim();
  return bundle.shots.find(
    (x) => x.id === s || String(x.position) === s || (x.label ?? '').toLowerCase() === s.toLowerCase(),
  );
}

async function resolveStyle(teamId: string, ref: string): Promise<string | null> {
  const row = await ENV.DB.prepare(
    `SELECT s.id FROM style s JOIN team t ON t.id = s.team_id
      WHERE (s.team_id = ?1 OR t.kind = 'house') AND s.archived_at IS NULL
        AND (s.id = ?2 OR s.slug = ?2)
      ORDER BY t.kind DESC LIMIT 1`,
  )
    .bind(teamId, ref)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export const POST: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  const user = ctx.locals.user;
  if (!team || !user) return err(403, 'no team');

  const bundle = await loadProject(ENV, team.id, ctx.params.slug!);
  if (!bundle) return err(404, 'no such project');

  const body = await readJson<ShotBody>(ctx.request);
  if (!body) return err(400, 'send a JSON body (content-type: application/json)');
  const now = new Date().toISOString();

  if (body.action === 'add') {
    const prompt = (body.prompt ?? '').trim();
    if (!prompt) return err(400, 'prompt is required');
    let styleId: string | null = null;
    if (body.style) {
      styleId = await resolveStyle(team.id, body.style);
      if (!styleId) return err(400, `no style "${body.style}"`);
    }
    const position = (bundle.shots.at(-1)?.position ?? 0) + 1;
    const id = ulid();
    const label = (body.label ?? '').trim() || `Shot ${position}`;
    await ENV.DB.prepare(
      `INSERT INTO shot (id, project_id, position, label, prompt, style_override_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    )
      .bind(id, bundle.project.id, position, label, prompt, styleId, now)
      .run();
    return ok({ shotId: id, position, label }, 201);
  }

  const shot = findShot(bundle, body.shot);
  if (!shot) return err(404, 'no such shot (id, position or label all work)');

  if (body.action === 'edit') {
    const prompt = (body.prompt ?? shot.prompt).trim();
    if (!prompt) return err(400, 'prompt cannot be empty');
    const label = body.label !== undefined ? body.label.trim() || null : shot.label;
    await ENV.DB.prepare(
      `UPDATE shot SET prompt=?1, label=?2, version=version+1, updated_at=?3 WHERE id=?4`,
    )
      .bind(prompt, label, now, shot.id)
      .run();
    return ok({ ok: true, shotId: shot.id });
  }

  if (body.action === 'set-style') {
    let styleId: string | null = null;
    if (body.style) {
      styleId = await resolveStyle(team.id, body.style);
      if (!styleId) return err(400, `no style "${body.style}"`);
    }
    await ENV.DB.prepare(
      `UPDATE shot SET style_override_id=?1, version=version+1, updated_at=?2 WHERE id=?3`,
    )
      .bind(styleId, now, shot.id)
      .run();
    return ok({ ok: true, shotId: shot.id, styleId });
  }

  if (body.action === 'reshoot') {
    try {
      const runId = await createRun(ENV, {
        teamId: team.id,
        userId: user.id,
        project: bundle.project,
        style: bundle.style,
        shots: [shot],
        models: JSON.parse(bundle.project.models),
        iterations: bundle.project.iterations,
        kind: 'shot',
      });
      return ok({ ok: true, runId, url: `/projects/${bundle.project.slug}/takes` }, 201);
    } catch (e) {
      return err(502, `the re-shoot could not start: ${(e as Error).message}`);
    }
  }

  if (body.action === 'delete') {
    await ENV.DB.prepare(`UPDATE shot SET deleted_at=?1 WHERE id=?2`).bind(now, shot.id).run();
    return ok({ ok: true });
  }

  return err(400, 'action must be add, edit, delete, set-style or reshoot');
};
