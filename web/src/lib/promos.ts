/**
 * Model promo shots: ONE fixed, neutral, people-free prompt rendered by every
 * image model, so the /models page can show what each model actually does with
 * the same brief. Same trick as style proofs — a hidden archived project, real
 * takes, every cent in the ledger.
 */

import { createRun, type ProjectRow, type ShotRow, type StyleRow } from './runs';
import { MODELS } from '../../../src/models.ts';
import { ulid } from './ulid';

export const PROMOS_SLUG = '_model-promos';

export const PROMO_PROMPT =
  "A lighthouse keeper's desk at dusk: warm lamp, scattered papers, brass tools, a window onto the sea";

export async function ensurePromosProject(
  env: Env,
  teamId: string,
  userId: string,
): Promise<{ project: ProjectRow; shots: ShotRow[]; style: StyleRow }> {
  let project = await env.DB.prepare(`SELECT * FROM project WHERE team_id = ?1 AND slug = ?2`)
    .bind(teamId, PROMOS_SLUG)
    .first<ProjectRow>();

  if (!project) {
    const now = new Date().toISOString();
    const id = ulid();
    const anyStyle = await env.DB.prepare(
      `SELECT s.id FROM style s JOIN team t ON t.id = s.team_id WHERE t.kind='house' LIMIT 1`,
    ).first<{ id: string }>();
    const kit = await env.DB.prepare(
      `SELECT b.id FROM brand_kit b JOIN team t ON t.id = b.team_id WHERE t.kind='house' LIMIT 1`,
    ).first<{ id: string }>();
    if (!anyStyle || !kit) throw new Error('house style or brand kit missing');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO project (id, team_id, slug, name, description, default_style_id,
           brand_kit_id, models, iterations, allow_text, created_by, created_at, updated_at, archived_at)
         VALUES (?1, ?2, ?3, 'Model promos', 'Internal: one fixed prompt rendered by every model for the catalog page.',
                 ?4, ?5, ?6, 1, 0, ?7, ?8, ?8, ?8)`,
      ).bind(id, teamId, PROMOS_SLUG, anyStyle.id,
             kit.id, JSON.stringify(MODELS.filter((m) => m.modality === 'image').map((m) => m.alias)), userId, now),
      env.DB.prepare(
        `INSERT INTO shot (id, project_id, position, label, prompt, created_at, updated_at)
         VALUES (?1, ?2, 1, 'promo', ?3, ?4, ?4)`,
      ).bind(ulid(), id, PROMO_PROMPT, now),
    ]);
    project = (await env.DB.prepare(`SELECT * FROM project WHERE id = ?1`).bind(id).first<ProjectRow>())!;
  }

  const shots = await env.DB.prepare(
    `SELECT id, position, label, prompt, style_override_id FROM shot
      WHERE project_id = ?1 AND deleted_at IS NULL ORDER BY position`,
  )
    .bind(project.id)
    .all<ShotRow>();
  const style = await env.DB.prepare(`SELECT * FROM style WHERE id = ?1`)
    .bind(project.default_style_id)
    .first<StyleRow>();
  if (!style) throw new Error('promo style missing');
  return { project, shots: shots.results, style };
}

/** Render the promo shot across every image model. Re-runnable; old takes stay. */
export async function runPromos(env: Env, o: { teamId: string; userId: string }): Promise<string> {
  const { project, shots, style } = await ensurePromosProject(env, o.teamId, o.userId);
  return createRun(env, {
    teamId: o.teamId,
    userId: o.userId,
    project,
    style,
    shots,
    models: MODELS.filter((m) => m.modality === 'image').map((m) => m.alias),
    iterations: 1,
    kind: 'full',
  });
}

/** Newest succeeded promo take per model alias, for the catalog thumbs. */
export async function promoThumbs(env: Env, teamId: string): Promise<Map<string, string>> {
  const rows = await env.DB.prepare(
    `SELECT model_alias, key FROM (
       SELECT t.model_alias, coalesce(t.thumb_key, t.card_key) AS key,
              row_number() OVER (PARTITION BY t.model_alias ORDER BY t.created_at DESC) AS rn
         FROM take t
         JOIN run r ON r.id = t.run_id
         JOIN project p ON p.id = r.project_id
        WHERE p.team_id = ?1 AND p.slug = ?2 AND t.status = 'succeeded'
          AND coalesce(t.thumb_key, t.card_key) IS NOT NULL
     ) WHERE rn = 1`,
  )
    .bind(teamId, PROMOS_SLUG)
    .all<{ model_alias: string; key: string }>();
  return new Map(rows.results.map((r) => [r.model_alias, r.key]));
}
