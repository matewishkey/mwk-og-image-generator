import type { APIRoute } from 'astro';
import { ENV } from '../../../../lib/runtime';
import { err, ok, readJson } from '../../../../lib/api';
import { loadProject } from '../../../../lib/data';
import { createRun, estimateMicros, loadProjectRefs } from '../../../../lib/runs';

/** Kick off a full run — the project's settings drive models and iterations,
 *  exactly like the site's Run button. */
export const POST: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  const user = ctx.locals.user;
  if (!team || !user) return err(403, 'no team');

  const bundle = await loadProject(ENV, team.id, ctx.params.slug!);
  if (!bundle) return err(404, 'no such project');
  if (!bundle.shots.length) return err(400, 'add at least one shot first');

  const models: string[] = JSON.parse(bundle.project.models);
  // dispatch:'local' = direct-ingest (round 8b): the run rows are created
  // exactly as always, but the payload comes BACK to the caller (the studio
  // CLI on the dev box), which executes it and posts the same events.
  const body = await readJson<{ dispatch?: string }>(ctx.request);
  const local = body?.dispatch === 'local';
  try {
    const { runId, request } = await createRun(ENV, {
      teamId: team.id,
      userId: user.id,
      project: bundle.project,
      styles: bundle.styles,
      shots: bundle.shots,
      models,
      iterations: bundle.project.iterations,
      kind: 'full',
      dispatch: local ? 'return' : undefined,
    });
    const refs = await loadProjectRefs(ENV, bundle.project.id);
    const cells = bundle.shots.reduce(
      (n, s) => n + (s.style_override_id ? 1 : bundle.styles.length) * bundle.project.iterations,
      0,
    );
    return ok(
      {
        runId,
        takes: cells * models.length,
        estimatedUsd:
          estimateMicros(models, bundle.project.tier, cells, refs.megapixels) / 1_000_000,
        url: `/projects/${bundle.project.slug}/runs/${runId}`,
        ...(local ? { request } : {}),
      },
      201,
    );
  } catch (e) {
    return err(502, `the run could not start: ${(e as Error).message}`);
  }
};
