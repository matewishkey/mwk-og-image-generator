# mwk-og-image-generator — dev notes

Public repo: `matewishkey/mwk-og-image-generator`. CLI that renders OG images from a style
plus a prompt across several Replicate models, then composites the brand band. `README.md`
is the user-facing doc — don't restate it here.

## The one idea to not break

**Style and prompt are independent axes.** A style is a look and must never mention a
subject or a scene; a prompt is what is happening and must never specify a medium or a
palette. If a style file starts describing an event, or a prompt starts describing
lighting, the whole grid collapses into one-off images and the tool stops being useful.
`src/prompt.ts` `compose()` is where the two meet, and it is the only place they should.

## Branding is composited, never generated

`src/brand.ts` draws the band with `sharp`. This is settled — it was chosen over a second
AI pass because a model cannot reproduce a logo or reliably render text. Two consequences
that look unrelated but are not:

- `FRAME_RULES` in `src/prompt.ts` tells every model to render no text and to keep the
  bottom fifth calm. That instruction exists *because* the band lands there. Change the
  band height in `brand/brand.json` and that sentence needs to change with it.
- `applyBrand()` crops with `position: sharp.strategy.attention`, not centre, so a face
  survives the 16:9 → 1.905:1 squeeze.

## Prices and schemas are scraped facts, not memory

Every slug, input field name and price in `src/models.ts` was read off the model's own
Replicate page. The input fields genuinely differ and guessing them produces a 422:

- `image_input` (array) — nano-banana-*, seedream-4
- `input_images` (array) — gpt-image-*
- `input_image` (**single string**) — flux-kontext-*. It gets one reference, never a list.
- `gpt-image-1.5` has no `16:9` in its aspect enum — only 1:1 / 3:2 / 2:3.
- Only flux-kontext accepts a `seed`. Do not add seed-based iteration to the others.

Re-read the schema before changing an input map:
`curl -sL https://replicate.com/<owner>/<name>/api/schema` — the JSON is inline in the page
under `"input": {"type": "object", "title": "Input"`.

`PRICES_VERIFIED_ON` is when the table was last checked. Never edit a price from memory,
and never quote one in a summary without re-reading the page.

Measured on the first real sweep (2026-08-13, 16/16 cells, $0.90, 1m55s wall): `gpt2` takes
35–64s per image, the other three 10–14s. So `gpt2` alone sets the wall-clock of any sweep it
is in, and raising `-c` past ~4 mostly buys time back on that one model.

## Node 24 runs the TypeScript directly

No build step, no `tsx`, no esbuild — `node src/cli.ts` works because of native type
stripping. `npm run typecheck` is `tsc --noEmit` and is the only TS tooling. That is why
`erasableSyntaxOnly` is on in `tsconfig.json`: enums and parameter properties would break
the runtime. Don't add a bundler to "fix" something; there is nothing to bundle.

## Fonts

Manrope is vendored at `brand/fonts/Manrope[wght].ttf` (OFL, licence beside it) and passed
to sharp via `fontfile` — it is deliberately not a system font install, so the output is
identical on any box. Text goes through pango markup, so `esc()` in `brand.ts` must escape
the five markup entities; sizes assume `dpi: 72`, which makes one point one pixel.

## Secrets

`REPLICATE_API_TOKEN` only, in `td-sops` at `apps/mwk-og-image-generator.enc.env`. One
token covers the image models *and* `openai/gpt-5.6-terra`, which does the style
brainstorming — that single-credential property is the reason this targets Replicate at all,
so resist adding a direct OpenAI or Google client.

## Phase

Phase 1 is the prompt workflow and it is what exists. The web UI is phase 2 — when it
lands, `src/` is already the library it should call, so keep CLI concerns in `cli.ts` and
nothing else.

## Prompt fidelity is a correctness property, not a nicety

`PROMPT_FIDELITY` in `src/models.ts` is the long version. The short version: a comparison is
only meaningful if every model renders the prompt we composed, and several models ship a knob
that rewrites it first — with *disagreeing* defaults. `seedream-4`'s `enhance_prompt` defaults
to **true** and silently rewrote our prompt through the whole first sweep (2026-08-13); nothing
errored, the images simply weren't comparable.

Every prompt-touching knob is now pinned explicitly in `buildInput`, including ones that
already default correctly. Adding a model means checking its schema for such a knob and
pinning it too. Do not "tidy up" a pin because it matches the current default.

## The brand layer follows a published design system, not taste

`brand/brand.json` encodes matewishkey.com/design. The bits that are easy to get wrong:

- **The RedBlock is the only logo** — a red `#e2342b` square, square corners, white mark
  centred at 64%. Never composite a bare mark, and never hand-build a second red square
  elsewhere; `redBlock()` in `brand.ts` builds the one.
- **Fraunces 700** sets display headings, **JetBrains Mono 700** uppercase at 0.16em tracking
  sets kickers, Manrope is body only. Tracking is converted to Pango units (1024 per point)
  from ems at render time, so changing the kicker size keeps the tracking proportional.
- **`redDeep` `#f0524a` is the only red permitted at body size** — kickers and links. The
  `red` token is a surface/display colour: the block and the accent rule.
- Pango here maps `weight` onto a variable font's wght axis but does **not** support the
  `font_variations` attribute, so Fraunces' WONK and SOFT axes are unreachable. Verified;
  don't spend time trying to enable the wonk.

## --ref-role: models disagree about who the reference is

With reference photos and two people in the scene, each model decides for itself which
person the reference depicts, and they decide differently — on the 2026-08-13 honeypot run
nano-banana-2 cast the reference as the interviewer while gpt-image-2 put him on the monitor
as the candidate. Nothing errored; the picture just argued the opposite case.

`--ref-role` emits an explicit assignment plus "everyone else is a different individual".
Any scene with more than one person needs it. See `ComposeOpts.refRole`.

## Video is the same pipeline, not a second one

`src/video.ts` burns the band in with ffmpeg using the **same** `brandOverlay()` the stills
use, scaled by `scaleBrand()` to the clip's real dimensions. Never write a second band
renderer for video — one implementation is the only thing stopping a card and its animation
from drifting apart. ffprobe is not installed on this box; dimensions come from extracting
frame 1 and reading it with sharp, which is deliberate, not a workaround to replace.

Facts that cost money if guessed:

- **Veo 3.1's price tier is audio on/off, not resolution** — $0.40/sec with, $0.20 without,
  and 1080p costs the same as 720p.
- **Only Sora 2 and Veo 3.1 return audio.** Kling and Seedance are silent, so a clip with
  dialogue has exactly two candidates, and Sora is 4x cheaper per second.
- Sora's aspect enum is `portrait`/`landscape`, not a ratio string like every other model.
- `-shortest` must stay OUT of the ffmpeg overlay call: the band is a still image input and
  would otherwise truncate the output to nothing.

## GPT Image 2's advantage is composition, not spelling

An earlier version of the docs claimed it was the only model that renders legible text. That
was wrong and was corrected on evidence: given an identical `--allow-text` comic prompt,
nano-banana-2 spelled its speech bubbles perfectly. What `gpt2` did that the others did not
was render the *fifth thing in the prompt* — the off-camera second screen with the metrics on
it, the detail carrying the joke. It costs ~5x the wall-clock for that. Explore cheap, finish
on gpt2. Don't reinstate the spelling claim.
