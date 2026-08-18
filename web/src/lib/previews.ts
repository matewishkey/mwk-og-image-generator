/**
 * Cached $0.00 composite previews: real cards rendered with the project's
 * actual pictures, so nobody has to imagine what a layout or a style would
 * look like. Two kinds:
 *
 *   'layout' — a layout rendered with the project's pictures
 *   'style'  — one OG card per project style
 *
 * Previews render ON INTENT only (a page or API asks for one) — never as a
 * background sweep on run-finish or page load (round 7).
 *
 * A preview is a cache, not history. The input hash is the SHA-256 of the
 * exact engine payload, so any change to picks, kit, words, theme or layout
 * makes it stale; the hash also lives in the R2 key, keeping /img's
 * immutable cache header honest. Stale objects are deleted on refresh.
 */

import {
  hasExplicitPanels,
  LayoutConfigSchema,
  layoutPanels,
  selectPanels,
  seamHeaders,
  type EngineRenderRequest,
  type LayoutConfig,
} from '../../../src/seam.ts';

export interface PanelTake {
  position: number;
  label: string | null;
  /** Null when the shot has no usable take (in the requested style). The row
   *  still occupies its slot so `panel` indexes never shift. */
  take_id: string | null;
  art_key: string | null;
  art_thumb_key: string | null;
  width: number | null;
  height: number | null;
  /** Set when the shot is hidden: it keeps its inventory slot (so `panel`
   *  indexes stay stable) but must not feed new designs or previews. */
  hidden: string | null;
}

/**
 * The best take per shot, in shot order: the pick when it qualifies, else the
 * newest succeeded take — scoped to one style when styleId is given. Shots
 * with nothing usable are skipped (previews render with what exists).
 */
export async function resolvePanelTakes(
  env: Env,
  projectId: string,
  styleId?: string,
): Promise<PanelTake[]> {
  // NOTE the shape: SQLite refuses an outer-alias reference inside the ORDER BY
  // of an ON-clause subquery ("no such column: sh.picked_take_id"), so the pick
  // preference is a coalesce of two subqueries whose correlation sits in WHERE.
  const rows = await env.DB.prepare(
    `SELECT sh.position, sh.label, sh.hidden_at AS hidden, t.id AS take_id,
            t.art_key, t.art_thumb_key, t.width, t.height
       FROM shot sh
       LEFT JOIN take t ON t.id = coalesce(
         (SELECT tp.id FROM take tp
           WHERE tp.id = sh.picked_take_id AND tp.status = 'succeeded' AND tp.art_key IS NOT NULL
             AND (?2 IS NULL OR tp.style_id = ?2)),
         (SELECT t2.id FROM take t2
           WHERE t2.shot_id = sh.id AND t2.status = 'succeeded' AND t2.art_key IS NOT NULL
             AND (?2 IS NULL OR t2.style_id = ?2)
           ORDER BY t2.created_at DESC LIMIT 1))
      WHERE sh.project_id = ?1 AND sh.deleted_at IS NULL
      ORDER BY sh.position`,
  )
    .bind(projectId, styleId ?? null)
    .all<PanelTake>();
  return rows.results;
}

interface ProjectRow {
  id: string;
  brand_kit_id: string;
  title: string | null;
  kicker: string | null;
  tagline: string | null;
}

export interface EnsureOpts {
  teamId: string;
  project: ProjectRow;
  kind: 'layout' | 'style';
  refId: string;
  layoutConfig: LayoutConfig;
  /** Lead the inventory with this shot for templates that don't name their
   *  shots explicitly — "work on shot N". Explicitly-wired templates ignore it. */
  shotPosition?: number;
  /** For kind 'style': scope panel takes to this style. */
  styleId?: string;
  theme?: 'light' | 'dark';
}

export interface PreviewRow {
  r2_key: string;
  width: number;
  height: number;
  input_hash: string;
}

const W = 1200;
const H = 630;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Return a fresh preview, rendering only when the inputs changed. Throws when
 * the layout needs more panels than the project can currently supply.
 */
/**
 * Hidden shots become null slots (index-stable); a shot scope moves the chosen
 * shot to the front unless the template pins its shots via cell.panel.
 */
export function scopeInventory(
  cfg: LayoutConfig,
  panels: PanelTake[],
  shotPosition?: number,
): (PanelTake | null)[] {
  const slots: (PanelTake | null)[] = panels.map((p) => (p.hidden || !p.take_id ? null : p));
  if (shotPosition == null || hasExplicitPanels(cfg)) return slots;
  const i = panels.findIndex((p) => p.position === shotPosition);
  if (i < 0 || slots[i] == null) return slots;
  return [slots[i], ...slots.filter((_, j) => j !== i)];
}

export async function ensurePreview(env: Env, o: EnsureOpts): Promise<PreviewRow> {
  const panels = await resolvePanelTakes(env, o.project.id, o.styleId);
  const sel = selectPanels(o.layoutConfig, scopeInventory(o.layoutConfig, panels, o.shotPosition));

  const kit = await env.DB.prepare(`SELECT config, mark_key FROM brand_kit WHERE id = ?1`)
    .bind(o.project.brand_kit_id)
    .first<{ config: string; mark_key: string | null }>();
  if (!kit) throw new Error('the project brand kit is missing');

  const payload: EngineRenderRequest = {
    designId: 'preview',
    outKey: '',
    thumbKey: '',
    width: W,
    height: H,
    inline: true,
    theme: o.theme,
    layout: o.layoutConfig,
    brand: JSON.parse(kit.config),
    markKey: kit.mark_key ?? undefined,
    text: {
      title: o.project.title ?? undefined,
      kicker: o.project.kicker ?? undefined,
      tagline: o.project.tagline ?? undefined,
    },
    panels: sel.map((p) => ({
      // scopeInventory nulls any slot without a take, so art_key is real here.
      key: p.art_key!,
      label: p.label ?? `shot ${p.position}`,
    })),
  };
  const raw = JSON.stringify(payload);
  const hash = await sha256(raw);

  const existing = await env.DB.prepare(
    `SELECT r2_key, width, height, input_hash FROM preview
      WHERE project_id = ?1 AND kind = ?2 AND ref_id = ?3`,
  )
    .bind(o.project.id, o.kind, o.refId)
    .first<PreviewRow>();
  if (existing && existing.input_hash === hash) return existing;

  if (!env.ENGINE) throw new Error('ENGINE binding is not configured');
  const res = await env.ENGINE.fetch('https://engine/render', {
    method: 'POST',
    headers: await seamHeaders(env.SEAM_SECRET, raw),
    body: raw,
  });
  if (!res.ok) throw new Error(`preview render failed: ${res.status} ${await res.text()}`);

  const key = `teams/${o.teamId}/projects/${o.project.id}/previews/${o.kind}-${o.refId}-${hash.slice(0, 12)}.png`;
  await env.BUCKET.put(key, await res.arrayBuffer(), {
    httpMetadata: { contentType: 'image/png' },
  });
  await env.DB.prepare(
    `INSERT INTO preview (project_id, kind, ref_id, input_hash, r2_key, width, height, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (project_id, kind, ref_id) DO UPDATE
       SET input_hash = ?4, r2_key = ?5, width = ?6, height = ?7, updated_at = ?8`,
  )
    .bind(o.project.id, o.kind, o.refId, hash, key, W, H, new Date().toISOString())
    .run();
  if (existing && existing.r2_key !== key) await env.BUCKET.delete(existing.r2_key);
  return { r2_key: key, width: W, height: H, input_hash: hash };
}

/**
 * The layout a style preview renders with: the fewest-panels HOUSE layout,
 * slug-ordered — a FIXED choice, so style cards stay in family with each
 * other across time instead of chasing whatever design happens to lead.
 */
export async function stylePreviewLayout(
  env: Env,
  teamId: string,
  projectId: string,
  panelCount: number,
): Promise<{ id: string; config: LayoutConfig } | null> {
  const candidates = (
    await env.DB.prepare(
      `SELECT l.id, l.config FROM layout l JOIN team t ON t.id = l.team_id
        WHERE t.kind = 'house' AND l.archived_at IS NULL ORDER BY l.slug`,
    ).all<{ id: string; config: string }>()
  ).results;

  let best: { id: string; config: LayoutConfig; panels: number } | null = null;
  for (const c of candidates) {
    const parsed = LayoutConfigSchema.safeParse(JSON.parse(c.config));
    if (!parsed.success) continue;
    const n = layoutPanels(parsed.data);
    if (n > panelCount) continue;
    if (!best || n < best.panels) best = { id: c.id, config: parsed.data, panels: n };
  }
  return best ? { id: best.id, config: best.config } : null;
}
