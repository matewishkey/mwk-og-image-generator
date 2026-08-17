/**
 * On-demand preview refresh: the design page's gallery placeholders call this
 * one card at a time. Fresh previews return instantly (hash match, no
 * render); stale or missing ones cost one inline engine render, $0.00.
 */

import type { APIRoute } from 'astro';
import { ENV } from '../../../../lib/runtime';
import { err, ok, readJson } from '../../../../lib/api';
import { loadProject } from '../../../../lib/data';
import { LayoutConfigSchema } from '../../../../../../src/seam.ts';
import {
  ensurePreview,
  resolvePanelTakes,
  stylePreviewLayout,
} from '../../../../lib/previews';

export const POST: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team || !ctx.locals.user) return err(403, 'no team');
  const bundle = await loadProject(ENV, team.id, ctx.params.slug!);
  if (!bundle) return err(404, 'no such project');

  const body = await readJson<{ kind?: string; ref?: string; style?: string; shot?: number; theme?: string }>(
    ctx.request,
  );
  if (!body || (body.kind !== 'layout' && body.kind !== 'style') || !body.ref)
    return err(400, 'send { kind: "layout" | "style", ref: <id>, style?, shot?, theme? }');

  const project = bundle.project;
  // Scope folds into the cache ref: each (layout, style, shot, theme) view is
  // its own preview row, so toggling scope flips between caches instead of
  // thrashing one row's R2 object back and forth.
  const scopeStyle = body.style ? bundle.styles.find((s) => s.slug === body.style) : undefined;
  if (body.style && !scopeStyle) return err(404, 'that style is not in the project set');
  const scopeShot = Number.isInteger(body.shot) ? Number(body.shot) : undefined;
  const scopeTheme = body.theme === 'dark' ? ('dark' as const) : undefined;
  const scopedRef = (ref: string) =>
    ref +
    (scopeStyle ? `@s-${scopeStyle.slug}` : '') +
    (scopeShot != null ? `@p-${scopeShot}` : '') +
    (scopeTheme ? '@t-dark' : '');
  try {
    if (body.kind === 'layout') {
      const layout = await ENV.DB.prepare(
        `SELECT l.config FROM layout l JOIN team t ON t.id = l.team_id
          WHERE l.id = ?1 AND (l.team_id = ?2 OR t.kind = 'house') AND l.archived_at IS NULL`,
      )
        .bind(body.ref, team.id)
        .first<{ config: string }>();
      if (!layout) return err(404, 'no such layout');
      const parsed = LayoutConfigSchema.safeParse(JSON.parse(layout.config));
      if (!parsed.success) return err(400, 'that layout config is not valid');
      const row = await ensurePreview(ENV, {
        teamId: team.id,
        project,
        kind: 'layout',
        refId: scopedRef(body.ref),
        layoutConfig: parsed.data,
        styleId: scopeStyle?.id,
        shotPosition: scopeShot,
        theme: scopeTheme,
      });
      return ok({ url: `/img/${row.r2_key}`, width: row.width, height: row.height });
    }

    // kind === 'style'
    if (!bundle.styles.some((s) => s.id === body.ref)) return err(404, 'that style is not in the project set');
    const panels = (await resolvePanelTakes(ENV, project.id, body.ref)).filter((r) => !r.hidden && r.take_id);
    if (!panels.length) return err(409, 'no succeeded takes in that style yet');
    const layout = await stylePreviewLayout(ENV, team.id, project.id, panels.length);
    if (!layout) return err(409, 'no usable layout for a preview yet');
    const row = await ensurePreview(ENV, {
      teamId: team.id,
      project,
      kind: 'style',
      refId: body.ref,
      layoutConfig: layout.config,
      styleId: body.ref,
    });
    return ok({ url: `/img/${row.r2_key}`, width: row.width, height: row.height });
  } catch (e) {
    return err(500, (e as Error).message);
  }
};
