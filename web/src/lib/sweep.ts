/**
 * Lease sweeper, v1 form: runs opportunistically wherever takes are being watched
 * (contact sheet load + its poll endpoint). A dead engine leaves takes 'running';
 * the lease turns that into a visible 'abandoned' failure instead of silence.
 * Hardening replaces this with a cron + prediction_id reconciliation.
 */

export async function sweepLeases(env: Env): Promise<void> {
  const nowIso = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE take SET status='failed', error_kind='abandoned',
              error_message='engine lease expired', finished_at=?1
        WHERE status IN ('queued','running','rendering') AND lease_expires_at < ?1`,
    ).bind(nowIso),
    env.DB.prepare(
      `UPDATE run SET status='failed', finished_at=?1
        WHERE status IN ('queued','running')
          AND NOT EXISTS (SELECT 1 FROM take t WHERE t.run_id = run.id
                           AND t.status IN ('queued','running','rendering'))
          AND EXISTS (SELECT 1 FROM take t WHERE t.run_id = run.id
                       AND t.error_kind = 'abandoned')`,
    ).bind(nowIso),
  ]);
}
