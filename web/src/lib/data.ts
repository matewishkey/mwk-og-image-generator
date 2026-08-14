import type { ProjectRow, ShotRow, StyleRow } from './runs';

export interface ProjectBundle {
  project: ProjectRow & { description: string; brand_kit_id: string };
  style: StyleRow;
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

  const [style, shots] = await Promise.all([
    env.DB.prepare(`SELECT * FROM style WHERE id = ?1`)
      .bind(project.default_style_id)
      .first<StyleRow>(),
    env.DB.prepare(
      `SELECT id, position, label, prompt, picked_take_id
         FROM shot WHERE project_id = ?1 AND deleted_at IS NULL ORDER BY position`,
    )
      .bind(project.id)
      .all<ProjectBundle['shots'][number]>(),
  ]);
  if (!style) return null;
  return { project, style, shots: shots.results };
}
