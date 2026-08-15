-- 0006_pack — a shareable, unauthenticated, token-gated bundle of the whole concept.
ALTER TABLE project ADD COLUMN pack_token TEXT;
CREATE UNIQUE INDEX project_pack_token ON project (pack_token) WHERE pack_token IS NOT NULL;
