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

  const body = await readJson<{ kind?: string; ref?: string }>(ctx.request);
  if (!body || (body.kind !== 'layout' && body.kind !== 'style') || !body.ref)
    return err(400, 'send { kind: "layout" | "style", ref: <id> }');

  const project = bundle.project;
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
        refId: body.ref,
        layoutConfig: parsed.data,
      });
      return ok({ url: `/img/${row.r2_key}`, width: row.width, height: row.height });
    }

    // kind === 'style'
    if (!bundle.styles.some((s) => s.id === body.ref)) return err(404, 'that style is not in the project set');
    const panels = await resolvePanelTakes(ENV, project.id, body.ref);
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
