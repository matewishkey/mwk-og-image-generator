/** Project creation, shared by the new-project page and the JSON API. */

import { MODELS } from '../../../src/models.ts';
import { slugify } from '../../../src/style.ts';
import { ulid } from './ulid';

export interface CreateProjectOpts {
  teamId: string;
  userId: string;
  name: string;
  description?: string;
  /** Style id or slug, resolved against team-or-house styles (team wins). */
  style: string;
  /**
   * The full style SET (ids/slugs) for multi-style runs; the first entry is the
   * primary. Absent = [style]. When present, `style` is ignored.
   */
  styles?: string[];
  /** Brand kit id or slug; omitted = the team's kit, falling back to house. */
  brandKit?: string;
  models: string[];
  iterations?: number;
  /** Lift the no-text frame rule for every shot (comics, screens-in-scene). */
  allowText?: boolean;
}

export type CreateProjectResult = { slug: string } | { error: string; status: number };

export async function createProject(env: Env, o: CreateProjectOpts): Promise<CreateProjectResult> {
  const name = o.name.trim();
  if (!name) return { error: 'A project needs a name.', status: 400 };

  const imageAliases = new Set(MODELS.filter((m) => m.modality === 'image').map((m) => m.alias));
  if (!o.models.length) return { error: 'Pick at least one model.', status: 400 };
  const unknown = o.models.filter((m) => !imageAliases.has(m));
  if (unknown.length) return { error: `Unknown model(s): ${unknown.join(', ')}`, status: 400 };
  const iterations = Math.max(1, Math.min(8, Math.round(o.iterations ?? 1)));

  const wanted = o.styles?.length ? o.styles : [o.style];
  const styleIds: string[] = [];
  for (const ref of wanted) {
    const row = await env.DB.prepare(
      `SELECT s.id FROM style s JOIN team t ON t.id = s.team_id
        WHERE (s.team_id = ?1 OR t.kind = 'house') AND s.archived_at IS NULL
          AND (s.id = ?2 OR s.slug = ?2)
        ORDER BY t.kind DESC LIMIT 1`,
    )
      .bind(o.teamId, ref)
      .first<{ id: string }>();
    if (!row) return { error: `No style "${ref}".`, status: 400 };
    if (!styleIds.includes(row.id)) styleIds.push(row.id);
  }
  const style = { id: styleIds[0]! };

  const kit = o.brandKit
    ? await env.DB.prepare(
        `SELECT b.id, b.default_title, b.default_tagline FROM brand_kit b
           JOIN team t ON t.id = b.team_id
          WHERE (b.team_id = ?1 OR t.kind = 'house') AND b.archived_at IS NULL
            AND (b.id = ?2 OR b.slug = ?2)
          ORDER BY t.kind DESC LIMIT 1`,
      )
        .bind(o.teamId, o.brandKit)
        .first<{ id: string; default_title: string | null; default_tagline: string | null }>()
    : await env.DB.prepare(
        `SELECT b.id, b.default_title, b.default_tagline FROM brand_kit b
           JOIN team t ON t.id = b.team_id
          WHERE (b.team_id = ?1 OR t.kind = 'house') AND b.archived_at IS NULL
          ORDER BY t.kind DESC LIMIT 1`,
      )
        .bind(o.teamId)
        .first<{ id: string; default_title: string | null; default_tagline: string | null }>();
  if (!kit) return { error: o.brandKit ? `No brand kit "${o.brandKit}".` : 'No brand kit available.', status: 400 };

  const slug = slugify(name) || ulid().toLowerCase();
  const now = new Date().toISOString();
  const projectId = ulid();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO project (id, team_id, slug, name, description, default_style_id,
           brand_kit_id, models, iterations, allow_text, title, tagline,
           created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?14, ?10, ?11, ?12, ?13, ?13)`,
      ).bind(
        projectId,
        o.teamId,
        slug,
        name,
        (o.description ?? '').trim(),
        style.id,
        kit.id,
        JSON.stringify(o.models),
        iterations,
        kit.default_title,
        kit.default_tagline,
        o.userId,
        now,
        o.allowText ? 1 : 0,
      ),
      ...styleIds.map((id, i) =>
        env.DB.prepare(
          `INSERT INTO project_style (project_id, style_id, position) VALUES (?1, ?2, ?3)`,
        ).bind(projectId, id, i + 1),
      ),
    ]);
    return { slug };
  } catch (e) {
    return /UNIQUE/.test((e as Error).message)
      ? { error: `A project named "${slug}" already exists.`, status: 409 }
      : { error: (e as Error).message, status: 500 };
  }
}

export interface UpdateProjectPatch {
  name?: string;
  description?: string;
  /** Full style set (ids/slugs); first = primary. */
  styles?: string[];
  /** Brand kit id or slug (team or house). */
  brandKit?: string;
  models?: string[];
  iterations?: number;
  allowText?: boolean;
  extra?: string | null;
  title?: string | null;
  kicker?: string | null;
  tagline?: string | null;
}

/**
 * Partial project-settings update, shared by the settings page, the JSON API
 * and the CLI. Only the fields present in the patch change; styles replace
 * the whole set. Never touches what has already run.
 */
export async function updateProject(
  env: Env,
  teamId: string,
  projectId: string,
  patch: UpdateProjectPatch,
): Promise<{ ok: true } | { error: string; status: number }> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const put = (sql: string, v: unknown) => {
    sets.push(`${sql} = ?${binds.length + 1}`);
    binds.push(v);
  };

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) return { error: 'A project needs a name.', status: 400 };
    put('name', name);
  }
  if (patch.description !== undefined) put('description', patch.description.trim());
  if (patch.models !== undefined) {
    const imageAliases = new Set(MODELS.filter((m) => m.modality === 'image').map((m) => m.alias));
    if (!patch.models.length) return { error: 'Pick at least one model.', status: 400 };
    const unknown = patch.models.filter((m) => !imageAliases.has(m));
    if (unknown.length) return { error: `Unknown model(s): ${unknown.join(', ')}`, status: 400 };
    put('models', JSON.stringify(patch.models));
  }
  if (patch.iterations !== undefined)
    put('iterations', Math.max(1, Math.min(8, Math.round(patch.iterations))));
  if (patch.allowText !== undefined) put('allow_text', patch.allowText ? 1 : 0);
  if (patch.extra !== undefined) put('extra', patch.extra?.trim() || null);
  if (patch.title !== undefined) put('title', patch.title?.trim() || null);
  if (patch.kicker !== undefined) put('kicker', patch.kicker?.trim() || null);
  if (patch.tagline !== undefined) put('tagline', patch.tagline?.trim() || null);

  if (patch.brandKit !== undefined) {
    const kit = await env.DB.prepare(
      `SELECT b.id FROM brand_kit b JOIN team t ON t.id = b.team_id
        WHERE (b.team_id = ?1 OR t.kind = 'house') AND b.archived_at IS NULL
          AND (b.id = ?2 OR b.slug = ?2)
        ORDER BY t.kind DESC LIMIT 1`,
    )
      .bind(teamId, patch.brandKit)
      .first<{ id: string }>();
    if (!kit) return { error: `No brand kit "${patch.brandKit}".`, status: 400 };
    put('brand_kit_id', kit.id);
  }

  let styleIds: string[] | undefined;
  if (patch.styles !== undefined) {
    if (!patch.styles.length) return { error: 'Pick at least one style.', status: 400 };
    styleIds = [];
    for (const ref of patch.styles) {
      const row = await env.DB.prepare(
        `SELECT s.id FROM style s JOIN team t ON t.id = s.team_id
          WHERE (s.team_id = ?1 OR t.kind = 'house') AND s.archived_at IS NULL
            AND (s.id = ?2 OR s.slug = ?2)
          ORDER BY t.kind DESC LIMIT 1`,
      )
        .bind(teamId, ref)
        .first<{ id: string }>();
      if (!row) return { error: `No style "${ref}".`, status: 400 };
      if (!styleIds.includes(row.id)) styleIds.push(row.id);
    }
    put('default_style_id', styleIds[0]!);
  }

  if (!sets.length && !styleIds) return { ok: true };
  binds.push(new Date().toISOString(), projectId, teamId);
  const stmts = [
    env.DB.prepare(
      `UPDATE project SET ${sets.join(', ')}${sets.length ? ',' : ''}
         version = version + 1, updated_at = ?${binds.length - 2}
       WHERE id = ?${binds.length - 1} AND team_id = ?${binds.length}`,
    ).bind(...binds),
  ];
  if (styleIds) {
    stmts.push(env.DB.prepare(`DELETE FROM project_style WHERE project_id = ?1`).bind(projectId));
    stmts.push(
      ...styleIds.map((id, i) =>
        env.DB.prepare(
          `INSERT INTO project_style (project_id, style_id, position) VALUES (?1, ?2, ?3)`,
        ).bind(projectId, id, i + 1),
      ),
    );
  }
  await env.DB.batch(stmts);
  return { ok: true };
}
