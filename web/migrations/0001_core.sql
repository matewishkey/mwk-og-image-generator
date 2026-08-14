-- 0001_core — step 1 "first picture".
--
-- Conventions (see the phase-2 plan):
--   ids            ULID TEXT
--   money          INTEGER micros, never REAL
--   timestamps     ISO-8601 UTC as produced by Date.toISOString(); the CHECK is a
--                  backstop against a "+10:00" offset silently corrupting lexicographic
--                  ordering, not a full parser.
--   house rows     belong to the house TEAM (team.kind='house'), never team_id NULL —
--                  SQLite treats NULLs as distinct, so a nullable team_id defeats
--                  UNIQUE(team_id, slug). Verified against sqlite3.
--   nothing that has run is ever mutated — a re-roll is a NEW take.

-- ---------------------------------------------------------------- identity

CREATE TABLE user (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- else Foo@bar.com becomes a second account
  name TEXT,
  deactivated_at TEXT,
  created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__.___Z'),
  last_login_at TEXT
);

CREATE TABLE team (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','house')),
  monthly_cap_micros INTEGER,                 -- advisory: alerts, does not block
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__.___Z')
);

CREATE TABLE team_member (
  team_id TEXT NOT NULL REFERENCES team(id),
  user_id TEXT NOT NULL REFERENCES user(id),
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_member_by_user ON team_member (user_id);

CREATE TABLE login_token (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  token_hash TEXT NOT NULL UNIQUE,            -- SHA-256; the raw token exists only in the email
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                   -- 15 minutes
  consumed_at TEXT,
  request_ip TEXT
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,                        -- SHA-256 of the cookie value
  user_id TEXT NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                   -- 30 days, sliding
  last_seen_at TEXT,
  user_agent TEXT
);

-- ---------------------------------------------------------------- libraries

-- Mirrors StyleSchema in src/style.ts field for field: a styles/*.yaml file and a
-- style row are the same object in two containers.
CREATE TABLE style (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id),  -- house rows belong to the house team
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  look TEXT NOT NULL,                         -- medium, lighting, palette, camera
  subject TEXT NOT NULL DEFAULT '',           -- how a real person is rendered
  avoid TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  origin TEXT NOT NULL DEFAULT 'hand',
  forked_from_id TEXT REFERENCES style(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES user(id),
  created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__.___Z'),
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
-- Partial: an archived slug must not hold the name forever. Verified: without the
-- WHERE clause, re-creating an archived slug raises UNIQUE.
CREATE UNIQUE INDEX style_slug ON style (team_id, slug) WHERE archived_at IS NULL;

CREATE TABLE brand_kit (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,                       -- json, exactly the BrandConfig shape
  mark_key TEXT,                              -- R2: the logo mark
  default_title TEXT,
  default_kicker TEXT,
  default_tagline TEXT,
  forked_from_id TEXT REFERENCES brand_kit(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__.___Z'),
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX brand_kit_slug ON brand_kit (team_id, slug) WHERE archived_at IS NULL;

-- Layout rows arrive in step 2; the table exists now because project references it.
CREATE TABLE layout (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,                       -- json: archetype, grid, seam, modules, lockup
  brief TEXT,                                 -- the request that generated it, if generated
  generated_by TEXT,                          -- model id, or NULL when hand-made
  forked_from_id TEXT REFERENCES layout(id),
  created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__.___Z'),
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX layout_slug ON layout (team_id, slug) WHERE archived_at IS NULL;

-- Content-addressed: one photo stored once per team. width/height are not decoration —
-- the FLUX 2 family bills per input megapixel, so estimates need real dimensions.
CREATE TABLE reference (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id),
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  bytes INTEGER,
  created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__.___Z'),
  UNIQUE (team_id, sha256)
);

CREATE TABLE reference_use (
  reference_id TEXT NOT NULL REFERENCES reference(id),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('style','project','shot')),
  owner_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (owner_type, owner_id, position)
);

-- ---------------------------------------------------------------- project

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- The DEFAULT style. A run may sweep several, exactly as the CLI does
  -- (run.ts: ideas x styles x models x iterations); each take records the style
  -- that produced it.
  default_style_id TEXT NOT NULL REFERENCES style(id),
  brand_kit_id TEXT NOT NULL REFERENCES brand_kit(id),
  layout_id TEXT REFERENCES layout(id),
  models TEXT NOT NULL,                       -- json array of aliases
  iterations INTEGER NOT NULL DEFAULT 1,
  tier TEXT,
  allow_text INTEGER NOT NULL DEFAULT 0,
  extra TEXT,
  ref_role TEXT,
  title TEXT, kicker TEXT, tagline TEXT, label_prefix TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  forked_from_id TEXT REFERENCES project(id),
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__.___Z'),
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX project_slug ON project (team_id, slug) WHERE archived_at IS NULL;

CREATE TABLE shot (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  position INTEGER NOT NULL,
  label TEXT,
  prompt TEXT NOT NULL,                       -- what is happening. never a medium or a palette
  models_override TEXT,
  iterations_override INTEGER,
  allow_text_override INTEGER,
  extra_override TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__.___Z'),
  updated_at TEXT NOT NULL,
  deleted_at TEXT,                            -- soft: an old run still references it
  -- The Pick lives HERE, not on the take: one-per-shot holds by cardinality,
  -- repicking is one idempotent UPDATE, and the immutable take table stays immutable.
  picked_take_id TEXT REFERENCES take(id)
);
-- Partial: a soft-deleted shot must not hold its slot forever.
CREATE UNIQUE INDEX shot_slot ON shot (project_id, position) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- runs and money

CREATE TABLE run (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  project_version INTEGER NOT NULL,           -- what the project looked like when this ran
  kind TEXT NOT NULL CHECK (kind IN ('full','shot','take','layout','export')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
  estimated_micros INTEGER NOT NULL,          -- actual is DERIVED: SUM(charge.usd_micros)
  ref_megapixels REAL NOT NULL DEFAULT 0,
  started_by TEXT NOT NULL REFERENCES user(id),
  started_at TEXT NOT NULL CHECK (started_at LIKE '____-__-__T__:__:__.___Z'),
  finished_at TEXT,
  note TEXT
);
CREATE INDEX run_by_team ON run (team_id, started_at DESC);
CREATE INDEX run_by_project ON run (project_id, started_at DESC);

-- ONE image. Immutable once it succeeds; a re-roll is a NEW take.
CREATE TABLE take (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  shot_id TEXT NOT NULL REFERENCES shot(id),
  team_id TEXT NOT NULL REFERENCES team(id),
  style_id TEXT NOT NULL REFERENCES style(id),  -- the style that produced this take
  model_alias TEXT NOT NULL,
  model_id TEXT NOT NULL,                     -- pinned; survives a registry edit
  tier TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  seed INTEGER,
  status TEXT NOT NULL CHECK (status IN
    ('queued','running','rendering','succeeded','failed','cancelled')),
  prompt TEXT NOT NULL,                       -- the EXACT composed string sent to the model
  input_json TEXT NOT NULL,                   -- what buildInput() produced, refs elided
  art_key TEXT,                               -- R2: raw model output
  card_key TEXT,                              -- R2: the single branded card
  width INTEGER, height INTEGER,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  idempotency_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_kind TEXT,
  error_message TEXT,
  job_ref TEXT,                               -- engine run id in v1; workflow instance id later
  prediction_id TEXT,                         -- Replicate's id. NO per-image cost exists on it
  lease_expires_at TEXT NOT NULL,             -- a dead engine otherwise leaves 'running' forever
  superseded_by_id TEXT REFERENCES take(id),
  created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__.___Z'),
  finished_at TEXT
);
-- The natural key, enforced. Without UNIQUE, a replayed step that lost its write buys
-- a SECOND billed prediction, and nothing afterwards can tell which one was real.
CREATE UNIQUE INDEX take_identity   ON take (run_id, shot_id, model_alias, iteration);
CREATE UNIQUE INDEX take_idem       ON take (idempotency_key);
CREATE UNIQUE INDEX take_by_predict ON take (prediction_id) WHERE prediction_id IS NOT NULL;
CREATE INDEX take_by_shot ON take (shot_id, status, created_at DESC);
CREATE INDEX take_live    ON take (status) WHERE status IN ('queued','running','rendering');

-- One row per try. THE retry history: what Replicate asked for, and what we waited.
CREATE TABLE take_attempt (
  id TEXT PRIMARY KEY,
  take_id TEXT NOT NULL REFERENCES take(id),
  attempt_no INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','retry','fail')),
  error_kind TEXT,
  error_message TEXT,
  http_status INTEGER,
  retry_after_ms INTEGER,                     -- what Replicate ASKED for, not what we guessed
  waited_ms INTEGER,
  prediction_id TEXT,
  UNIQUE (take_id, attempt_no)
);

-- One row per billed take, written at the model-return boundary — NOT at 'succeeded'.
-- 'rendering' exists because the model is already billed; a take that returns and then
-- fails to render was still paid for and must have its ledger row.
CREATE TABLE charge (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id),
  run_id TEXT NOT NULL REFERENCES run(id),
  take_id TEXT NOT NULL REFERENCES take(id) UNIQUE,
  model_alias TEXT NOT NULL,
  model_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  usd_micros INTEGER NOT NULL,
  unit_price_micros INTEGER NOT NULL,
  occurred_at TEXT NOT NULL CHECK (occurred_at LIKE '____-__-__T__:__:__.___Z')
);
CREATE INDEX charge_by_team ON charge (team_id, occurred_at);
