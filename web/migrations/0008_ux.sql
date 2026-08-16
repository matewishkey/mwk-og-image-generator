-- 0008_ux — the 2026-08-16 studio UX round.
--
-- shot.style_override_id: a shot may render in its own style; NULL means the
--   project's default style. Recorded per take via take.style_id as before.
-- reference.name: a friendly, addressable name for a media-library image so a
--   conversation can say "the crab photo" instead of an id. NULL falls back to
--   the filename.
-- design.effect: the finish-pass preset burned into this design (grain,
--   vignette, glow, fade); NULL = none. Provenance, not configuration — a
--   design is append-only and keeps the effect it was rendered with.

ALTER TABLE shot ADD COLUMN style_override_id TEXT REFERENCES style(id);
ALTER TABLE reference ADD COLUMN name TEXT;
ALTER TABLE design ADD COLUMN effect TEXT;
