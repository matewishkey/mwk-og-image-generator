-- Round 3 multi-style: a shot renders once PER STYLE within a run, so the take
-- identity must include the style. (Idempotency keys already do.)
DROP INDEX take_identity;
CREATE UNIQUE INDEX take_identity ON take (run_id, shot_id, style_id, model_alias, iteration);
