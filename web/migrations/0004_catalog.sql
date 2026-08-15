-- 0004_catalog — observed model facts, append-only. PRICES LIVE IN src/models.ts.
CREATE TABLE model_catalog (
  model_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  modality TEXT NOT NULL,
  run_count INTEGER,
  model_updated_at TEXT,
  input_fingerprint TEXT,      -- hash of the input schema; a change is a diff to review
  notes TEXT,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (model_id, synced_at)   -- append-only; never overwrite a historical row
);
