-- 0003_designs — step 2 "pick, arrange, download".

ALTER TABLE take ADD COLUMN hidden_at TEXT;   -- half-cent models bury a sheet in a week
ALTER TABLE take ADD COLUMN thumb_key TEXT;   -- 640w webp beside the full card

-- Target sizes and safe areas. Seeded from the published media kit at
-- matewishkey.com/media (fetched 2026-08-14); the YouTube banner safe area is
-- YouTube's own 1546x423 minimum-visible box.
CREATE TABLE format (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  safe_w INTEGER,
  safe_h INTEGER,
  safe_anchor TEXT
);

INSERT INTO format (id, slug, name, width, height, safe_w, safe_h, safe_anchor) VALUES
  ('fmt_og',            'og',                'OG / share image',            1200,  630, NULL, NULL, NULL),
  ('fmt_article',       'article-header',    'Article header',              1600,  900, NULL, NULL, NULL),
  ('fmt_yt_thumb',      'youtube-thumb',     'YouTube thumbnail',           1280,  720, NULL, NULL, NULL),
  ('fmt_yt_banner',     'youtube-banner',    'YouTube channel banner',      2560, 1440, 1546,  423, 'center'),
  ('fmt_fb_cover',      'facebook-cover',    'Facebook page cover',         1640,  624, NULL, NULL, NULL),
  ('fmt_li_profile',    'linkedin-profile',  'LinkedIn profile background', 1584,  396, NULL, NULL, NULL),
  ('fmt_li_company',    'linkedin-company',  'LinkedIn company cover',      1128,  191, NULL, NULL, NULL),
  ('fmt_twitch_banner', 'twitch-banner',     'Twitch profile banner',       1200,  480, NULL, NULL, NULL),
  ('fmt_twitch_wide',   'twitch-wide',       'Twitch banner, wide',         1920,  480, NULL, NULL, NULL),
  ('fmt_reddit_banner', 'reddit-banner',     'Reddit community banner',     1920,  384, NULL, NULL, NULL),
  ('fmt_story',         'story',             'Story / reel cover',          1080, 1920, NULL, NULL, NULL),
  ('fmt_offline',       'offline-screen',    'Stream offline screen',       1920, 1080, NULL, NULL, NULL);

CREATE TABLE collection (      -- one design across several formats
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  name TEXT,
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__.___Z')
);

-- A finished, rendered asset. Cheap and immutable: a change writes a new row and
-- supersedes the old, so every version ever made is still there for $0.00.
CREATE TABLE design (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  collection_id TEXT REFERENCES collection(id),
  layout_id TEXT NOT NULL REFERENCES layout(id),
  brand_kit_id TEXT NOT NULL REFERENCES brand_kit(id),
  format_id TEXT NOT NULL REFERENCES format(id),
  title TEXT, kicker TEXT, tagline TEXT, label_prefix TEXT,
  r2_key TEXT,
  thumb_key TEXT,
  width INTEGER, height INTEGER,
  status TEXT NOT NULL DEFAULT 'succeeded' CHECK (status IN ('succeeded','failed')),
  error_message TEXT,
  superseded_by_id TEXT REFERENCES design(id),
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__.___Z')
);
CREATE INDEX design_by_proj ON design (project_id, created_at DESC);

CREATE TABLE design_panel (
  design_id TEXT NOT NULL REFERENCES design(id),
  position INTEGER NOT NULL,
  -- A panel references an IMAGE, of which a take is one kind. Requiring a take would
  -- make "put the band on this screenshot" structurally impossible.
  source_kind TEXT NOT NULL CHECK (source_kind IN ('take','reference')),
  take_id TEXT REFERENCES take(id),
  reference_id TEXT REFERENCES reference(id),
  label TEXT,
  CHECK ((take_id IS NOT NULL) <> (reference_id IS NOT NULL)),
  PRIMARY KEY (design_id, position)
);

-- House layouts: the presets proven by the 20-variant prototype. config is the
-- LayoutConfigSchema shape in src/seam.ts; panel counts come from the archetype.
INSERT INTO layout (id, team_id, slug, name, config, created_at, updated_at) VALUES
  ('lay_hero_band',    'seed_team_house', 'hero-band',        'Hero, band bottom',
   '{"archetype":"hero","seam":"butt","lockup":"bottom","labels":false}',
   '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('lay_hero_rail',    'seed_team_house', 'hero-rail',        'Hero, vertical rail',
   '{"archetype":"hero","seam":"butt","lockup":"rail","labels":false}',
   '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('lay_hero_corner',  'seed_team_house', 'hero-corner',      'Hero, corner lockup',
   '{"archetype":"hero","seam":"butt","lockup":"corner","labels":false}',
   '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('lay_diptych',      'seed_team_house', 'diptych-feather',  'Diptych, feathered',
   '{"archetype":"diptych","seam":"feather","lockup":"bottom"}',
   '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('lay_stack',        'seed_team_house', 'stack-feather',    'Stack, feathered',
   '{"archetype":"stack","seam":"feather","lockup":"bottom"}',
   '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('lay_triptych',     'seed_team_house', 'triptych-feather', 'Triptych, feathered',
   '{"archetype":"triptych","seam":"feather","lockup":"bottom"}',
   '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('lay_mosaic',       'seed_team_house', 'mosaic-feather',   'Mosaic, feathered',
   '{"archetype":"mosaic","seam":"feather","lockup":"bottom"}',
   '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('lay_mosaic_inset', 'seed_team_house', 'mosaic-inset',     'Mosaic, inset lockup',
   '{"archetype":"mosaic","seam":"feather","lockup":"inset"}',
   '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('lay_quad',         'seed_team_house', 'quad-hairline',    'Quad, hairline seams',
   '{"archetype":"quad","seam":"hairline","lockup":"bottom"}',
   '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
  ('lay_filmstrip',    'seed_team_house', 'filmstrip-feather','Filmstrip, feathered',
   '{"archetype":"filmstrip","seam":"feather","lockup":"inset"}',
   '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
