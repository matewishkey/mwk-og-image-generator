-- 0005_invite — deferred out of 0001 (step 1 was identity-lite); lands with teams.
CREATE TABLE invite (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id),
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  token_hash TEXT NOT NULL UNIQUE,   -- SHA-256; the raw token exists only in the email
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__.___Z'),
  expires_at TEXT NOT NULL,          -- 7 days
  accepted_at TEXT,
  accepted_user_id TEXT REFERENCES user(id)
);
