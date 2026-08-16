import type { ProjectRow, ShotRow, StyleRow } from './runs';

export interface ProjectBundle {
  project: ProjectRow & { description: string; brand_kit_id: string };
  /** The project's PRIMARY style (default_style_id) — previews, proofs, fallback. */
  style: StyleRow;
  /** The full style SET a run renders every shot in; styles[0] is the primary. */
  styles: StyleRow[];
  shots: (ShotRow & { picked_take_id: string | null })[];
}

export async function loadProject(
  env: Env,
  teamId: string,
  slug: string,
): Promise<ProjectBundle | null> {
  const project = await env.DB.prepare(
    `SELECT * FROM project WHERE team_id = ?1 AND slug = ?2 AND archived_at IS NULL`,
  )
    .bind(teamId, slug)
    .first<ProjectBundle['project']>();
  if (!project) return null;

  const [styles, shots] = await Promise.all([
    env.DB.prepare(
      `SELECT s.* FROM project_style ps JOIN style s ON s.id = ps.style_id
        WHERE ps.project_id = ?1 ORDER BY ps.position`,
    )
      .bind(project.id)
      .all<StyleRow>(),
    env.DB.prepare(
      `SELECT id, position, label, prompt, picked_take_id, style_override_id, ref_role
         FROM shot WHERE project_id = ?1 AND deleted_at IS NULL ORDER BY position`,
    )
      .bind(project.id)
      .all<ProjectBundle['shots'][number]>(),
  ]);

  // The primary is the default_style_id row; fall back to fetching it directly
  // for a project that somehow has no project_style rows.
  let set = styles.results;
  if (!set.length) {
    const fallback = await env.DB.prepare(`SELECT * FROM style WHERE id = ?1`)
      .bind(project.default_style_id)
      .first<StyleRow>();
    if (!fallback) return null;
    set = [fallback];
  }
  const primary = set.find((s) => s.id === project.default_style_id) ?? set[0]!;
  return { project, style: primary, styles: set, shots: shots.results };
}
