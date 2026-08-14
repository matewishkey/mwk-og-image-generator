/**
 * Design creation: picks + layout + format + text -> one engine render, $0.00.
 * Designs are append-only; a change is a new design, never an edit.
 */

import {
  ARCHETYPE_PANELS,
  LayoutConfigSchema,
  seamHeaders,
  type EngineRenderRequest,
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
    env.DB.prepare(`SELECT config FROM brand_kit WHERE id = ?1`).bind(o.brandKitId).first<{ config: string }>(),
  ]);
  if (!layout || !format || !kit) throw new Error('layout, format or brand kit missing');

  const cfg = LayoutConfigSchema.parse(JSON.parse(layout.config));
  const needed = ARCHETYPE_PANELS[cfg.archetype];
  if (o.panels.length < needed) {
    throw new Error(`This layout needs ${needed} picks; the project has ${o.panels.length}.`);
  }

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
    text: { title: o.title, kicker: o.kicker, tagline: o.tagline },
    panels: o.panels.slice(0, needed).map((p) => ({ key: p.artKey, label: p.label })),
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
      `INSERT INTO design (id, team_id, project_id, layout_id, brand_kit_id, format_id,
         title, kicker, tagline, r2_key, thumb_key, width, height, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
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
    ),
    ...o.panels.slice(0, needed).map((p, i) =>
      env.DB.prepare(
        `INSERT INTO design_panel (design_id, position, source_kind, take_id, label)
         VALUES (?1, ?2, 'take', ?3, ?4)`,
      ).bind(designId, i + 1, p.takeId, p.label ?? null),
    ),
  ];
  await env.DB.batch(stmts);
  return designId;
}
