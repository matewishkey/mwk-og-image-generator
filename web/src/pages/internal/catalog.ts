/**
 * Nightly catalog rows from the engine's sync — observed facts only, append-only.
 * PRICES LIVE IN src/models.ts; this table records what Replicate said.
 */

import type { APIRoute } from 'astro';
import { seamVerify } from '../../../../src/seam.ts';
import { ENV } from '../../lib/runtime';

interface CatalogRow {
  modelId: string;
  alias: string;
  modality: string;
  runCount?: number | null;
  modelUpdatedAt?: string | null;
  inputFingerprint?: string | null;
  error?: string;
}

export const POST: APIRoute = async (ctx) => {
  const env = ENV;
  const body = await ctx.request.text();
  if (!(await seamVerify(env.SEAM_SECRET, ctx.request.headers, body))) {
    return new Response('bad signature', { status: 401 });
  }
  const { syncedAt, rows } = JSON.parse(body) as { syncedAt: string; rows: CatalogRow[] };

  const stmts = rows.map((r) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO model_catalog
         (model_id, alias, modality, run_count, model_updated_at, input_fingerprint, notes, synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      r.modelId,
      r.alias,
      r.modality,
      r.runCount ?? null,
      r.modelUpdatedAt ?? null,
      r.inputFingerprint ?? null,
      r.error ?? null,
      syncedAt,
    ),
  );
  if (stmts.length) await env.DB.batch(stmts);
  return Response.json({ ok: true, rows: rows.length });
};
