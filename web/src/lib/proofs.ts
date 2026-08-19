/**
 * Style proof sheets: four canonical reference prompts rendered through a style on
 * the cheapest model, so "what does this style actually look like" costs a cent.
 *
 * Proofs are REAL takes in a hidden per-team '_style-proofs' project — the normal
 * run/engine/charge pipeline carries them, so every cent stays in the ledger and
 * the take machinery (status, retries, thumbs) comes for free. take.style_id is
 * what ties a proof to its style.
 */

import { createRun, type ProjectRow, type ShotRow, type StyleRow } from './runs';
import { ulid } from './ulid';

export const PROOF_MODEL = 'zturbo';

/** The style axis test: a face, a scene, a crowd, a text surface. */
export const PROOF_PROMPTS: { label: string; prompt: string }[] = [
  { label: 'face', prompt: 'A person looks straight into the camera mid-laugh, hands framing their face' },
  { label: 'scene', prompt: 'A cluttered desk seen from above: laptop, coffee cup, tangled cables, sticky notes' },
  { label: 'people', prompt: 'Three people argue around a whiteboard covered in diagrams, one pointing' },
  { label: 'text', prompt: 'A small shopfront at street level with a large sign above the door' },
];

export const PROOFS_SLUG = '_style-proofs';

/**
 * Latest succeeded proof thumb per style for one proof label (default 'face') —
 * the preview used by style pickers. One query, shared by every page that shows
 * style thumbs (was copy-pasted four times before round 3).
 */
export async function proofThumbs(
  env: Env,
  teamId: string,
  label = 'face',
): Promise<Map<string, string>> {
  const rows = await env.DB.prepare(
    `SELECT style_id, thumb_key FROM (
       SELECT t.style_id, t.thumb_key,
              row_number() OVER (PARTITION BY t.style_id ORDER BY t.created_at DESC) AS rn
         FROM take t
         JOIN run r ON r.id = t.run_id
         JOIN project p ON p.id = r.project_id
         JOIN shot sh ON sh.id = t.shot_id
        WHERE p.team_id = ?1 AND p.slug = ?2
          AND t.status = 'succeeded' AND t.thumb_key IS NOT NULL AND sh.label = ?3
     ) WHERE rn = 1`,
  )
    .bind(teamId, PROOFS_SLUG, label)
    .all<{ style_id: string; thumb_key: string }>();
  return new Map(rows.results.map((r) => [r.style_id, r.thumb_key]));
}

export async function ensureProofsProject(
  env: Env,
  teamId: string,
  userId: string,
): Promise<{ project: ProjectRow; shots: ShotRow[] }> {
  let project = await env.DB.prepare(
    `SELECT * FROM project WHERE team_id = ?1 AND slug = ?2`,
  )
    .bind(teamId, PROOFS_SLUG)
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
    // archived_at set: hidden from every listing, but runs against it work normally.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO project (id, team_id, slug, name, description, default_style_id,
           brand_kit_id, models, iterations, allow_text, created_by, created_at, updated_at, archived_at)
         VALUES (?1, ?2, ?3, 'Style proofs', 'Internal: the four reference prompts every style is proofed against.',
                 ?4, ?5, ?6, 1, 0, ?7, ?8, ?8, ?8)`,
      ).bind(id, teamId, PROOFS_SLUG, anyStyle.id, kit.id, JSON.stringify([PROOF_MODEL]), userId, now),
      ...PROOF_PROMPTS.map((pp, i) =>
        env.DB.prepare(
          `INSERT INTO shot (id, project_id, position, label, prompt, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
        ).bind(ulid(), id, i + 1, pp.label, pp.prompt, now),
      ),
    ]);
    project = (await env.DB.prepare(`SELECT * FROM project WHERE id = ?1`).bind(id).first<ProjectRow>())!;
  }

  const shots = await env.DB.prepare(
    `SELECT id, position, label, prompt, style_override_id, ref_role FROM shot
      WHERE project_id = ?1 AND deleted_at IS NULL ORDER BY position`,
  )
    .bind(project.id)
    .all<{ id: string; position: number; label: string | null; prompt: string; style_override_id: string | null; ref_role: string | null }>();
  return { project, shots: shots.results };
}

/** Kick a proof run for one style. ~4 x $0.0025. */
export async function runProofs(
  env: Env,
  o: { teamId: string; userId: string; style: StyleRow },
): Promise<string> {
  const { project, shots } = await ensureProofsProject(env, o.teamId, o.userId);
  const r = await createRun(env, {
    teamId: o.teamId,
    userId: o.userId,
    project,
    styles: [o.style],
    shots,
    models: [PROOF_MODEL],
    iterations: 1,
    kind: 'full',
  });
  return r.runId;
}
