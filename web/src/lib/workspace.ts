/**
 * The workspace payload: everything the project workspace island renders about
 * shots and takes. One builder shared by the page shell (initial state) and
 * GET /api/projects/[slug]/takes (the poll) — the two can never drift.
 */

import type { ProjectBundle } from './data';

export const LIVE_STATUSES = ['queued', 'running', 'rendering'];

export interface WsTake {
  id: string;
  shot_id: string;
  style_id: string;
  model_alias: string;
  tier: string;
  iteration: number;
  status: string;
  art_key: string | null;
  art_thumb_key: string | null;
  card_key: string | null;
  thumb_key: string | null;
  cost_micros: number;
  duration_ms: number | null;
  error_kind: string | null;
  error_message: string | null;
  created_at: string;
  hidden_at: string | null;
  picked: boolean;
  superseded: boolean;
  hidden: boolean;
  /** Speakable per-shot number ("shot 1, take 3" = 1.3). Assigned once by
   * (created_at, id) order over ALL of the shot's takes and never renumbered —
   * hidden and superseded takes keep theirs, so a spoken "1.3" stays valid. */
  ordinal: number;
}

export interface WsRun {
  id: string;
  kind: string;
  status: string;
  estimated_micros: number;
  started_at: string;
  finished_at: string | null;
}

export interface WsShot {
  id: string;
  position: number;
  label: string | null;
  prompt: string;
  style_override_id: string | null;
  ref_role: string | null;
  picked_take_id: string | null;
}

export interface TakesPayload {
  runs: WsRun[];
  takes: WsTake[];
  shots: WsShot[];
  spentMicros: number;
  live: boolean;
  url: string;
}

export async function takesPayload(env: Env, bundle: ProjectBundle): Promise<TakesPayload> {
  const [runs, takes, spent] = await Promise.all([
    env.DB.prepare(
      `SELECT id, kind, status, estimated_micros, started_at, finished_at
         FROM run WHERE project_id = ?1 ORDER BY started_at DESC`,
    )
      .bind(bundle.project.id)
      .all<WsRun>(),
    env.DB.prepare(
      `SELECT t.id, t.shot_id, t.style_id, t.model_alias, t.tier, t.iteration, t.status,
              t.art_key, t.art_thumb_key, t.card_key, t.thumb_key, t.cost_micros, t.duration_ms,
              t.error_kind, t.error_message, t.created_at, t.hidden_at,
              (t.id = sh.picked_take_id) AS picked,
              (t.superseded_by_id IS NOT NULL) AS superseded
         FROM take t JOIN run r ON r.id = t.run_id JOIN shot sh ON sh.id = t.shot_id
        WHERE r.project_id = ?1
        ORDER BY sh.position, t.model_alias, t.iteration, t.created_at`,
    )
      .bind(bundle.project.id)
      .all<Omit<WsTake, 'picked' | 'superseded' | 'hidden'> & { picked: number; superseded: number }>(),
    env.DB.prepare(
      `SELECT coalesce(sum(c.usd_micros), 0) AS total FROM charge c
         JOIN run r ON r.id = c.run_id WHERE r.project_id = ?1`,
    )
      .bind(bundle.project.id)
      .first<{ total: number }>(),
  ]);

  // Ordinals: per-shot creation order. Derived, not stored — creation order is
  // immutable, so recomputing always yields the same numbers.
  const ordinals = new Map<string, number>();
  const byShot = new Map<string, { id: string; created_at: string }[]>();
  for (const t of takes.results) {
    (byShot.get(t.shot_id) ?? byShot.set(t.shot_id, []).get(t.shot_id)!).push(t);
  }
  for (const group of byShot.values()) {
    group.sort((a, b) =>
      a.created_at === b.created_at
        ? a.id.localeCompare(b.id)
        : a.created_at.localeCompare(b.created_at),
    );
    group.forEach((t, i) => ordinals.set(t.id, i + 1));
  }

  return {
    runs: runs.results,
    takes: takes.results.map((t) => ({
      ...t,
      picked: !!t.picked,
      superseded: !!t.superseded,
      hidden: !!t.hidden_at,
      ordinal: ordinals.get(t.id)!,
    })),
    shots: bundle.shots.map((s) => ({
      id: s.id,
      position: s.position,
      label: s.label,
      prompt: s.prompt,
      style_override_id: s.style_override_id,
      ref_role: s.ref_role,
      picked_take_id: s.picked_take_id,
    })),
    spentMicros: spent?.total ?? 0,
    live: takes.results.some((t) => LIVE_STATUSES.includes(t.status)),
    url: `/projects/${bundle.project.slug}/shots`,
  };
}
