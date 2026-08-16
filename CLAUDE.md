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

Phase 1 is the prompt workflow. Phase 2 (the web app) started landing 2026-08-14; `src/`
is the library both call, so keep CLI concerns in `cli.ts` and nothing else.

## Phase 2 layout — og.matewishkey.com

- `web/` — Astro SSR on Workers (worker `mwk-studio`, custom domain og.matewishkey.com;
  D1 `mwk-studio`, R2 `mwk-studio`). Deploy: `cd web && npm run deploy`. Bindings come
  from `wrangler.jsonc`; the build writes the resolved config to
  `dist/server/wrangler.json`, which is what deploy uses.
- `engine/` — worker `mwk-studio-engine` fronting ONE named container that runs
  `src/run.ts` `runSweep` unchanged. Image from `engine/Dockerfile`, build context is the
  repo root. Deploy: `cd engine && wrangler deploy` — needs the container-capable token
  (`CLOUDFLARE_DEPLOY_TOKEN` in td-sops), the default env token lacks the Containers
  permission.
- `src/seam.ts` is the wire protocol, HMAC both directions, one module imported by both
  sides. **Secrets live where they are used:** the web worker holds SES + `SEAM_SECRET`;
  the engine holds `REPLICATE_API_TOKEN`, R2 S3 keys and `SEAM_SECRET`. The web app never
  holds Replicate or R2 credentials — keep it that way.
- Astro v6+ removed `Astro.locals.runtime.env`; bindings come from
  `import { env } from 'cloudflare:workers'` via `web/src/lib/runtime.ts`, the one place
  that touches it.
- House styles and the house brand kit are seeded from `styles/*.yaml` and
  `brand/brand.json` by `web/scripts/gen-seed.mjs` → migration `0002_seed.sql`.
- The build plan (final, reviewed): https://work.l/mat-mwk-og-image-generator/2026-08-14_plan/

## UI rules mate has set — don't regress these

- **No accordions.** Everything visible, big pages are fine. (Shots page was
  details/summary once; buttons inside collapsed it and he called it out.)
- **Nothing that ran ever disappears.** Superseded takes stay on the contact sheet,
  dimmed with a chip, still pickable. "The old one is never overwritten" is UI, not
  just schema.
- **Generate-first, never config-first.** Twenty rendered options beat one form.
  Fine-tune panels exist for the tenth time, not the first.
- **Design tab shape**: one leading image with its actions, all versions in a grid
  under it, click a version to lead. "Every format" (a collection) is the default
  render, not a choice.
- Every screen keeps a pasteable URL; filters live in the query string.

## The studio CLI — how Claude drives the site

`mwk-og studio …` (`src/studio.ts`) operates the LIVE studio over `/api/*` JSON routes so
mate can watch results appear in his browser. Auth is a bearer token: `MWK_STUDIO_TOKEN`
in td-sops (`apps/mwk-og-image-generator.enc.env`); `MWK_STUDIO_URL` overrides the base
for local dev. Mint a new token with `node web/scripts/mint-api-token.mjs` (prints the
token once + the wrangler INSERT); revoke = `UPDATE api_token SET revoked_at=…`.
The middleware honours bearer ONLY on `/api/*`, which never redirects — auth failures are
401/403 JSON. Session cookies also work on /api; CSRF is blunted by requiring
`content-type: application/json` on bodies (`readJson` in web/src/lib/api.ts). Mutation
routes are thin wrappers over the same libs the pages use (lib/projects.ts, lib/takes.ts,
lib/runs.ts) — change behaviour there, not in the routes.

## Phase 2 ops — the runbook

- **Deploy web**: `cd web && npm run deploy` (build + `wrangler deploy -c dist/server/wrangler.json`
  — run it from `web/`, the -c path is relative). **Deploy engine**: bump `INSTANCE_NAME` in
  `engine/wrangler.jsonc` whenever the image changed, then `cd engine && wrangler deploy` with
  `CLOUDFLARE_DEPLOY_TOKEN` (td-sops) as CLOUDFLARE_API_TOKEN — the env token lacks Containers perms.
  `max_instances: 4` exists because drained instances hold slots for up to `sleepAfter`.
- **After every deploy**: `cd web && TOKEN=<fresh login token> node tests/smoke.mjs` — a real
  Chromium pass against the live site. Mint the token by inserting a `login_token` row (SHA-256 of
  the token) via `wrangler d1 execute`.
- **Crons (engine worker)**: `17 3 * * *` model-catalog sync → `/internal/catalog`;
  `*/10 * * * *` lease sweep → `/internal/sweep`. Both HMAC-signed with SEAM_SECRET.
- **Backups**: D1 Time Travel is live — `wrangler d1 time-travel info mwk-studio` prints the
  current bookmark, `restore --bookmark=<b>` rolls back (30-day window). R2 objects are immutable
  and content-addressed; there is no R2 backup beyond that.
- **Style proofs** are real takes in the hidden per-team `_style-proofs` project (archived on
  purpose) — that is why they appear in History and the charge ledger with zero extra machinery.
- **Deliberately NOT built** (decided with mate, 2026-08-15, "keep it simple"): Workflows as the
  per-take driver and Replicate webhooks (the container driver + lease sweep + idempotent re-runs
  cover it at this scale — revisit only if runs grow to where an abandoned run costs real money);
  R2 retention/GC for unpicked takes (pennies); `revision`/`event` audit tables (take.prompt already
  pins the exact string per billed image, History covers spend). Don't reintroduce these without a
  new reason.

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

## Transient failures are retried, not reported as holes

`retryDelayMs()` in `run.ts` absorbs two real platform failures: Replicate's 429 (it throttles
to 6/min with a burst of 1 whenever the account balance falls under $5 — this is a *billing*
symptom that looks like a code bug) and its "Prediction interrupted; please retry (code: PA)".
It honours the `retry_after` value out of the error body in preference to any backoff we would
invent. A prompt-level failure — moderation, a bad input field — is NOT retried and must stay
that way, or a genuine mistake gets billed four times.

## gpt-image-2: tiers and going direct

Both settled by experiment, so don't relitigate them from intuition:

- `high` ($0.128) over `medium` ($0.047) buys marginally finer detail and no better
  composition. `medium` is the default for good reason; more iterations beat a higher tier.
- Calling `api.openai.com` directly gets the SAME model, the SAME low/medium/high tiers and
  the same parameter set, for MORE money — $0.165 vs $0.128 at high, confirmed against a real
  billed call returning 5,488 output image tokens at OpenAI's published $30/M. There is no
  hidden better tier behind the direct API. Do not add a direct OpenAI client.

## Cheap models changed the workflow

`zturbo` ($0.0025, ~5s) and `pimage` ($0.005, ~3s) are together under a cent and render in
seconds. They are not as good as `gpt2`, and that is not the point: they are good enough to
test whether a *scene idea* works before spending 20x finishing it. Draft cheap, finish on
`gpt2`. Don't reach for the expensive model while the composition is still in question.

## montage takes art/, not og/

`src/montage.ts` composites picked frames into one card. Feeding it the branded `og/` cards
gives every panel its own brand band — the mistake is easy, silent, and looks absurd. The
help text says so; keep it saying so. Panels keep their true aspect ratio and the canvas
grows to fit, because four 16:9 frames squeezed into 1200x630 become unreadable strips.

## Scoping --allow-text to one surface

A screen inside the scene — a laptop showing code, a monitor showing a UI — is text in the
picture, which the default frame rules forbid outright. `--allow-text` on its own overshoots:
it also invites captions, speech bubbles and signage. Pair it with an `--extra` clause naming
the screen as the *only* permitted text and the rest stays clean. Used on the vibe-coding
panel 2 (2026-08-13) and it held.

## The band lockup: wordmark + tagline

`--title "Mate *Wish* Key" --tagline "No code. Just prompts. Wishes delivered."` is the house
lockup. Two mechanics behind it:

- **Asterisks set a word in red.** `emphasise()` in `brand.ts` splits on `*…*` and renders
  those runs in `redDeep` — which is the design system's rule that red at body size is only
  ever red-deep. The wordmark therefore stays a single string rather than three separately
  positioned text layers that would need re-measuring on every size change.
- **`tagline` is Manrope at `mute`**, per the system: Manrope is body copy, mute carries
  standfirsts. It is NOT another Fraunces line — a second display face in the band flattens
  the hierarchy the wordmark depends on.

`kicker` and `tagline` are alternatives, not partners: kicker is a mono label ABOVE the title
for a series or section, tagline is a sentence BELOW it. Using both in one band is possible
and almost always wrong.
