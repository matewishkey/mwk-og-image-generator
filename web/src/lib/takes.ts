/** Take actions (pick / hide / unhide / reroll), shared by the takes page and the JSON API. */

import type { ProjectBundle } from './data';
import { createRun } from './runs';

export interface TakeActionOpts {
  team: TeamRef;
  userId: string;
  bundle: ProjectBundle;
  action: 'pick' | 'hide' | 'unhide' | 'reroll';
  takeId: string;
}

export type TakeActionResult = { ok: true; runId?: string } | { error: string; status: number };

export async function applyTakeAction(env: Env, o: TakeActionOpts): Promise<TakeActionResult> {
  const nowIso = new Date().toISOString();

  const take = await env.DB.prepare(
    `SELECT t.id, t.shot_id, t.model_alias, t.status FROM take t
      JOIN run r ON r.id = t.run_id
     WHERE t.id = ?1 AND t.team_id = ?2 AND r.project_id = ?3`,
  )
    .bind(o.takeId, o.team.id, o.bundle.project.id)
    .first<{ id: string; shot_id: string; model_alias: string; status: string }>();
  if (!take) return { error: 'No such take in this project.', status: 404 };

  if (o.action === 'pick') {
    if (take.status !== 'succeeded')
      return { error: 'Only a succeeded take can be picked.', status: 409 };
    // Repicking is one idempotent UPDATE — the Pick lives on the shot.
    await env.DB.prepare(`UPDATE shot SET picked_take_id = ?1, updated_at = ?2 WHERE id = ?3`)
      .bind(take.id, nowIso, take.shot_id)
      .run();
    return { ok: true };
  }

  if (o.action === 'hide') {
    await env.DB.prepare(`UPDATE take SET hidden_at = ?1 WHERE id = ?2`).bind(nowIso, take.id).run();
    return { ok: true };
  }

  if (o.action === 'unhide') {
    await env.DB.prepare(`UPDATE take SET hidden_at = NULL WHERE id = ?1`).bind(take.id).run();
    return { ok: true };
  }

  // reroll
  const shot = o.bundle.shots.find((s) => s.id === take.shot_id);
  if (!shot) return { error: 'The take’s shot no longer exists.', status: 409 };
  try {
    const runId = await createRun(env, {
      teamId: o.team.id,
      userId: o.userId,
      project: o.bundle.project,
      style: o.bundle.style,
      shots: [shot],
      models: [take.model_alias],
      iterations: 1,
      kind: 'take',
      supersedeTakeId: take.id,
    });
    return { ok: true, runId };
  } catch (e) {
    return { error: `The re-roll could not start: ${(e as Error).message}`, status: 502 };
  }
}
