/**
 * Every design-page action as a plain function — the page's POST handler and
 * /api/projects/[slug]/designs are both thin wrappers over these, so the
 * browser flow and the CLI can never drift (the takesPayload principle).
 *
 * Panels come from resolvePanelTakes: the pick when one exists, else the
 * newest succeeded take — so designs and previews can be made as soon as
 * drafts exist, before anything is picked.
 */

import { hasExplicitPanels, layoutPanels, LayoutConfigSchema, type LayoutConfig } from '../../../src/seam.ts';
import { isEffect } from '../../../src/effects.ts';
import { slugify } from '../../../src/style.ts';
import { createCollection, createDesign, type FormatRow, type PanelInput } from './design';
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

/**
 * A design's OWN slot assignments, replayed from its design_panel rows —
 * position-ordered, one entry per cell, exactly what the renderer received.
 * Takes and references are immutable, so this reconstructs any design
 * byte-for-byte. Feed the result to createDesign with `preselected: true`.
 */
export async function panelsFromDesign(env: Env, designId: string): Promise<PanelInput[]> {
  const rows = await env.DB.prepare(
    `SELECT p.label, p.take_id, p.reference_id, coalesce(t.art_key, r.r2_key) AS art_key
       FROM design_panel p
       LEFT JOIN take t ON t.id = p.take_id
       LEFT JOIN reference r ON r.id = p.reference_id
      WHERE p.design_id = ?1
      ORDER BY p.position`,
  )
    .bind(designId)
    .all<{ label: string | null; take_id: string | null; reference_id: string | null; art_key: string | null }>();
  return rows.results
    .filter((r) => r.art_key)
    .map((r) => ({
      takeId: r.take_id ?? undefined,
      referenceId: r.reference_id ?? undefined,
      artKey: r.art_key!,
      label: r.label ?? undefined,
    }));
}

export interface RerenderOverrides {
  /** Full replacement slot list (cell order) — setPanel builds this. */
  panels?: PanelInput[];
  title?: string;
  kicker?: string;
  tagline?: string;
  theme?: 'light' | 'dark';
  formatId?: string;
}

/**
 * THE replay path: re-render a design from its own stored slots and words,
 * with optional overrides. Identical replay supersedes the source (same
 * supersede tuple); any override lands as a coexisting revision.
 */
export async function rerenderDesign(
  env: Env,
  ctx: DesignCtx,
  o: { designId: string; overrides?: RerenderOverrides },
): Promise<string> {
  const src = await env.DB.prepare(
    `SELECT layout_id, format_id, theme, effect, title, kicker, tagline FROM design
      WHERE id = ?1 AND team_id = ?2 AND project_id = ?3`,
  )
    .bind(o.designId, ctx.teamId, ctx.project.id)
    .first<{ layout_id: string; format_id: string; theme: string; effect: string | null;
             title: string | null; kicker: string | null; tagline: string | null }>();
  if (!src) throw new Error('no such design');
  const ov = o.overrides ?? {};
  const panels = ov.panels ?? (await panelsFromDesign(env, o.designId));
  if (!panels.length) throw new Error('this design has no stored slot assignments to replay');
  return createDesign(env, {
    teamId: ctx.teamId,
    userId: ctx.userId,
    projectId: ctx.project.id,
    layoutId: src.layout_id,
    formatId: ov.formatId ?? src.format_id,
    brandKitId: ctx.project.brand_kit_id,
    title: ov.title !== undefined ? ov.title.trim() || undefined : src.title ?? undefined,
    kicker: ov.kicker !== undefined ? ov.kicker.trim() || undefined : src.kicker ?? undefined,
    tagline: ov.tagline !== undefined ? ov.tagline.trim() || undefined : src.tagline ?? undefined,
    theme: ov.theme ?? (src.theme === 'dark' ? 'dark' : 'light'),
    effect: src.effect ?? undefined,
    panels,
    preselected: true,
  });
}

/** Swap ONE slot's picture for another take; every other slot replays as-is. */
export async function setPanel(
  env: Env,
  ctx: DesignCtx,
  o: { designId: string; position: number; takeId: string },
): Promise<string> {
  const take = await env.DB.prepare(
    `SELECT t.id, t.art_key, sh.label FROM take t JOIN shot sh ON sh.id = t.shot_id
      WHERE t.id = ?1 AND sh.project_id = ?2 AND t.status = 'succeeded' AND t.art_key IS NOT NULL`,
  )
    .bind(o.takeId, ctx.project.id)
    .first<{ id: string; art_key: string; label: string | null }>();
  if (!take) throw new Error('that take is not usable (missing, failed, or another project)');
  const panels = await panelsFromDesign(env, o.designId);
  if (o.position < 1 || o.position > panels.length)
    throw new Error(`slot ${o.position} does not exist — this design has ${panels.length}`);
  panels[o.position - 1] = { takeId: take.id, artKey: take.art_key, label: take.label ?? undefined };
  return rerenderDesign(env, ctx, { designId: o.designId, overrides: { panels } });
}

/**
 * Round 8c: assembly from an explicit picture list — the compose path. The
 * caller names the takes IN ORDER (tap order = panel order); nothing is
 * resolved from picks. Templates that pin their own shots (hasExplicitPanels)
 * are refused: pouring a hand-ordered list into them would silently re-cast —
 * that deliberate act stays recastDesign's job.
 */
export async function renderFromPicks(
  env: Env,
  ctx: DesignCtx,
  o: { layoutId: string; takeIds: string[]; format: FormatRow; theme?: 'light' | 'dark' } & RenderWords,
): Promise<string> {
  if (!o.takeIds.length) throw new Error('name at least one take');
  const cfg = await layoutConfigOf(env, o.layoutId);
  if (hasExplicitPanels(cfg))
    throw new Error('this template chooses its own shots — compose cannot re-cast it');
  const needs = layoutPanels(cfg);
  if (needs !== o.takeIds.length)
    throw new Error(`this template takes exactly ${needs} picture${needs === 1 ? '' : 's'}, you named ${o.takeIds.length}`);

  const marks = o.takeIds.map((_, i) => `?${i + 2}`).join(',');
  const rows = await env.DB.prepare(
    `SELECT t.id, t.art_key, sh.label FROM take t JOIN shot sh ON sh.id = t.shot_id
      WHERE sh.project_id = ?1 AND t.status = 'succeeded' AND t.art_key IS NOT NULL
        AND t.id IN (${marks})`,
  )
    .bind(ctx.project.id, ...o.takeIds)
    .all<{ id: string; art_key: string; label: string | null }>();
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  const panels: PanelInput[] = o.takeIds.map((id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`take ${id} is not usable (missing, failed, or another project)`);
    return { takeId: r.id, artKey: r.art_key, label: r.label ?? undefined };
  });

  return createDesign(env, {
    teamId: ctx.teamId,
    userId: ctx.userId,
    projectId: ctx.project.id,
    layoutId: o.layoutId,
    brandKitId: ctx.project.brand_kit_id,
    formatId: o.format.id,
    theme: o.theme ?? 'light',
    title: o.title?.trim() || undefined,
    kicker: o.kicker?.trim() || undefined,
    tagline: o.tagline?.trim() || undefined,
    panels,
    preselected: true, // panels ARE the cell order — the sanctioned replay shape
  });
}

/**
 * Compose: render EVERY count-matching template (house + named team, never
 * pinned ones) with the named takes. Renderer rejects are skipped, like
 * generateAndRender. Returns what rendered, for the results?ids= link.
 */
export async function composeFromTakes(
  env: Env,
  ctx: DesignCtx,
  o: { takeIds: string[]; format: FormatRow; theme?: 'light' | 'dark' } & RenderWords,
): Promise<{ designId: string; layoutId: string; layoutName: string }[]> {
  const layouts = await env.DB.prepare(
    `SELECT l.id, l.name, l.config FROM layout l JOIN team t ON t.id = l.team_id
      WHERE (l.team_id = ?1 OR t.kind = 'house') AND l.archived_at IS NULL
        AND (t.kind = 'house' OR l.slug NOT LIKE 'gen-%')
      ORDER BY l.name`,
  )
    .bind(ctx.teamId)
    .all<{ id: string; name: string; config: string }>();

  const out: { designId: string; layoutId: string; layoutName: string }[] = [];
  for (const l of layouts.results) {
    let cfg: LayoutConfig;
    try {
      cfg = LayoutConfigSchema.parse(JSON.parse(l.config));
    } catch {
      continue;
    }
    if (hasExplicitPanels(cfg) || layoutPanels(cfg) !== o.takeIds.length) continue;
    try {
      const designId = await renderFromPicks(env, ctx, { ...o, layoutId: l.id });
      out.push({ designId, layoutId: l.id, layoutName: l.name });
    } catch (e) {
      console.error(`compose: ${l.name} skipped: ${(e as Error).message}`);
    }
  }
  if (!out.length)
    throw new Error(`no template takes exactly ${o.takeIds.length} picture${o.takeIds.length === 1 ? '' : 's'}`);
  return out;
}

/** Promote one design to every format — same layout, same words, and the
 *  design's OWN pictures (replayed, never re-resolved from current picks). */
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
  const panels = await panelsFromDesign(env, designId);
  if (!panels.length) throw new Error('this design has no stored slot assignments to replay');
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
    preselected: true,
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
  theme?: 'light' | 'dark';
  effect?: string;
  styleId?: string;
  shotPosition?: number;
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
  const panels = await scopedProjectPanels(env, ctx.project.id, parsed.data, {
    styleId: o.styleId,
    shotPosition: o.shotPosition,
  });
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
    theme: o.theme,
    effect: o.effect && isEffect(o.effect) ? o.effect : undefined,
    panels,
  });
  return { designId, layoutId };
}

/**
 * Same template, another picture: re-render a design with EVERY panel slot
 * fed by the chosen shot. This is the deliberate act the scope bar refuses to
 * do implicitly — explicit `panel` refs get re-cast here because the owner
 * asked for exactly that.
 */
export async function recastDesign(
  env: Env,
  ctx: DesignCtx,
  o: { designId: string; shotPosition: number },
): Promise<string> {
  const src = await env.DB.prepare(
    `SELECT layout_id, format_id, theme, effect, title, kicker, tagline FROM design
      WHERE id = ?1 AND team_id = ?2 AND project_id = ?3`,
  )
    .bind(o.designId, ctx.teamId, ctx.project.id)
    .first<{ layout_id: string; format_id: string; theme: string; effect: string | null;
             title: string | null; kicker: string | null; tagline: string | null }>();
  if (!src) throw new Error('no such design');
  const takes = await resolvePanelTakes(env, ctx.project.id);
  const chosen = takes.find((t) => t.position === o.shotPosition);
  if (!chosen || chosen.hidden || !chosen.take_id || !chosen.art_key)
    throw new Error('that shot has no usable take (or is hidden)');
  const panel = { takeId: chosen.take_id, artKey: chosen.art_key, label: chosen.label ?? undefined };
  return createDesign(env, {
    teamId: ctx.teamId,
    userId: ctx.userId,
    projectId: ctx.project.id,
    layoutId: src.layout_id,
    formatId: src.format_id,
    brandKitId: ctx.project.brand_kit_id,
    title: src.title ?? undefined,
    kicker: src.kicker ?? undefined,
    tagline: src.tagline ?? undefined,
    theme: src.theme === 'dark' ? 'dark' : 'light',
    effect: src.effect ?? undefined,
    // Every slot answers with the chosen shot, whatever index a cell asks for.
    panels: Array.from({ length: Math.max(takes.length, 31) }, () => panel),
  });
}

export interface ReviseOpts {
  designId: string;
  instruction: string;
}

/**
 * "Move the text left, my picture a bit right" — the owner talks, the model
 * revises the design's layout config, the renderer redraws it. The revised
 * config lands as a NEW layout row with the same name; the predecessor is
 * archived (team layouts only — house layouts are shared and stay), so the
 * page shows one card, and history keeps everything.
 */
export async function reviseDesign(
  env: Env,
  ctx: DesignCtx,
  o: ReviseOpts,
): Promise<string> {
  const instruction = o.instruction.trim();
  if (!instruction) throw new Error('Say what to change — e.g. "move the text left a little".');
  const src = await env.DB.prepare(
    `SELECT d.layout_id, d.format_id, d.theme, d.effect, d.title, d.kicker, d.tagline,
            l.name AS layout_name, l.config, l.team_id AS layout_team_id
       FROM design d JOIN layout l ON l.id = d.layout_id
      WHERE d.id = ?1 AND d.team_id = ?2 AND d.project_id = ?3`,
  )
    .bind(o.designId, ctx.teamId, ctx.project.id)
    .first<{ layout_id: string; format_id: string; theme: string; effect: string | null;
             title: string | null; kicker: string | null; tagline: string | null;
             layout_name: string; config: string; layout_team_id: string }>();
  if (!src) throw new Error('no such design');

  const [format, kit, takes] = await Promise.all([
    env.DB.prepare(`SELECT id, slug, name, width, height, safe_w, safe_h FROM format WHERE id = ?1`)
      .bind(src.format_id)
      .first<{ id: string; slug: string; name: string; width: number; height: number;
               safe_w: number | null; safe_h: number | null }>(),
    env.DB.prepare(`SELECT config FROM brand_kit WHERE id = ?1`)
      .bind(ctx.project.brand_kit_id)
      .first<{ config: string }>(),
    resolvePanelTakes(env, ctx.project.id),
  ]);
  if (!format) throw new Error('the design format is missing');
  const kitParsed = (() => {
    try {
      return JSON.parse(kit?.config ?? '{}') as {
        colors?: Record<string, string>;
        band?: { height?: number };
        canvas?: { height?: number };
      };
    } catch {
      return {};
    }
  })();

  const brief =
    `REVISE the following existing layout — do not invent a new arrangement. ` +
    `Change ONLY what the instruction asks for; keep every other property byte-identical. ` +
    `Keep the name exactly "${src.layout_name}".\n` +
    `Current config:\n${src.config}\n` +
    `The owner's instruction: "${instruction}"`;
  const { layouts: revised } = await generateLayouts(
    env,
    {
      panels: takes
        .filter((t) => !t.hidden && t.take_id)
        .map((t) => ({ label: t.label ?? `shot ${t.position}`, width: t.width, height: t.height })),
      format: {
        name: format.name,
        width: format.width,
        height: format.height,
        safe_w: format.safe_w,
        safe_h: format.safe_h,
      },
      palette: kitParsed.colors,
      bandFrac:
        kitParsed.band?.height && kitParsed.canvas?.height
          ? kitParsed.band.height / kitParsed.canvas.height
          : undefined,
    },
    brief,
    1,
  );
  const next = revised[0];
  if (!next) throw new Error('the model could not produce a valid revision — try wording the change differently');

  // Replay the source design's OWN pictures whenever the revised config still
  // has the same number of cells; only a cell-count change falls back to the
  // project's current resolution (there is no stored answer for a new slot).
  const srcPanels = await panelsFromDesign(env, o.designId);
  const sameCells = srcPanels.length > 0 && layoutPanels(next.config) === srcPanels.length;

  const nowIso = new Date().toISOString();
  const layoutId = ulid();
  const stmts = [
    env.DB.prepare(
      `INSERT INTO layout (id, team_id, slug, name, config, generated_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'revise', ?6, ?6)`,
    ).bind(layoutId, ctx.teamId, `rev-${layoutId.slice(-8).toLowerCase()}`,
           src.layout_name, JSON.stringify(next.config), nowIso),
  ];
  if (src.layout_team_id === ctx.teamId) {
    stmts.push(
      env.DB.prepare(`UPDATE layout SET archived_at = ?1, updated_at = ?1 WHERE id = ?2`)
        .bind(nowIso, src.layout_id),
    );
  }
  await env.DB.batch(stmts);

  const panels = sameCells ? srcPanels : await scopedProjectPanels(env, ctx.project.id, next.config);
  return createDesign(env, {
    teamId: ctx.teamId,
    userId: ctx.userId,
    projectId: ctx.project.id,
    layoutId,
    formatId: src.format_id,
    brandKitId: ctx.project.brand_kit_id,
    title: src.title ?? undefined,
    kicker: src.kicker ?? undefined,
    tagline: src.tagline ?? undefined,
    theme: src.theme === 'dark' ? 'dark' : 'light',
    effect: src.effect ?? undefined,
    panels,
    preselected: sameCells,
  });
}

/** One unguessable pack token per project; creating it twice keeps the first. */
export async function ensurePackLink(env: Env, projectId: string): Promise<void> {
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  await env.DB.prepare(`UPDATE project SET pack_token = coalesce(pack_token, ?1) WHERE id = ?2`)
    .bind(token, projectId)
    .run();
}
