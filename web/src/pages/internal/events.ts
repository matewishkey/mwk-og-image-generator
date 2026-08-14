/**
 * Engine -> web callbacks, HMAC-verified. Every status write is conditional and
 * checked by rows-affected: the engine callback and the lease sweeper have no
 * ordering guarantee, and a stale transition must not win.
 */

import type { APIRoute } from 'astro';
import { seamVerify, type EngineEvent } from '../../../../src/seam.ts';
import { ENV } from '../../lib/runtime';
import { ulid } from '../../lib/ulid';

function classifyError(msg: string): string {
  if (/^upload:/.test(msg)) return 'render';
  if (/moderat|flagged|content policy|sensitive|safety/i.test(msg)) return 'moderation';
  if (/\b429\b|too many requests|throttled/i.test(msg)) return 'throttled';
  if (/prediction interrupted|code: PA\b|\b5\d\d\b/i.test(msg)) return 'interrupted';
  if (/\b422\b|invalid|unknown field|input/i.test(msg)) return 'bad_input';
  return 'unknown';
}

export const POST: APIRoute = async (ctx) => {
  const env = ENV;
  const body = await ctx.request.text();
  if (!(await seamVerify(env.SEAM_SECRET, ctx.request.headers, body))) {
    return new Response('bad signature', { status: 401 });
  }
  const event = JSON.parse(body) as EngineEvent;
  const nowIso = new Date().toISOString();

  if (event.kind === 'run-started') {
    const lease = new Date(Date.now() + 30 * 60_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE run SET status='running' WHERE id=?1 AND status='queued'`).bind(
        event.runId,
      ),
      env.DB.prepare(
        `UPDATE take SET status='running', lease_expires_at=?1 WHERE run_id=?2 AND status='queued'`,
      ).bind(lease, event.runId),
    ]);
    return Response.json({ ok: true });
  }

  if (event.kind === 'cell') {
    const take = await env.DB.prepare(
      `SELECT id, team_id FROM take
        WHERE run_id=?1 AND shot_id=?2 AND model_alias=?3 AND iteration=?4`,
    )
      .bind(event.runId, event.shotId, event.modelAlias, event.iteration)
      .first<{ id: string; team_id: string }>();
    if (!take) return new Response('unknown take', { status: 404 });

    const costMicros = Math.round(event.costUsd * 1_000_000);
    const stmts: D1PreparedStatement[] = [];

    if (event.ok) {
      stmts.push(
        env.DB.prepare(
          `UPDATE take SET status='succeeded', prompt=?1, art_key=?2, card_key=?3,
             width=?4, height=?5, cost_micros=?6, duration_ms=?7, attempt_count=?8,
             finished_at=?9, thumb_key=?11
           WHERE id=?10 AND status IN ('queued','running','rendering')`,
        ).bind(
          event.prompt,
          event.artKey ?? null,
          event.cardKey ?? null,
          event.width ?? null,
          event.height ?? null,
          costMicros,
          Math.round(event.seconds * 1000),
          (event.retries ?? 0) + 1,
          nowIso,
          take.id,
          event.thumbKey ?? null,
        ),
      );
    } else {
      const kind = classifyError(event.error ?? '');
      stmts.push(
        env.DB.prepare(
          `UPDATE take SET status='failed', prompt=?1, error_kind=?2, error_message=?3,
             cost_micros=?4, duration_ms=?5, attempt_count=?6, finished_at=?7
           WHERE id=?8 AND status IN ('queued','running','rendering')`,
        ).bind(
          event.prompt,
          kind,
          event.error ?? 'unknown',
          costMicros,
          Math.round(event.seconds * 1000),
          (event.retries ?? 0) + 1,
          nowIso,
          take.id,
        ),
      );
    }

    // The ledger row rides on cost, not on success: a take that was billed and then
    // failed at the band or the upload still spent the money. UNIQUE(take_id) makes
    // a replayed event write it exactly once.
    if (costMicros > 0) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO charge (id, team_id, run_id, take_id, model_alias, model_id,
             tier, usd_micros, unit_price_micros, occurred_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)`,
        ).bind(
          ulid(),
          take.team_id,
          event.runId,
          take.id,
          event.modelAlias,
          event.modelId,
          event.tier,
          costMicros,
          nowIso,
        ),
      );
    }

    await env.DB.batch(stmts);
    return Response.json({ ok: true });
  }

  if (event.kind === 'run-finished') {
    const failed = await env.DB.prepare(
      `SELECT count(*) AS n,
              sum(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS ok
         FROM take WHERE run_id=?1`,
    )
      .bind(event.runId)
      .first<{ n: number; ok: number }>();
    const status = failed && failed.ok > 0 ? 'done' : 'failed';
    await env.DB.prepare(
      `UPDATE run SET status=?1, finished_at=?2 WHERE id=?3 AND status IN ('queued','running')`,
    )
      .bind(status, nowIso, event.runId)
      .run();
    return Response.json({ ok: true });
  }

  return new Response('unknown event', { status: 400 });
};
