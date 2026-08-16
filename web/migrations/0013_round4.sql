-- Round 4: honest thumbnails + themed designs.
-- art_thumb_key: 640w webp of the RAW art (shot-context grids; card thumbs stay
-- for design/pack contexts). Old takes keep NULL and fall back to art_key.
ALTER TABLE take ADD COLUMN art_thumb_key TEXT;

-- Which palette a design rendered with ('light' = the kit's colors,
-- 'dark' = colorsDark overlaid when the kit has one).
ALTER TABLE design ADD COLUMN theme TEXT NOT NULL DEFAULT 'light';
