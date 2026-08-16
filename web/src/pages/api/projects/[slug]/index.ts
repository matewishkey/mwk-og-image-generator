import type { APIRoute } from 'astro';
import { ENV } from '../../../../lib/runtime';
import { err, ok, readJson } from '../../../../lib/api';
import { loadProject } from '../../../../lib/data';
import { updateProject, type UpdateProjectPatch } from '../../../../lib/projects';

export const GET: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team) return err(403, 'no team');

  const bundle = await loadProject(ENV, team.id, ctx.params.slug!);
  if (!bundle) return err(404, 'no such project');

  const p = bundle.project;
  return ok({
    project: {
      slug: p.slug,
      name: p.name,
      description: p.description,
      models: JSON.parse(p.models) as string[],
      iterations: p.iterations,
      tier: p.tier,
      allow_text: p.allow_text === 1,
      extra: p.extra,
      ref_role: p.ref_role,
      title: p.title,
      kicker: p.kicker,
      tagline: p.tagline,
    },
    style: { id: bundle.style.id, slug: bundle.style.slug, name: bundle.style.name },
    shots: bundle.shots.map((s) => ({
      id: s.id,
      position: s.position,
      label: s.label,
      prompt: s.prompt,
      picked_take_id: s.picked_take_id,
    })),
    url: `/projects/${p.slug}/shots`,
  });
};

/**
 * Partial settings update — same lib the settings page uses (updateProject),
 * so the CLI's `studio set` and the browser can never drift.
 */
export const PATCH: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team || !ctx.locals.user) return err(403, 'no team');
  const bundle = await loadProject(ENV, team.id, ctx.params.slug!);
  if (!bundle) return err(404, 'no such project');

  const body = await readJson<UpdateProjectPatch>(ctx.request);
  if (!body) return err(400, 'send a JSON body (content-type: application/json)');
  const r = await updateProject(ENV, team.id, bundle.project.id, body);
  if ('error' in r) return err(r.status, r.error);
  return ok({ ok: true, url: `/projects/${bundle.project.slug}/settings` });
};
