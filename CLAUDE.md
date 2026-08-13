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
