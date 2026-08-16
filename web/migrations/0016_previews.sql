-- Round 5: cached $0.00 composite previews — the layout gallery and the
-- per-style OG cards. A preview is a CACHE, not history: one row per
-- (project, kind, ref), overwritten in place. The R2 key carries the input
-- hash so /img's immutable cache header stays honest (new inputs = new URL).
CREATE TABLE preview (
  project_id TEXT NOT NULL REFERENCES project(id),
  kind TEXT NOT NULL CHECK (kind IN ('layout', 'style')),
  ref_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, kind, ref_id)
);
