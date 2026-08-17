/**
 * Every design-page action as a plain function — the page's POST handler and
 * /api/projects/[slug]/designs are both thin wrappers over these, so the
 * browser flow and the CLI can never drift (the takesPayload principle).
 *
 * Panels come from resolvePanelTakes: the pick when one exists, else the
 * newest succeeded take — so designs and previews can be made as soon as
 * drafts exist, before anything is picked.
 */

import { layoutPanels, LayoutConfigSchema, type LayoutConfig } from '../../../src/seam.ts';
import { isEffect } from '../../../src/effects.ts';
import { slugify } from '../../../src/style.ts';
import { createCollection, createDesign, type FormatRow } from './design';
import { generateLayouts } from './generate';
import { resolvePanelTakes, scopeInventory } from './previews';
import { ulid } from './ulid';

export interface DesignCtx {
  teamId: string;
  userId: string;
  project: {
    id: string;
    slug: string;
    brand_kit_id: string;
    title: string | null;
    kicker: string | null;
    tagline: string | null;
  };
}

export interface DesignPanel {
  takeId: string;
  artKey: string;
  label?: string;
}

/** The project's current panel inventory, in shot order. Hidden shots are
 *  EXCLUDED here — this compact list feeds archetype layouts and the
 *  generate brief, which take the first N. */
export async function projectPanels(env: Env, projectId: string): Promise<DesignPanel[]> {
  const takes = await resolvePanelTakes(env, projectId);
  return takes.filter((t) => !t.hidden && t.take_id && t.art_key).map((t) => ({
    takeId: t.take_id!,
    artKey: t.art_key!,
    label: t.label ?? undefined,
  }));
}

/** The slot-stable inventory for a specific layout: hidden shots stay as null
 *  slots so cell.panel indexes never shift, an optional style narrows takes,
 *  and an optional shot leads the order for templates without explicit refs. */
export async function scopedProjectPanels(
  env: Env,
  projectId: string,
  cfg: LayoutConfig,
  scope: { styleId?: string; shotPosition?: number } = {},
): Promise<(DesignPanel | null)[]> {
  const takes = await resolvePanelTakes(env, projectId, scope.styleId);
  return scopeInventory(cfg, takes, scope.shotPosition).map((t) =>
    t && t.take_id && t.art_key ? { takeId: t.take_id, artKey: t.art_key, label: t.label ?? undefined } : null,
  );
}

async function layoutConfigOf(env: Env, layoutId: string): Promise<LayoutConfig> {
  const row = await env.DB.prepare(`SELECT config FROM layout WHERE id = ?1`)
    .bind(layoutId)
    .first<{ config: string }>();
  if (!row) throw new Error('no such layout');
  return LayoutConfigSchema.parse(JSON.parse(row.config));
}

export interface RenderWords {
  title?: string;
  kicker?: string;
  tagline?: string;
}

export interface RenderFromLayoutOpts extends RenderWords {
  layoutId: string;
  formats: FormatRow[];
  themes?: ('light' | 'dark')[];
  effect?: string;
  /** Narrow the panel inventory to one style's takes. */
  styleId?: string;
  /** Lead the inventory with this shot (templates without explicit refs). */
  shotPosition?: number;
}

/**
 * Layout + words + formats -> designs (a collection per theme when several
 * formats are asked for). Returns the first single-format design id for
 * ?lead=, or '' when everything went through collections.
 */
export async function renderFromLayout(
  env: Env,
  ctx: DesignCtx,
  o: RenderFromLayoutOpts,
): Promise<string> {
  if (!o.formats.length) throw new Error('Pick at least one format.');
  const themes = o.themes?.length ? o.themes : (['light'] as const);
  const cfg = await layoutConfigOf(env, o.layoutId);
  const panels = await scopedProjectPanels(env, ctx.project.id, cfg, {
    styleId: o.styleId,
    shotPosition: o.shotPosition,
  });
  if (!panels.some(Boolean)) throw new Error('No usable takes yet — run the shots first.');

  const base = {
    teamId: ctx.teamId,
    userId: ctx.userId,
    projectId: ctx.project.id,
    layoutId: o.layoutId,
    brandKitId: ctx.project.brand_kit_id,
    effect: o.effect && isEffect(o.effect) ? o.effect : undefined,
    title: o.title?.trim() || undefined,
    kicker: o.kicker?.trim() || undefined,
    tagline: o.tagline?.trim() || undefined,
    panels,
  };
  let first: string | undefined;
  for (const theme of themes) {
    if (o.formats.length > 1) {
      const collectionId = ulid();
      await env.DB.prepare(
        `INSERT INTO collection (id, team_id, project_id, name, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
        .bind(collectionId, ctx.teamId, ctx.project.id, null, ctx.userId, new Date().toISOString())
        .run();
      await createCollection(env, { ...base, theme, collectionId, formats: o.formats });
    } else {
      const id = await createDesign(env, { ...base, theme, formatId: o.formats[0]!.id });
      first ??= id;
    }
  }
  return first ?? '';
}

/** Promote one design to every format — same layout, same words, one collection. */
export async function renderAllFormats(
  env: Env,
  ctx: DesignCtx,
  designId: string,
  formats: FormatRow[],
): Promise<void> {
  const src = await env.DB.prepare(
    `SELECT layout_id, title, kicker, tagline, theme, effect FROM design
      WHERE id = ?1 AND team_id = ?2 AND project_id = ?3`,
  )
    .bind(designId, ctx.teamId, ctx.project.id)
    .first<{ layout_id: string; title: string | null; kicker: string | null;
             tagline: string | null; theme: string; effect: string | null }>();
  if (!src) throw new Error('no such design');
  const panels = await scopedProjectPanels(env, ctx.project.id, await layoutConfigOf(env, src.layout_id));
  const collectionId = ulid();
  await env.DB.prepare(
    `INSERT INTO collection (id, team_id, project_id, name, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(collectionId, ctx.teamId, ctx.project.id, null, ctx.userId, new Date().toISOString())
    .run();
  await createCollection(env, {
    teamId: ctx.teamId,
    userId: ctx.userId,
    projectId: ctx.project.id,
    layoutId: src.layout_id,
    brandKitId: ctx.project.brand_kit_id,
    title: src.title ?? undefined,
    kicker: src.kicker ?? undefined,
    tagline: src.tagline ?? undefined,
    theme: src.theme === 'dark' ? 'dark' : 'light',
    effect: src.effect ?? undefined,
    collectionId,
    formats,
    panels,
  });
}

export interface GenerateOpts {
  format: FormatRow & { name: string; safe_w?: number | null; safe_h?: number | null };
  brief: string;
  n: number;
  kitConfig?: string;
}

/** Model-proposed layouts: persist each config, then render ~4 wide. */
export async function generateAndRender(
  env: Env,
  ctx: DesignCtx,
  o: GenerateOpts,
): Promise<{ rendered: number; dropped: number }> {
  const panels = await projectPanels(env, ctx.project.id);
  if (!panels.length) throw new Error('No usable takes yet — run the shots first.');
  const takes = await resolvePanelTakes(env, ctx.project.id);
  const bandFrac = (() => {
    try {
      const c = JSON.parse(o.kitConfig ?? '') as { band?: { height?: number }; canvas?: { height?: number } };
      return c.band?.height && c.canvas?.height ? c.band.height / c.canvas.height : undefined;
    } catch {
      return undefined;
    }
  })();
  const { layouts: generated, dropped } = await generateLayouts(
    env,
    {
      panels: takes.map((t) => ({ label: t.label ?? `shot ${t.position}`, width: t.width, height: t.height })),
      format: {
        name: o.format.name,
        width: o.format.width,
        height: o.format.height,
        safe_w: o.format.safe_w ?? null,
        safe_h: o.format.safe_h ?? null,
      },
      palette: (() => {
        try {
          return (JSON.parse(o.kitConfig ?? '{}') as { colors?: Record<string, string> }).colors;
        } catch {
          return undefined;
        }
      })(),
      bandFrac,
    },
    o.brief,
    o.n,
  );
  const nowIso = new Date().toISOString();
  const inserted: string[] = [];
  for (const g of generated) {
    const layoutId = ulid();
    await env.DB.prepare(
      `INSERT INTO layout (id, team_id, slug, name, config, brief, generated_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'openai/gpt-5.6-terra', ?7, ?7)`,
    )
      .bind(layoutId, ctx.teamId, `gen-${layoutId.slice(-8).toLowerCase()}`, g.name,
            JSON.stringify(g.config), o.brief || null, nowIso)
      .run();
    inserted.push(layoutId);
  }
  let rendered = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, inserted.length) }, async () => {
      while (next < inserted.length) {
        const layoutId = inserted[next++]!;
        try {
          await createDesign(env, {
            teamId: ctx.teamId,
            userId: ctx.userId,
            projectId: ctx.project.id,
            layoutId,
            formatId: o.format.id,
            brandKitId: ctx.project.brand_kit_id,
            title: ctx.project.title ?? undefined,
            kicker: ctx.project.kicker ?? undefined,
            tagline: ctx.project.tagline ?? undefined,
            panels,
          });
          rendered++;
        } catch {
          /* a config the renderer rejects is dropped, not shown */
        }
      }
    }),
  );
  return { rendered, dropped: dropped + (generated.length - rendered) };
}

/** Name a generated layout so it reads like a template. House layouts refuse. */
export async function saveTemplate(
  env: Env,
  ctx: DesignCtx,
  designId: string,
  name: string,
): Promise<void> {
  if (!name.trim()) throw new Error('A template needs a name.');
  const src = await env.DB.prepare(
    `SELECT layout_id FROM design WHERE id = ?1 AND team_id = ?2 AND project_id = ?3`,
  )
    .bind(designId, ctx.teamId, ctx.project.id)
    .first<{ layout_id: string }>();
  if (!src) throw new Error('no such design');
  const r = await env.DB.prepare(
    `UPDATE layout SET name = ?1, slug = ?2, updated_at = ?3 WHERE id = ?4 AND team_id = ?5`,
  )
    .bind(name.trim(), slugify(name) || `tpl-${src.layout_id.slice(-8).toLowerCase()}`,
          new Date().toISOString(), src.layout_id, ctx.teamId)
    .run();
  if (r.meta.changes === 0) throw new Error('Only generated (team) layouts can be saved as templates.');
}

export interface AuthorOpts extends RenderWords {
  config: unknown;
  name?: string;
  formatId?: string;
}

/** Hand-authored config -> validated NEW layout row -> rendered design. */
export async function authorTemplate(
  env: Env,
  ctx: DesignCtx,
  o: AuthorOpts,
): Promise<{ designId: string; layoutId: string }> {
  const parsed = LayoutConfigSchema.safeParse(o.config);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; '),
    );
  const panels = await projectPanels(env, ctx.project.id);
  const needs = layoutPanels(parsed.data);
  if (needs > panels.length)
    throw new Error(`this template needs ${needs} images; the project has ${panels.length}`);
  const name = o.name?.trim() || 'Hand-authored';
  const layoutId = ulid();
  await env.DB.prepare(
    `INSERT INTO layout (id, team_id, slug, name, config, generated_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'hand', ?6, ?6)`,
  )
    .bind(layoutId, ctx.teamId, `${slugify(name) || 'tpl'}-${layoutId.slice(-6).toLowerCase()}`,
          name, JSON.stringify(parsed.data), new Date().toISOString())
    .run();
  const designId = await createDesign(env, {
    teamId: ctx.teamId,
    userId: ctx.userId,
    projectId: ctx.project.id,
    layoutId,
    formatId: o.formatId ?? 'fmt_og',
    brandKitId: ctx.project.brand_kit_id,
    title: o.title ?? ctx.project.title ?? undefined,
    kicker: o.kicker ?? ctx.project.kicker ?? undefined,
    tagline: o.tagline ?? ctx.project.tagline ?? undefined,
    panels,
  });
  return { designId, layoutId };
}

/** One unguessable pack token per project; creating it twice keeps the first. */
export async function ensurePackLink(env: Env, projectId: string): Promise<void> {
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  await env.DB.prepare(`UPDATE project SET pack_token = coalesce(pack_token, ?1) WHERE id = ?2`)
    .bind(token, projectId)
    .run();
}
