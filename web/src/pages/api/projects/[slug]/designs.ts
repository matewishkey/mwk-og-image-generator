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
import { loadProject } from '../../../../lib/data';
import { authorTemplate, renderFromLayout, type DesignCtx } from '../../../../lib/design-actions';

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
  }>(ctx.request);
  if (!body?.config && !body?.layoutId)
    return err(400, 'send { config } (author a template) or { layoutId } (render an existing layout)');

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
