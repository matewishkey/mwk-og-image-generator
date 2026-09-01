# mwk-media recipes — the single source

Named patterns; mate says the name (plus a style and a subject), the skill
expands it. This file is the sole definition source. (It used to be imported
at build time by the studio's `/guide` page; that site was decommissioned on
2026-09-01, so there is no longer a second surface to keep in sync.)

## story-4 — "4 shots cartoon story"
Four sequential shots telling one story. Shot 1 establishes the character;
shots 2–4 reference `{shot 1}` so the character stays consistent (run shot 1
first, pick, then run the rest). One style; iterations 2.

## stills-4 — "4 still pictures"
Four independent shots, no chaining, same style set — a mood board, not a
narrative. Run all at once.

## single-hero — "one strong image"
One shot, 3–4 styles, iterations 2–3 on cheap models, then finish the winner
on gpt2. The default thumbnail recipe.

## quick-card — "brand this image"
No project: `studio quick --image <file> --template <slug>` → branded card.

## animation — "clip plus stills"
A video model clip (sora2 default; veo31 when it needs sound quality) plus
stills-4 from frames/style for the static placements. Video burns the same
brand band via src/video.ts — never a second band.
