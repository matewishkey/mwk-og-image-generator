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
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12, ?13, ?13)`,
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
