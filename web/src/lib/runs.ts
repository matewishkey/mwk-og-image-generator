/**
 * Run kickoff and the engine call. One code path serves 'run the project',
 * 're-shoot one shot' and 're-roll one take' — the grid just shrinks.
 */

import { compose } from '../../../src/prompt.ts';
import { estimateRefMp, pickTier, priceOf, resolveModel } from '../../../src/models.ts';
import { seamHeaders, type EngineRunRequest, type SeamIdea } from '../../../src/seam.ts';
import type { Style } from '../../../src/style.ts';
import { ulid } from './ulid';

export interface ProjectRow {
  id: string;
  team_id: string;
  slug: string;
  name: string;
  default_style_id: string;
  brand_kit_id: string;
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
  /** NULL = the project's style set; set = this shot renders ONLY its override. */
  style_override_id: string | null;
  /** Per-shot "who the reference person is"; NULL = the project's ref_role. */
  ref_role: string | null;
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

/** Estimate in micros for a grid of cells — the ref-billing rule comes from
 *  models.ts (estimateRefMp), the same source the CLI and engine use. */
export function estimateMicros(
  models: string[],
  tier: string | null,
  cells: number,
  refMp = 0,
): number {
  const perRound = models.reduce((sum, alias) => {
    const spec = resolveModel(alias);
    return sum + priceOf(spec, pickTier(spec, tier ?? undefined), estimateRefMp(spec, refMp), undefined);
  }, 0);
  return usdToMicros(perRound * cells);
}

export interface ProjectRefs {
  keys: string[];
  megapixels: number;
}

/** The project's reference photos, in position order, with their real megapixels. */
export async function loadProjectRefs(env: Env, projectId: string): Promise<ProjectRefs> {
  const rows = await env.DB.prepare(
    `SELECT r.r2_key, r.width, r.height FROM reference_use u
       JOIN reference r ON r.id = u.reference_id
      WHERE u.owner_type = 'project' AND u.owner_id = ?1 ORDER BY u.position`,
  )
    .bind(projectId)
    .all<{ r2_key: string; width: number | null; height: number | null }>();
  return {
    keys: rows.results.map((r) => r.r2_key),
    megapixels: rows.results.reduce((s, r) => s + ((r.width ?? 0) * (r.height ?? 0)) / 1_000_000, 0),
  };
}

/** Shot-scoped reference photos, keyed by shot id. */
export async function loadShotRefs(
  env: Env,
  shotIds: string[],
): Promise<Map<string, ProjectRefs>> {
  const out = new Map<string, ProjectRefs>();
  if (!shotIds.length) return out;
  const marks = shotIds.map((_, i) => `?${i + 1}`).join(',');
  const rows = await env.DB.prepare(
    `SELECT u.owner_id, r.r2_key, r.width, r.height FROM reference_use u
       JOIN reference r ON r.id = u.reference_id
      WHERE u.owner_type = 'shot' AND u.owner_id IN (${marks}) ORDER BY u.position`,
  )
    .bind(...shotIds)
    .all<{ owner_id: string; r2_key: string; width: number | null; height: number | null }>();
  for (const r of rows.results) {
    const cur = out.get(r.owner_id) ?? { keys: [], megapixels: 0 };
    cur.keys.push(r.r2_key);
    cur.megapixels += ((r.width ?? 0) * (r.height ?? 0)) / 1_000_000;
    out.set(r.owner_id, cur);
  }
  return out;
}

/**
 * Character chaining: `{shot N}` in a prompt pulls shot N's PICKED take into this
 * shot as a leading reference image, so the same character carries across shots.
 */
export const CHAIN_TOKEN = /\{\s*shot\s+(\d+)\s*\}/gi;

interface ChainResult {
  /** The idea with every token rewritten to name its reference image. */
  prompt: string;
  /** art_key (RAW unbranded output) of each chained pick, first-appearance order. */
  refKeys: string[];
  megapixels: number;
}

async function resolveChain(
  env: Env,
  shot: ShotRow,
  projectId: string,
  /** Refs that follow the chain refs in the cell's list (shot uploads + project refs). */
  trailingRefCount: number,
): Promise<ChainResult> {
  const positions: number[] = [];
  for (const m of shot.prompt.matchAll(CHAIN_TOKEN)) {
    const n = Number(m[1]);
    if (!positions.includes(n)) positions.push(n);
  }
  if (!positions.length)
    return { prompt: shot.prompt, refKeys: [], megapixels: 0 };

  // Resolve against the WHOLE project — a re-shoot of shot 3 must still find shot 1.
  const all = await env.DB.prepare(
    `SELECT position, picked_take_id FROM shot
      WHERE project_id = ?1 AND deleted_at IS NULL`,
  )
    .bind(projectId)
    .all<{ position: number; picked_take_id: string | null }>();
  const byPos = new Map(all.results.map((s) => [s.position, s]));

  const refKeys: string[] = [];
  let megapixels = 0;
  for (const n of positions) {
    if (n === shot.position)
      throw new Error(`Shot ${shot.position} chains {shot ${n}} — a shot cannot chain itself.`);
    const target = byPos.get(n);
    if (!target) throw new Error(`Shot ${shot.position} chains {shot ${n}}, but there is no shot ${n}.`);
    if (!target.picked_take_id)
      throw new Error(
        `Shot ${shot.position} chains {shot ${n}}, but shot ${n} has no picked take yet — pick one first.`,
      );
    const take = await env.DB.prepare(`SELECT art_key, width, height FROM take WHERE id = ?1`)
      .bind(target.picked_take_id)
      .first<{ art_key: string | null; width: number | null; height: number | null }>();
    if (!take?.art_key)
      throw new Error(
        `Shot ${shot.position} chains {shot ${n}}, but shot ${n}'s picked take has no stored image.`,
      );
    refKeys.push(take.art_key);
    megapixels += ((take.width ?? 0) * (take.height ?? 0)) / 1_000_000;
  }

  const soleRef = refKeys.length === 1 && trailingRefCount === 0;
  const phrase = (idx: number) =>
    soleRef ? 'the character from the reference image' : `the character from reference image ${idx}`;
  const prompt =
    shot.prompt.replace(CHAIN_TOKEN, (_, d: string) => phrase(positions.indexOf(Number(d)) + 1)) +
    '\n\n' +
    positions
      .map((_, i) =>
        soleRef
          ? 'The reference image shows a recurring character from this series — render the exact same character: same face, same hair, same build, same wardrobe.'
          : `Reference image ${i + 1} shows a recurring character from this series — render the exact same character: same face, same hair, same build, same wardrobe.`,
      )
      .join('\n');
  return { prompt, refKeys, megapixels };
}

export interface CreateRunOpts {
  teamId: string;
  userId: string;
  project: ProjectRow;
  /** The style SET: every shot renders once per style (overrides render only theirs). */
  styles: StyleRow[];
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
  if (!o.styles.length) throw new Error('the project has no styles selected');

  const projectRefs = await loadProjectRefs(env, o.project.id);
  const shotRefs = await loadShotRefs(env, o.shots.map((s) => s.id));

  // Per-shot style overrides: fetch the overriding rows once, keyed by id.
  const overrideIds = [...new Set(o.shots.map((s) => s.style_override_id).filter(Boolean))] as string[];
  const overrides = new Map<string, StyleRow>();
  for (const id of overrideIds) {
    const row = await env.DB.prepare(`SELECT * FROM style WHERE id = ?1`).bind(id).first<StyleRow>();
    if (row) overrides.set(id, row);
  }

  // The cell event correlates takes by style SLUG — refuse an ambiguous run.
  const slugOwner = new Map<string, string>();
  for (const s of [...o.styles, ...overrides.values()]) {
    const prior = slugOwner.get(s.slug);
    if (prior && prior !== s.id)
      throw new Error(`two styles in this run share the slug "${s.slug}" — rename one first`);
    slugOwner.set(s.slug, s.id);
  }

  const styleCache = new Map<string, Style>();
  const asStyle = (row: StyleRow): Style => {
    const hit = styleCache.get(row.id);
    if (hit) return hit;
    const s = toStyle(row);
    styleCache.set(row.id, s);
    return s;
  };

  // Resolve each shot fully first: chaining, refs, the style set it renders in.
  interface ShotPlan {
    shot: ShotRow;
    /** The idea with {shot N} tokens rewritten; this is what the seam carries. */
    idea: string;
    /** Chain art first, then shot uploads — they lead the cell's ref list. */
    ideaRefKeys: string[];
    hasRefs: boolean;
    megapixels: number;
    styleRows: StyleRow[];
    overrideRow?: StyleRow;
  }
  const plans: ShotPlan[] = [];
  for (const shot of o.shots) {
    const sRefs = shotRefs.get(shot.id) ?? { keys: [], megapixels: 0 };
    const chain = await resolveChain(
      env,
      shot,
      o.project.id,
      sRefs.keys.length + projectRefs.keys.length,
    );
    const overrideRow = shot.style_override_id ? overrides.get(shot.style_override_id) : undefined;
    plans.push({
      shot,
      idea: chain.prompt,
      ideaRefKeys: [...chain.refKeys, ...sRefs.keys],
      hasRefs: chain.refKeys.length + sRefs.keys.length + projectRefs.keys.length > 0,
      megapixels: chain.megapixels + sRefs.megapixels + projectRefs.megapixels,
      styleRows: overrideRow ? [overrideRow] : o.styles,
      overrideRow,
    });
  }

  const estimated = plans.reduce(
    (sum, p) =>
      sum + estimateMicros(o.models, o.project.tier, p.styleRows.length * o.iterations, p.megapixels),
    0,
  );

  const stmts = [
    env.DB.prepare(
      `INSERT INTO run (id, team_id, project_id, project_version, kind, status,
         estimated_micros, ref_megapixels, started_by, started_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?9, ?7, ?8)`,
    ).bind(runId, o.teamId, o.project.id, o.project.version, o.kind, estimated, o.userId, nowIso, projectRefs.megapixels),
  ];

  const ideas: SeamIdea[] = [];
  let firstTakeId: string | null = null;

  for (const p of plans) {
    // The take row records the composed prompt; the seam carries the RAW idea
    // (with chain tokens already rewritten — both sides compose the same string).
    ideas.push({
      shotId: p.shot.id,
      prompt: p.idea,
      style: p.overrideRow ? asStyle(p.overrideRow) : undefined,
      refKeys: p.ideaRefKeys.length ? p.ideaRefKeys : undefined,
      refRole: p.shot.ref_role ?? undefined,
    });
    const refRole = p.shot.ref_role ?? o.project.ref_role ?? undefined;

    for (const styleRow of p.styleRows) {
      const prompt = compose({
        style: asStyle(styleRow),
        idea: p.idea,
        hasRefs: p.hasRefs,
        refRole,
        allowText: o.project.allow_text === 1,
        extra: o.project.extra ?? undefined,
      });
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
              p.shot.id,
              o.teamId,
              styleRow.id,
              spec.alias,
              spec.id,
              tier,
              iteration,
              prompt,
              JSON.stringify(input),
              `${runId}:${p.shot.id}:${styleRow.id}:${spec.alias}:${iteration}`,
              lease,
              nowIso,
            ),
          );
        }
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
    // The project's kit rides along so take CARDS carry the team's band, not
    // the engine's baked-in house brand. Absent kit = engine falls back.
    const kit = await env.DB.prepare(`SELECT config, mark_key FROM brand_kit WHERE id = ?1`)
      .bind(o.project.brand_kit_id)
      .first<{ config: string; mark_key: string | null }>();
    const payload: EngineRunRequest = {
      runId,
      r2Prefix: `teams/${o.teamId}/runs/${runId}`,
      ideas,
      style: asStyle(o.styles[0]!),
      styles: o.styles.map(asStyle),
      models: o.models,
      iterations: o.iterations,
      tier: o.project.tier ?? undefined,
      refKeys: projectRefs.keys,
      title: o.project.title ?? 'Mate *Wish* Key',
      kicker: o.project.kicker ?? undefined,
      tagline: o.project.tagline ?? undefined,
      allowText: o.project.allow_text === 1,
      refRole: o.project.ref_role ?? undefined,
      extra: o.project.extra ?? undefined,
      brand: kit ? JSON.parse(kit.config) : undefined,
      markKey: kit?.mark_key ?? undefined,
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
