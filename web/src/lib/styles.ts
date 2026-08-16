/** The styles visible to a team: its own plus house, team first. One query,
 *  previously copy-pasted across six pages (round-3 consolidation). */

export interface StyleListRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  team_kind: string;
}

export async function listStyles(env: Env, teamId: string): Promise<StyleListRow[]> {
  const rows = await env.DB.prepare(
    `SELECT s.id, s.slug, s.name, s.description, t.kind AS team_kind
       FROM style s JOIN team t ON t.id = s.team_id
      WHERE (s.team_id = ?1 OR t.kind = 'house') AND s.archived_at IS NULL
      ORDER BY t.kind DESC, s.name`,
  )
    .bind(teamId)
    .all<StyleListRow>();
  return rows.results;
}
