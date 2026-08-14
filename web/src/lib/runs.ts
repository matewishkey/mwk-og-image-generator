/**
 * Run kickoff and the engine call. One code path serves 'run the project',
 * 're-shoot one shot' and 're-roll one take' — the grid just shrinks.
 */

import { compose } from '../../../src/prompt.ts';
import { pickTier, priceOf, resolveModel } from '../../../src/models.ts';
import { seamHeaders, type EngineRunRequest, type SeamIdea } from '../../../src/seam.ts';
import type { Style } from '../../../src/style.ts';
import { ulid } from './ulid';

export interface ProjectRow {
  id: string;
  team_id: string;
  slug: string;
  name: string;
  default_style_id: string;
  models: string;
  iterations: number;
  tier: string | null;
  allow_text: number;
  extra: string | null;
  ref_role: string | null;
  title: string | null;
  kicker: string | null;
  tagline: string | null;
  version: number;
}

export interface StyleRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  look: string;
  subject: string;
  avoid: string;
  tags: string;
  origin: string;
}

export interface ShotRow {
  id: string;
  position: number;
  label: string | null;
  prompt: string;
}

export function toStyle(row: StyleRow): Style {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    look: row.look,
    subject: row.subject,
    avoid: row.avoid,
    refs: [],
    tags: JSON.parse(row.tags),
    origin: row.origin,
  };
}

export const usdToMicros = (usd: number): number => Math.round(usd * 1_000_000);
export const microsToUsd = (m: number): string => `$${(m / 1_000_000).toFixed(4)}`;

/** Estimate in micros for a grid of shots x models x iterations, no references. */
export function estimateMicros(models: string[], tier: string | null, cells: number): number {
  const perRound = models.reduce((sum, alias) => {
    const spec = resolveModel(alias);
    return sum + priceOf(spec, pickTier(spec, tier ?? undefined), 0, undefined);
  }, 0);
  return usdToMicros(perRound * cells);
}

export interface CreateRunOpts {
  teamId: string;
  userId: string;
  project: ProjectRow;
  style: StyleRow;
  shots: ShotRow[];
  models: string[];
  iterations: number;
  kind: 'full' | 'shot' | 'take';
  /** Re-roll: the take this run replaces; pointed at its replacement immediately. */
  supersedeTakeId?: string;
}

export async function createRun(env: Env, o: CreateRunOpts): Promise<string> {
  const now = new Date();
  const nowIso = now.toISOString();
  const lease = new Date(now.getTime() + 30 * 60_000).toISOString();
  const runId = ulid();
  const style = toStyle(o.style);
  const hasRefs = false; // reference plumbing lands with the upload UI

  const estimated = estimateMicros(o.models, o.project.tier, o.shots.length * o.iterations);

  const stmts = [
    env.DB.prepare(
      `INSERT INTO run (id, team_id, project_id, project_version, kind, status,
         estimated_micros, ref_megapixels, started_by, started_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, 0, ?7, ?8)`,
    ).bind(runId, o.teamId, o.project.id, o.project.version, o.kind, estimated, o.userId, nowIso),
  ];

  const ideas: SeamIdea[] = [];
  let firstTakeId: string | null = null;

  for (const shot of o.shots) {
    const prompt = compose({
      style,
      idea: shot.prompt,
      hasRefs,
      refRole: o.project.ref_role ?? undefined,
      allowText: o.project.allow_text === 1,
      extra: o.project.extra ?? undefined,
    });
    ideas.push({ shotId: shot.id, prompt });

    for (const alias of o.models) {
      const spec = resolveModel(alias);
      const tier = pickTier(spec, o.project.tier ?? undefined);
      for (let iteration = 1; iteration <= o.iterations; iteration++) {
        const takeId = ulid();
        firstTakeId ??= takeId;
        const input = spec.buildInput({ prompt, refs: [], tier, seconds: undefined });
        stmts.push(
          env.DB.prepare(
            `INSERT INTO take (id, run_id, shot_id, team_id, style_id, model_alias, model_id,
               tier, iteration, status, prompt, input_json, cost_micros, idempotency_key,
               lease_expires_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'queued', ?10, ?11, 0, ?12, ?13, ?14)`,
          ).bind(
            takeId,
            runId,
            shot.id,
            o.teamId,
            o.style.id,
            spec.alias,
            spec.id,
            tier,
            iteration,
            prompt,
            JSON.stringify(input),
            `${runId}:${shot.id}:${spec.alias}:${iteration}`,
            lease,
            nowIso,
          ),
        );
      }
    }
  }

  if (o.supersedeTakeId && firstTakeId) {
    stmts.push(
      env.DB.prepare(`UPDATE take SET superseded_by_id = ?1 WHERE id = ?2`).bind(
        firstTakeId,
        o.supersedeTakeId,
      ),
    );
  }

  await env.DB.batch(stmts);

  // The run rows are durable; now hand the work to the engine. A failure here marks
  // the run failed rather than leaving takes queued forever.
  try {
    if (!env.ENGINE) throw new Error('ENGINE binding is not configured');
    const payload: EngineRunRequest = {
      runId,
      r2Prefix: `teams/${o.teamId}/runs/${runId}`,
      ideas,
      style,
      models: o.models,
      iterations: o.iterations,
      tier: o.project.tier ?? undefined,
      refKeys: [],
      title: o.project.title ?? 'Mate *Wish* Key',
      kicker: o.project.kicker ?? undefined,
      tagline: o.project.tagline ?? undefined,
      allowText: o.project.allow_text === 1,
      refRole: o.project.ref_role ?? undefined,
      extra: o.project.extra ?? undefined,
    };
    const body = JSON.stringify(payload);
    const res = await env.ENGINE.fetch('https://engine/run', {
      method: 'POST',
      headers: await seamHeaders(env.SEAM_SECRET, body),
      body,
    });
    if (res.status !== 202) throw new Error(`engine replied ${res.status}: ${await res.text()}`);
  } catch (e) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE run SET status='failed', finished_at=?1, note=?2 WHERE id=?3 AND status='queued'`,
      ).bind(nowIso, (e as Error).message, runId),
      env.DB.prepare(
        `UPDATE take SET status='failed', error_kind='dispatch', error_message=?1, finished_at=?2
          WHERE run_id=?3 AND status='queued'`,
      ).bind((e as Error).message, nowIso, runId),
    ]);
    throw e;
  }

  return runId;
}
