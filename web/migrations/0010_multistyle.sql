-- Round 3: a project renders every shot in a SET of styles, not one.
-- default_style_id stays: it is the primary style (previews, proofs, fallback).
CREATE TABLE project_style (
  project_id TEXT NOT NULL REFERENCES project(id),
  style_id   TEXT NOT NULL REFERENCES style(id),
  position   INTEGER NOT NULL,
  PRIMARY KEY (project_id, style_id)
);

-- Every existing project keeps exactly its current style.
INSERT INTO project_style (project_id, style_id, position)
  SELECT id, default_style_id, 1 FROM project;

-- Per-shot "who is the reference person"; falls back to project.ref_role.
ALTER TABLE shot ADD COLUMN ref_role TEXT;
