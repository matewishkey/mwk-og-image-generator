/**
 * The pack: everything a downstream tool (or person) needs to understand the
 * concept, behind one unguessable token. Public by design, read-only by shape.
 */

export interface PackData {
  project: { name: string; description: string; slug: string };
  brand: { title: string | null; kicker: string | null; tagline: string | null };
  style: { name: string; description: string; look: string; subject: string; avoid: string; tags: string[] };
  refRole: string | null;
  references: { url: string; filename: string; width: number | null; height: number | null }[];
  shots: {
    position: number;
    label: string | null;
    prompt: string;
    pick: { url: string; model: string; width: number | null; height: number | null } | null;
  }[];
  designs: {
    url: string;
    layout: string;
    format: string;
    width: number;
    height: number;
    title: string | null;
    kicker: string | null;
    tagline: string | null;
    collectionId: string | null;
    createdAt: string;
  }[];
}

export async function loadPack(env: Env, token: string): Promise<PackData | null> {
  const project = await env.DB.prepare(
    `SELECT p.id, p.team_id, p.slug, p.name, p.description, p.ref_role,
            p.title, p.kicker, p.tagline, p.default_style_id
       FROM project p WHERE p.pack_token = ?1 AND p.archived_at IS NULL`,
  )
    .bind(token)
    .first<{
      id: string; team_id: string; slug: string; name: string; description: string;
      ref_role: string | null; title: string | null; kicker: string | null;
      tagline: string | null; default_style_id: string;
    }>();
  if (!project) return null;

  const img = (key: string) => `${env.PUBLIC_ORIGIN}/pack/${token}/img/${key}`;

  const [style, refs, shots, designs] = await Promise.all([
    env.DB.prepare(`SELECT name, description, look, subject, avoid, tags FROM style WHERE id = ?1`)
      .bind(project.default_style_id)
      .first<{ name: string; description: string; look: string; subject: string; avoid: string; tags: string }>(),
    env.DB.prepare(
      `SELECT r.r2_key, r.filename, r.width, r.height FROM reference_use u
         JOIN reference r ON r.id = u.reference_id
        WHERE u.owner_type='project' AND u.owner_id=?1 ORDER BY u.position`,
    )
      .bind(project.id)
      .all<{ r2_key: string; filename: string; width: number | null; height: number | null }>(),
    env.DB.prepare(
      `SELECT sh.position, sh.label, sh.prompt, t.card_key, t.model_alias, t.width, t.height
         FROM shot sh LEFT JOIN take t ON t.id = sh.picked_take_id
        WHERE sh.project_id = ?1 AND sh.deleted_at IS NULL ORDER BY sh.position`,
    )
      .bind(project.id)
      .all<{
        position: number; label: string | null; prompt: string;
        card_key: string | null; model_alias: string | null;
        width: number | null; height: number | null;
      }>(),
    env.DB.prepare(
      `SELECT d.r2_key, d.width, d.height, d.title, d.kicker, d.tagline, d.collection_id,
              d.created_at, l.name AS layout_name, f.slug AS format_slug
         FROM design d JOIN layout l ON l.id = d.layout_id JOIN format f ON f.id = d.format_id
        WHERE d.project_id = ?1 AND d.superseded_by_id IS NULL ORDER BY d.created_at DESC`,
    )
      .bind(project.id)
      .all<{
        r2_key: string; width: number; height: number; title: string | null;
        kicker: string | null; tagline: string | null; collection_id: string | null;
        created_at: string; layout_name: string; format_slug: string;
      }>(),
  ]);
  if (!style) return null;

  return {
    project: { name: project.name, description: project.description, slug: project.slug },
    brand: { title: project.title, kicker: project.kicker, tagline: project.tagline },
    style: { ...style, tags: JSON.parse(style.tags) },
    refRole: project.ref_role,
    references: refs.results.map((r) => ({
      url: img(r.r2_key),
      filename: r.filename,
      width: r.width,
      height: r.height,
    })),
    shots: shots.results.map((s) => ({
      position: s.position,
      label: s.label,
      prompt: s.prompt,
      pick: s.card_key
        ? { url: img(s.card_key), model: s.model_alias!, width: s.width, height: s.height }
        : null,
    })),
    designs: designs.results.map((d) => ({
      url: img(d.r2_key),
      layout: d.layout_name,
      format: d.format_slug,
      width: d.width,
      height: d.height,
      title: d.title,
      kicker: d.kicker,
      tagline: d.tagline,
      collectionId: d.collection_id,
      createdAt: d.created_at,
    })),
  };
}

/** The team owning this pack token, for scoping image access. */
export async function packTeam(env: Env, token: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT team_id FROM project WHERE pack_token = ?1 AND archived_at IS NULL`,
  )
    .bind(token)
    .first<{ team_id: string }>();
  return row?.team_id ?? null;
}
