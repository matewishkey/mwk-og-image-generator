/**
 * Design creation: picks + layout + format + text -> one engine render, $0.00.
 * Designs are append-only; a change is a new design, never an edit.
 */

import {
  selectPanels,
  LayoutConfigSchema,
  seamHeaders,
  type EngineRenderRequest,
  type EngineRenderResponse,
  type RenderOutput,
} from '../../../src/seam.ts';
import { ulid } from './ulid';

export interface DesignInputs {
  teamId: string;
  userId: string;
  projectId: string;
  layoutId: string;
  formatId: string;
  brandKitId: string;
  title?: string;
  kicker?: string;
  tagline?: string;
  /** Group this design into a collection (one design across several formats). */
  collectionId?: string;
  /** Finish-pass preset slug (src/effects.ts); undefined = none. */
  effect?: string;
  /** 'dark' renders with the kit's colorsDark overlaid; default 'light'. */
  theme?: 'light' | 'dark';
  /** Panels in order: art R2 keys with labels, each tied to a take id. */
  panels: { takeId: string; artKey: string; label?: string }[];
}

export async function createDesign(env: Env, o: DesignInputs): Promise<string> {
  const [layout, format, kit] = await Promise.all([
    env.DB.prepare(`SELECT config FROM layout WHERE id = ?1`).bind(o.layoutId).first<{ config: string }>(),
    env.DB.prepare(`SELECT width, height FROM format WHERE id = ?1`).bind(o.formatId).first<{
      width: number;
      height: number;
    }>(),
    env.DB.prepare(`SELECT config, mark_key FROM brand_kit WHERE id = ?1`)
      .bind(o.brandKitId)
      .first<{ config: string; mark_key: string | null }>(),
  ]);
  if (!layout || !format || !kit) throw new Error('layout, format or brand kit missing');

  const cfg = LayoutConfigSchema.parse(JSON.parse(layout.config));
  const sel = selectPanels(cfg, o.panels);

  const designId = ulid();
  const outKey = `teams/${o.teamId}/designs/${designId}.png`;
  const thumbKey = `teams/${o.teamId}/designs/${designId}.webp`;

  const payload: EngineRenderRequest = {
    designId,
    outKey,
    thumbKey,
    width: format.width,
    height: format.height,
    layout: cfg,
    brand: JSON.parse(kit.config),
    markKey: kit.mark_key ?? undefined,
    effect: o.effect,
    theme: o.theme,
    text: { title: o.title, kicker: o.kicker, tagline: o.tagline },
    panels: sel.map((p) => ({ key: p.artKey, label: p.label })),
  };

  if (!env.ENGINE) throw new Error('ENGINE binding is not configured');
  const body = JSON.stringify(payload);
  const res = await env.ENGINE.fetch('https://engine/render', {
    method: 'POST',
    headers: await seamHeaders(env.SEAM_SECRET, body),
    body,
  });
  if (!res.ok) throw new Error(`render failed: ${res.status} ${await res.text()}`);

  const nowIso = new Date().toISOString();
  const stmts = [
    env.DB.prepare(
      `INSERT INTO design (id, team_id, project_id, collection_id, layout_id, brand_kit_id, format_id,
         title, kicker, tagline, r2_key, thumb_key, width, height, created_by, created_at, effect, theme)
       VALUES (?1, ?2, ?3, ?16, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?17, ?18)`,
    ).bind(
      designId,
      o.teamId,
      o.projectId,
      o.layoutId,
      o.brandKitId,
      o.formatId,
      o.title ?? null,
      o.kicker ?? null,
      o.tagline ?? null,
      outKey,
      thumbKey,
      format.width,
      format.height,
      o.userId,
      nowIso,
      o.collectionId ?? null,
      o.effect ?? null,
      o.theme ?? 'light',
    ),
    ...sel.map((p, i) =>
      env.DB.prepare(
        `INSERT INTO design_panel (design_id, position, source_kind, take_id, label)
         VALUES (?1, ?2, 'take', ?3, ?4)`,
      ).bind(designId, i + 1, p.takeId, p.label ?? null),
    ),
    // A re-render of the same template+format+look supersedes its predecessors:
    // they leave the page but stay in the database, like every superseded take.
    env.DB.prepare(
      `UPDATE design SET superseded_by_id = ?1
        WHERE project_id = ?2 AND layout_id = ?3 AND format_id = ?4
          AND theme = ?5 AND coalesce(effect,'') = ?6
          AND id != ?1 AND superseded_by_id IS NULL`,
    ).bind(designId, o.projectId, o.layoutId, o.formatId, o.theme ?? 'light', o.effect ?? ''),
  ];
  await env.DB.batch(stmts);
  return designId;
}

export interface FormatRow {
  id: string;
  slug: string;
  width: number;
  height: number;
}

/**
 * One design across every format — a Collection. ONE engine call renders them all
 * (panels are fetched once on the engine side), then the rows land in one batch.
 */
export async function createCollection(
  env: Env,
  o: Omit<DesignInputs, 'formatId'> & { collectionId: string; formats: FormatRow[] },
): Promise<{ rendered: number; failed: number }> {
  const [layout, kit] = await Promise.all([
    env.DB.prepare(`SELECT config FROM layout WHERE id = ?1`).bind(o.layoutId).first<{ config: string }>(),
    env.DB.prepare(`SELECT config, mark_key FROM brand_kit WHERE id = ?1`)
      .bind(o.brandKitId)
      .first<{ config: string; mark_key: string | null }>(),
  ]);
  if (!layout || !kit) throw new Error('layout or brand kit missing');
  const cfg = LayoutConfigSchema.parse(JSON.parse(layout.config));
  const sel = selectPanels(cfg, o.panels);

  const plan = o.formats.map((f) => {
    const designId = ulid();
    return {
      designId,
      format: f,
      out: {
        outKey: `teams/${o.teamId}/designs/${designId}.png`,
        thumbKey: `teams/${o.teamId}/designs/${designId}.webp`,
        width: f.width,
        height: f.height,
      } satisfies RenderOutput,
    };
  });

  const payload: EngineRenderRequest = {
    designId: plan[0]!.designId,
    outKey: '',
    thumbKey: '',
    width: 0,
    height: 0,
    outputs: plan.map((p) => p.out),
    layout: cfg,
    brand: JSON.parse(kit.config),
    markKey: kit.mark_key ?? undefined,
    effect: o.effect,
    theme: o.theme,
    text: { title: o.title, kicker: o.kicker, tagline: o.tagline },
    panels: sel.map((p) => ({ key: p.artKey, label: p.label })),
  };
  if (!env.ENGINE) throw new Error('ENGINE binding is not configured');
  const body = JSON.stringify(payload);
  const res = await env.ENGINE.fetch('https://engine/render', {
    method: 'POST',
    headers: await seamHeaders(env.SEAM_SECRET, body),
    body,
  });
  if (!res.ok) throw new Error(`render failed: ${res.status} ${await res.text()}`);
  const outcome = (await res.json()) as EngineRenderResponse;
  const okKeys = new Set((outcome.results ?? []).filter((r) => r.ok).map((r) => r.outKey));

  const nowIso = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let rendered = 0;
  for (const item of plan) {
    if (!okKeys.has(item.out.outKey)) continue;
    rendered++;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO design (id, team_id, project_id, collection_id, layout_id, brand_kit_id, format_id,
           title, kicker, tagline, r2_key, thumb_key, width, height, created_by, created_at, effect, theme)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
      ).bind(
        item.designId, o.teamId, o.projectId, o.collectionId, o.layoutId, o.brandKitId,
        item.format.id, o.title ?? null, o.kicker ?? null, o.tagline ?? null,
        item.out.outKey, item.out.thumbKey, item.format.width, item.format.height,
        o.userId, nowIso, o.effect ?? null, o.theme ?? 'light',
      ),
      ...sel.map((pnl, i) =>
        env.DB.prepare(
          `INSERT INTO design_panel (design_id, position, source_kind, take_id, label)
           VALUES (?1, ?2, 'take', ?3, ?4)`,
        ).bind(item.designId, i + 1, pnl.takeId, pnl.label ?? null),
      ),
      env.DB.prepare(
        `UPDATE design SET superseded_by_id = ?1
          WHERE project_id = ?2 AND layout_id = ?3 AND format_id = ?4
            AND theme = ?5 AND coalesce(effect,'') = ?6
            AND id != ?1 AND superseded_by_id IS NULL`,
      ).bind(item.designId, o.projectId, o.layoutId, item.format.id, o.theme ?? 'light', o.effect ?? ''),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { rendered, failed: plan.length - rendered };
}
