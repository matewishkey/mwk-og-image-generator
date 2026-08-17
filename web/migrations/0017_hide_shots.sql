-- 0017_hide_shots — a shot can be hidden from the design inventory without
-- being deleted: takes, picks and history stay; it just stops feeding designs
-- and template previews. The shots page shows it dimmed with an unhide toggle.
ALTER TABLE shot ADD COLUMN hidden_at TEXT;
