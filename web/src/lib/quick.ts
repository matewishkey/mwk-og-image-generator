/**
 * Quick card: one uploaded image -> branded OG card(s) from a template, no
 * shots, no runs, no styles. The upload fills EVERY slot (recast semantics —
 * predictable on multi-slot templates). Designs land in the hidden per-team
 * '_quick' project (the _style-proofs pattern: archived on purpose, so
 * storage, history and supersede semantics all hold with zero new machinery).
 */

import { LayoutConfigSchema, layoutPanels } from '../../../src/seam.ts';
import { createCollection, createDesign, type FormatRow, type PanelInput } from './design';
import { uploadReferences } from './media';
import { ulid } from './ulid';

export const QUICK_SLUG = '_quick';

export async function ensureQuickProject(
  env: Env,
  teamId: string,
  userId: string,
): Promise<{ id: string; brand_kit_id: string }> {
  const existing = await env.DB.prepare(
    `SELECT id, brand_kit_id FROM project WHERE team_id = ?1 AND slug = ?2`,
  )
    .bind(teamId, QUICK_SLUG)
    .first<{ id: string; brand_kit_id: string }>();
  if (existing) return existing;

  const now = new Date().toISOString();
  const id = ulid();
  const anyStyle = await env.DB.prepare(
    `SELECT s.id FROM style s JOIN team t ON t.id = s.team_id WHERE t.kind='house' LIMIT 1`,
  ).first<{ id: string }>();
  const kit = await env.DB.prepare(
    `SELECT b.id FROM brand_kit b JOIN team t ON t.id = b.team_id WHERE t.kind='house' LIMIT 1`,
  ).first<{ id: string }>();
  if (!anyStyle || !kit) throw new Error('house style or brand kit missing');
  // archived_at set: hidden from every listing, but designs against it work normally.
  await env.DB.prepare(
    `INSERT INTO project (id, team_id, slug, name, description, default_style_id,
       brand_kit_id, models, iterations, allow_text, created_by, created_at, updated_at, archived_at)
     VALUES (?1, ?2, ?3, 'Quick cards', 'Internal: uploaded images turned into branded cards.',
             ?4, ?5, '[]', 1, 0, ?6, ?7, ?7, ?7)`,
  )
    .bind(id, teamId, QUICK_SLUG, anyStyle.id, kit.id, userId, now)
    .run();
  return { id, brand_kit_id: kit.id };
}

export interface QuickCardOpts {
  /** An existing library reference… */
  referenceId?: string;
  /** …or fresh bytes (stored to the media library first, deduplicated). */
  files?: File[];
  /** Template: layout id or slug (team or house, non-archived). */
  template: string;
  title?: string;
  kicker?: string;
  tagline?: string;
  theme?: 'light' | 'dark';
  /** Format ids or slugs; default the OG card. */
  formatIds?: string[];
  /** Brand kit id or name; default the quick project's stored kit. */
  brandKitId?: string;
}

export interface QuickCardResult {
  designs: { id: string; url: string; format: string }[];
  referenceId: string;
}

export async function quickCard(
  env: Env,
  teamId: string,
  userId: string,
  o: QuickCardOpts,
): Promise<QuickCardResult> {
  const project = await ensureQuickProject(env, teamId, userId);

  // 1. The picture.
  let referenceId = o.referenceId;
  if (!referenceId) {
    if (!o.files?.length) throw new Error('send an image (or a referenceId from the media library)');
    const up = await uploadReferences(env, teamId, o.files);
    if (!up.ids.length) throw new Error(up.errors.join('; ') || 'the upload failed');
    referenceId = up.ids[0]!;
  }
  const ref = await env.DB.prepare(
    `SELECT id, r2_key, filename, name FROM reference WHERE id = ?1 AND team_id = ?2 AND deleted_at IS NULL`,
  )
    .bind(referenceId, teamId)
    .first<{ id: string; r2_key: string; filename: string; name: string | null }>();
  if (!ref) throw new Error('no such reference in this team’s library');

  // 2. The template.
  const layout = await env.DB.prepare(
    `SELECT l.id, l.config FROM layout l JOIN team t ON t.id = l.team_id
      WHERE (l.id = ?2 OR l.slug = ?2) AND (l.team_id = ?1 OR t.kind = 'house') AND l.archived_at IS NULL
      LIMIT 1`,
  )
    .bind(teamId, o.template)
    .first<{ id: string; config: string }>();
  if (!layout) throw new Error(`no template "${o.template}"`);
  const cfg = LayoutConfigSchema.parse(JSON.parse(layout.config));
  const need = Math.max(1, layoutPanels(cfg));

  // 3. The upload fills every slot (cell order — replay-shaped, so preselected).
  const panel: PanelInput = {
    referenceId: ref.id,
    artKey: ref.r2_key,
    label: ref.name ?? ref.filename.replace(/\.[a-z0-9]+$/i, ''),
  };
  const panels = Array.from({ length: need }, () => panel);

  // 4. Formats.
  const wanted = o.formatIds?.length ? o.formatIds : ['og'];
  const formats = (
    await env.DB.prepare(`SELECT id, slug, name, width, height FROM format ORDER BY rowid`).all<
      FormatRow & { name: string }
    >()
  ).results.filter((f) => wanted.includes(f.id) || wanted.includes(f.slug));
  if (!formats.length) throw new Error('no known format in formatIds');

  const kitId = o.brandKitId ?? project.brand_kit_id;
  const base = {
    teamId,
    userId,
    projectId: project.id,
    layoutId: layout.id,
    brandKitId: kitId,
    title: o.title?.trim() || undefined,
    kicker: o.kicker?.trim() || undefined,
    tagline: o.tagline?.trim() || undefined,
    theme: o.theme,
    panels,
    preselected: true,
  };

  const designs: QuickCardResult['designs'] = [];
  if (formats.length === 1) {
    const id = await createDesign(env, { ...base, formatId: formats[0]!.id });
    designs.push({ id, url: `/img/teams/${teamId}/designs/${id}.png`, format: formats[0]!.slug });
  } else {
    const collectionId = ulid();
    await env.DB.prepare(
      `INSERT INTO collection (id, team_id, project_id, name, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(collectionId, teamId, project.id, null, userId, new Date().toISOString())
      .run();
    await createCollection(env, { ...base, collectionId, formats });
    const rows = await env.DB.prepare(
      `SELECT d.id, d.r2_key, f.slug FROM design d JOIN format f ON f.id = d.format_id
        WHERE d.collection_id = ?1 ORDER BY f.rowid`,
    )
      .bind(collectionId)
      .all<{ id: string; r2_key: string; slug: string }>();
    for (const r of rows.results) designs.push({ id: r.id, url: `/img/${r.r2_key}`, format: r.slug });
  }
  return { designs, referenceId: ref.id };
}
