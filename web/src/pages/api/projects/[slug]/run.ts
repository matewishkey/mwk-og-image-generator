import type { APIRoute } from 'astro';
import { ENV } from '../../../../lib/runtime';
import { err, ok } from '../../../../lib/api';
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
  try {
    const runId = await createRun(ENV, {
      teamId: team.id,
      userId: user.id,
      project: bundle.project,
      style: bundle.style,
      shots: bundle.shots,
      models,
      iterations: bundle.project.iterations,
      kind: 'full',
    });
    const refs = await loadProjectRefs(ENV, bundle.project.id);
    const cells = bundle.shots.length * bundle.project.iterations;
    return ok(
      {
        runId,
        takes: cells * models.length,
        estimatedUsd:
          estimateMicros(models, bundle.project.tier, cells, refs.megapixels) / 1_000_000,
        url: `/projects/${bundle.project.slug}/takes`,
      },
      201,
    );
  } catch (e) {
    return err(502, `the run could not start: ${(e as Error).message}`);
  }
};
