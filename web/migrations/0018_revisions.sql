-- 0018_revisions — a design row is a REVISION: template + slot assignments +
-- words. panels_hash fingerprints the slot assignments so the supersede match
-- can include them: an identical re-render still retires its predecessor, but
-- a revision with different pictures or words COEXISTS beside the old one.
-- Old rows keep NULL (their hash was never computed); they are simply never
-- superseded by new renders, which only adds rows to the Results list.
ALTER TABLE design ADD COLUMN panels_hash TEXT;
