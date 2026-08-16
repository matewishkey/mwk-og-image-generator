-- 0007_api_token — bearer tokens for the studio CLI. Same convention as
-- login_token: only the SHA-256 of the token is stored, never the value.
-- Accepted by the middleware on /api/* paths only.

CREATE TABLE api_token (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  name TEXT NOT NULL,                         -- e.g. 'studio-cli on devbox'
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__.___Z'),
  last_used_at TEXT,                          -- bumped at most hourly, like session
  revoked_at TEXT                             -- revoke = UPDATE, not DELETE
);
