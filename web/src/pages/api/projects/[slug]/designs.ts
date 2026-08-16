import type { APIRoute } from 'astro';
import { ENV } from '../../../../lib/runtime';
import { err, ok, readJson } from '../../../../lib/api';
import { loadProject } from '../../../../lib/data';
import { createDesign } from '../../../../lib/design';
import { ulid } from '../../../../lib/ulid';
import { layoutPanels, LayoutConfigSchema } from '../../../../../../src/seam.ts';
import { slugify } from '../../../../../../src/style.ts';

/**
 * Hand-authored template -> validated layout row -> rendered design. The agent
 * iteration loop: every POST is a NEW layout (generated_by 'hand') — append-only
 * history, same as the design page's author card.
 */
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
    title?: string;
    kicker?: string;
    tagline?: string;
  }>(ctx.request);
  if (!body?.config) return err(400, 'send { config } — a LayoutConfig object');

  const parsed = LayoutConfigSchema.safeParse(body.config);
  if (!parsed.success)
    return err(
      400,
      parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; '),
    );

  const picks = await ENV.DB.prepare(
    `SELECT sh.position, sh.label, t.id AS take_id, t.art_key
       FROM shot sh JOIN take t ON t.id = sh.picked_take_id
      WHERE sh.project_id = ?1 AND sh.deleted_at IS NULL AND t.art_key IS NOT NULL
      ORDER BY sh.position`,
  )
    .bind(bundle.project.id)
    .all<{ position: number; label: string | null; take_id: string; art_key: string }>();

  const needs = layoutPanels(parsed.data);
  if (picks.results.length < needs)
    return err(400, `this template needs ${needs} picks; the project has ${picks.results.length}`);

  const name = body.name?.trim() || 'Hand-authored';
  const layoutId = ulid();
  await ENV.DB.prepare(
    `INSERT INTO layout (id, team_id, slug, name, config, generated_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'hand', ?6, ?6)`,
  )
    .bind(layoutId, team.id, `${slugify(name) || 'tpl'}-${layoutId.slice(-6).toLowerCase()}`,
          name, JSON.stringify(parsed.data), new Date().toISOString())
    .run();

  try {
    const designId = await createDesign(ENV, {
      teamId: team.id,
      userId: user.id,
      projectId: bundle.project.id,
      layoutId,
      formatId: body.formatId ?? 'fmt_og',
      brandKitId: bundle.project.brand_kit_id,
      title: body.title ?? bundle.project.title ?? undefined,
      kicker: body.kicker ?? bundle.project.kicker ?? undefined,
      tagline: body.tagline ?? bundle.project.tagline ?? undefined,
      panels: picks.results.map((p) => ({
        takeId: p.take_id,
        artKey: p.art_key,
        label: p.label ?? undefined,
      })),
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
  } catch (e) {
    return err(422, `the renderer rejected it: ${(e as Error).message}`);
  }
};
