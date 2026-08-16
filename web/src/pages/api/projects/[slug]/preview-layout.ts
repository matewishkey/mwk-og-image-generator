/**
 * Live layout preview: config in, PNG bytes out. No layout row, no design row,
 * no R2 object — the editor island calls this on every (debounced) change.
 */

import type { APIRoute } from 'astro';
import { ENV } from '../../../../lib/runtime';
import { err, readJson } from '../../../../lib/api';
import { loadProject } from '../../../../lib/data';
import {
  LayoutConfigSchema,
  layoutPanels,
  seamHeaders,
  type EngineRenderRequest,
} from '../../../../../../src/seam.ts';
import { isEffect } from '../../../../../../src/effects.ts';

interface PreviewBody {
  config?: unknown;
  title?: string;
  kicker?: string;
  tagline?: string;
  effect?: string;
  theme?: 'light' | 'dark';
  /** Preview canvas width; height follows the OG ratio. Clamped. */
  width?: number;
}

export const POST: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team || !ctx.locals.user) return err(403, 'no team');
  const bundle = await loadProject(ENV, team.id, ctx.params.slug!);
  if (!bundle) return err(404, 'no such project');

  const body = await readJson<PreviewBody>(ctx.request);
  if (!body) return err(400, 'send a JSON body (content-type: application/json)');

  const parsed = LayoutConfigSchema.safeParse(body.config);
  if (!parsed.success)
    return err(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const cfg = parsed.data;

  const picks = await ENV.DB.prepare(
    `SELECT sh.position, sh.label, t.art_key FROM shot sh
       JOIN take t ON t.id = sh.picked_take_id
      WHERE sh.project_id = ?1 AND sh.deleted_at IS NULL AND t.art_key IS NOT NULL
      ORDER BY sh.position`,
  )
    .bind(bundle.project.id)
    .all<{ position: number; label: string | null; art_key: string }>();

  const needed = layoutPanels(cfg);
  if (picks.results.length < needed)
    return err(400, `this layout needs ${needed} picks; the project has ${picks.results.length}`);

  const kit = await ENV.DB.prepare(`SELECT config, mark_key FROM brand_kit WHERE id = ?1`)
    .bind(bundle.project.brand_kit_id)
    .first<{ config: string; mark_key: string | null }>();
  if (!kit) return err(500, 'the project brand kit is missing');

  const width = Math.max(300, Math.min(1200, Math.round(body.width ?? 600)));
  const height = Math.round((width * 630) / 1200);

  const payload: EngineRenderRequest = {
    designId: 'preview',
    outKey: '',
    thumbKey: '',
    width,
    height,
    inline: true,
    theme: body.theme,
    layout: cfg,
    brand: JSON.parse(kit.config),
    markKey: kit.mark_key ?? undefined,
    effect: body.effect && isEffect(body.effect) ? body.effect : undefined,
    text: {
      title: body.title?.trim() || undefined,
      kicker: body.kicker?.trim() || undefined,
      tagline: body.tagline?.trim() || undefined,
    },
    panels: picks.results.slice(0, needed).map((p) => ({
      key: p.art_key,
      label: p.label ?? `shot ${p.position}`,
    })),
  };

  if (!ENV.ENGINE) return err(500, 'ENGINE binding is not configured');
  const raw = JSON.stringify(payload);
  const res = await ENV.ENGINE.fetch('https://engine/render', {
    method: 'POST',
    headers: await seamHeaders(ENV.SEAM_SECRET, raw),
    body: raw,
  });
  if (!res.ok) return err(502, `render failed: ${res.status} ${await res.text()}`);
  return new Response(res.body, {
    headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
  });
};
