/**
 * Designs over JSON — thin wrapper over lib/design-actions (the page uses the
 * same functions, so browser and CLI can never drift). Two shapes:
 *
 *   { config, name?, formatId?, title?, kicker?, tagline? }
 *     hand-authored template -> validated NEW layout row -> rendered design
 *     (append-only history, generated_by 'hand')
 *
 *   { layoutId, formatIds?, themes?, effect?, title?, kicker?, tagline? }
 *     render an existing layout with the project's current images
 *     (formatIds absent = the OG card)
 */

import type { APIRoute } from 'astro';
import { ENV } from '../../../../lib/runtime';
import { err, ok, readJson } from '../../../../lib/api';
import { hasExplicitPanels, layoutPanels, LayoutConfigSchema } from '../../../../../../src/seam.ts';
import { loadProject } from '../../../../lib/data';
import {
  authorTemplate,
  composeFromTakes,
  renderFromLayout,
  renderFromPicks,
  type DesignCtx,
} from '../../../../lib/design-actions';

/** Templates + revisions, the CLI's map for compose. Lean by design: names,
 * slot counts and ids — the page keeps its richer fits/thumbs computation. */
export const GET: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team) return err(403, 'no team');
  const bundle = await loadProject(ENV, team.id, ctx.params.slug!);
  if (!bundle) return err(404, 'no such project');

  const layouts = await ENV.DB.prepare(
    `SELECT l.id, l.slug, l.name, l.config, t.kind AS team_kind FROM layout l JOIN team t ON t.id = l.team_id
      WHERE (l.team_id = ?1 OR t.kind = 'house') AND l.archived_at IS NULL
        AND (t.kind = 'house' OR l.slug NOT LIKE 'gen-%')
      ORDER BY l.name`,
  )
    .bind(team.id)
    .all<{ id: string; slug: string; name: string; config: string; team_kind: string }>();
  const templates = layouts.results.flatMap((l) => {
    try {
      const cfg = LayoutConfigSchema.parse(JSON.parse(l.config));
      return [
        {
          id: l.id,
          slug: l.slug,
          name: l.name,
          slots: layoutPanels(cfg),
          pinned: hasExplicitPanels(cfg),
          house: l.team_kind === 'house',
        },
      ];
    } catch {
      return [];
    }
  });

  const revisions = await ENV.DB.prepare(
    `SELECT d.id, d.layout_id, d.theme, d.created_at, f.slug AS format
       FROM design d JOIN format f ON f.id = d.format_id
      WHERE d.project_id = ?1 AND d.superseded_by_id IS NULL
      ORDER BY d.created_at DESC LIMIT 60`,
  )
    .bind(bundle.project.id)
    .all<{ id: string; layout_id: string; theme: string; created_at: string; format: string }>();

  return ok({ templates, revisions: revisions.results });
};

export const POST: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  const user = ctx.locals.user;
  if (!team || !user) return err(403, 'no team');

  const bundle = await loadProject(ENV, team.id, ctx.params.slug!);
  if (!bundle) return err(404, 'no such project');

  const body = await readJson<{
    config?: unknown;
    name?: string;
    formatId?: string;
    layoutId?: string;
    formatIds?: string[];
    themes?: ('light' | 'dark')[];
    effect?: string;
    title?: string;
    kicker?: string;
    tagline?: string;
    theme?: 'light' | 'dark';
    style?: string;
    shot?: number;
    takes?: string[];
  }>(ctx.request);
  if (!body?.config && !body?.layoutId && !body?.takes?.length)
    return err(
      400,
      'send { config } (author), { layoutId } (render an existing layout), or { takes } (compose)',
    );

  const dctx: DesignCtx = {
    teamId: team.id,
    userId: user.id,
    project: {
      id: bundle.project.id,
      slug: bundle.project.slug,
      brand_kit_id: bundle.project.brand_kit_id,
      title: bundle.project.title ?? null,
      kicker: bundle.project.kicker ?? null,
      tagline: bundle.project.tagline ?? null,
    },
  };

  try {
    if (body.config) {
      const scopeStyle = body.style ? bundle.styles.find((st) => st.slug === body.style) : undefined;
      const { designId, layoutId } = await authorTemplate(ENV, dctx, {
        config: body.config,
        name: body.name,
        formatId: body.formatId,
        title: body.title,
        kicker: body.kicker,
        tagline: body.tagline,
        theme: body.theme === 'dark' ? 'dark' : undefined,
        effect: body.effect,
        styleId: scopeStyle?.id,
        shotPosition: Number.isInteger(body.shot) ? Number(body.shot) : undefined,
      });
      return ok(
        {
          designId,
          layoutId,
          url: `/projects/${bundle.project.slug}/design?lead=${designId}`,
          image: `/img/teams/${team.id}/designs/${designId}.png`,
        },
        201,
      );
    }

    // { takes } — compose (round 8c): explicit ordered pictures. With layoutId
    // = one design from that template; without = one per count-matching template.
    if (body.takes?.length) {
      const og = await ENV.DB.prepare(
        `SELECT id, slug, name, width, height FROM format WHERE slug = 'og'`,
      ).first<{ id: string; slug: string; name: string; width: number; height: number }>();
      if (!og) return err(500, 'the og format row is missing');
      const words = {
        title: body.title ?? dctx.project.title ?? undefined,
        kicker: body.kicker ?? dctx.project.kicker ?? undefined,
        tagline: body.tagline ?? dctx.project.tagline ?? undefined,
      };
      const theme = body.theme === 'dark' ? ('dark' as const) : undefined;
      if (body.layoutId) {
        const designId = await renderFromPicks(ENV, dctx, {
          layoutId: body.layoutId,
          takeIds: body.takes,
          format: og,
          theme,
          ...words,
        });
        return ok(
          {
            designs: [{ designId, layoutId: body.layoutId }],
            url: `/projects/${bundle.project.slug}/results?ids=${designId}`,
          },
          201,
        );
      }
      const designs = await composeFromTakes(ENV, dctx, {
        takeIds: body.takes,
        format: og,
        theme,
        ...words,
      });
      return ok(
        {
          designs,
          url: `/projects/${bundle.project.slug}/results?ids=${designs.map((d) => d.designId).join(',')}`,
        },
        201,
      );
    }

    const wanted = body.formatIds?.length ? body.formatIds : ['fmt_og'];
    const formats = (
      await ENV.DB.prepare(`SELECT id, slug, name, width, height FROM format ORDER BY rowid`).all<{
        id: string; slug: string; name: string; width: number; height: number;
      }>()
    ).results.filter((f) => wanted.includes(f.id) || wanted.includes(f.slug));
    if (!formats.length) return err(400, 'no known format in formatIds');
    const designId = await renderFromLayout(ENV, dctx, {
      layoutId: body.layoutId!,
      formats,
      themes: body.themes,
      effect: body.effect,
      title: body.title ?? dctx.project.title ?? undefined,
      kicker: body.kicker ?? dctx.project.kicker ?? undefined,
      tagline: body.tagline ?? dctx.project.tagline ?? undefined,
    });
    return ok(
      {
        designId: designId || null,
        url: `/projects/${bundle.project.slug}/design${designId ? `?lead=${designId}` : ''}`,
      },
      201,
    );
  } catch (e) {
    return err(422, `the renderer rejected it: ${(e as Error).message}`);
  }
};
