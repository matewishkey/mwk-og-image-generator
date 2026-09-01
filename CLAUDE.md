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

- The frame rules in `src/prompt.ts` (`FRAME_BASE` + `NO_TEXT`/`SOME_TEXT`) tell every
  model to render no text and to keep the bottom fifth calm. That instruction exists
  *because* the band lands there. Change the band height in `brand/brand.json` and that
  sentence needs to change with it.
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
token covers the image models *and* the text models that do the style brainstorming and
layout writing (`src/text-models.ts` — the PURE module holding the model choice and each
family's input shape; `TEXT_MODEL_DEFAULT` is qwen3-235b, `TEXT_MODEL_VISION` is
gpt-5.6-terra, the pricier fixer and the only one that can see images)
— that single-credential property is the reason this targets Replicate at all,
so resist adding a direct OpenAI or Google client.

## Phase

Phase 1 is the prompt workflow and is live. Phase 2 (the web app) started landing
2026-08-14 and was **decommissioned 2026-09-01** (banner below). `src/` is the library
both call, so keep CLI concerns in `cli.ts` and nothing else.

## Phase 2 layout — og.matewishkey.com

> **DECOMMISSIONED 2026-09-01.** Mate no longer needs the hosted studio, so every Cloudflare
> resource below was deleted: workers `mwk-studio` + `mwk-studio-engine` (with its container and
> both crons), D1 `mwk-studio`, R2 `mwk-studio`, and the `og.matewishkey.com` custom domain and
> DNS record. **Nothing in this section is live** — the deploy runbook, the studio CLI, the smoke
> test and every URL here describe infrastructure that no longer exists. The code, configs and
> migrations stay in the repo, so a redeploy would need the D1/R2/domain recreated first (the
> `database_id` in `web/wrangler.jsonc` is dead). The full data archive — 4,595 R2 objects and a
> complete D1 dump — is at
> `~/share/work/mat-mwk-og-image-generator/2026-09-01_cloudflare-teardown/`.
> Phase 1 (the CLI: `node src/cli.ts`, music, video, montage) is untouched and still works.

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
  sides. **SeamIdea.prompt is the shot's RAW idea** — the engine composes it with the
  style exactly once. Sending a composed prompt re-composes it (the 2026-08-16
  double-compose bug: every take's billed prompt carried the style text twice).
  Per-shot style overrides ride as `SeamIdea.style`; the project's brand kit rides as
  `EngineRunRequest.brand` + `markKey` so take CARDS carry the team band, with
  `EngineRenderRequest` doing the same for designs. The engine materialises `markKey`
  from R2 to a temp file and validates every kit with `BrandConfigSchema`
  (src/brand-config.ts — the PURE module; brand.ts re-exports its types because the
  worker can't import sharp). **Secrets live where they are used:** the web worker holds SES + `SEAM_SECRET`;
  the engine holds `REPLICATE_API_TOKEN`, R2 S3 keys and `SEAM_SECRET`. The web app never
  holds Replicate or R2 credentials — keep it that way.
- Astro v6+ removed `Astro.locals.runtime.env`; bindings come from
  `import { env } from 'cloudflare:workers'` via `web/src/lib/runtime.ts`, the one place
  that touches it.
- House styles and the house brand kit are seeded from `styles/*.yaml` and
  `brand/brand.json` by `web/scripts/gen-seed.mjs` → migration `0002_seed.sql`.
- `/brand-kits` is the kit library + editor (duplicate-house-to-edit, flattened config
  form validated by BrandConfigSchema before save, PNG/SVG mark upload → R2 `mark_key`,
  CSS mock preview labelled approximate). House kits are read-only. Uploaded SVGs are
  served from /img with a lockdown CSP — keep that header.
- Finish presets (`design.effect`: grain/vignette/glow/fade) are deterministic sharp
  passes applied engine-side AFTER compositing (engine/container/effects.ts, metadata in
  src/effects.ts). Never an AI polish pass — same reason branding is composited.
- **Layouts have two authoring levels, one schema, one renderer** (2026-08-16): preset
  `archetype`s plus freeform `cells`/`texts`/`shapes`/`background`/`chipStyle`/`lockupBox`
  in src/seam.ts. Colors in templates are brand TOKENS only, never hex — the rendering
  kit resolves them. Use `layoutPanels(cfg)`, never index ARCHETYPE_PANELS directly
  (archetype is optional now). The preset pixel maths in `placeRects` is FROZEN — the
  freeform refactor shipped only after a 112-case harness proved every real layout
  byte-identical; don't "clean it up". Hand-authoring: POST `/api/projects/<slug>/designs`
  or `studio design <slug> --config <file.json>` (the design page's author card died in
  the round-5 preview-first rebuild; the editor covers interactive authoring).
- **Cells target shots explicitly**: `CellSchema.panel` (0-based index into the
  project's shot order, default = the cell's own index) is resolved WEB-side by
  `selectPanels` in src/seam.ts — design.ts (both creators) and previews.ts all route
  through it; the engine receives panels already in cell order and its baked schema
  copy strips the field. Never reintroduce `panels.slice(0, needed)` — positional
  slicing is why banner configs once needed 7 placeholder feeder cells to reach shot 8.
- **Round 7: the design page is Template / Slots / Revisions** (mate's model, 2026-08-18).
  URL state is `?template=<layoutId>&revision=<designId>&theme=dark`; old ?style/?shot
  params are ignored and ?lead redirects into the new shape. STYLE plays no part on
  the design page any more — pictures are chosen per SLOT (swap modal, takes grouped
  by shot). A design row IS a revision: template + design_panel slot assignments +
  words. `panels_hash` (0018) joins the supersede tuple with the words, so only an
  IDENTICAL re-render supersedes; any change coexists as a new revision. Finished
  renders live on `/projects/<slug>/results` (filters ?template/?theme/?versions=all,
  zip, all-formats, re-render, pack bar); nav tabs are shots|design|results|settings
  (/preview stays routable, highlights Results). Shot hide/unhide lives on /shots.
- **Text decoration (round 7 phase 2)**: TextSpec grew `underline` ('single'|'accent'|
  'low' — 'accent' = single underline in underlineColor ?? redDeep), `underlineColor`,
  `highlight` (+`highlightAlpha`, pango background — changes trimmed geometry, opt-in
  only), `strike`. All optional; the band renders byte-identical (proved by a 0-pixel
  diff across the engine upgrade). Emitted as pango attrs in brand.ts textLayer,
  resolved to hex engine-side in renderTexts. NO italic/condensed — pango re-resolves
  the face and silently falls back to DejaVu. The editor has the controls per text row;
  the generate brief documents the fields so "Change it" can use them.
- **`shot.hidden_at` (0017) hides a shot without deleting**: it KEEPS its inventory
  slot as null (resolvePanelTakes LEFT JOIN + scopeInventory in previews.ts), so
  `cell.panel` indexes never shift — a hidden shot fails loud ("cell N draws from a
  hidden shot"), never silently re-casts. Same for style gaps: a shot with no take
  in the scoped style is a null slot, not a dropped row. Don't "optimise" the LEFT
  JOIN back to INNER.
- **"Change it" (reviseDesign, design-actions.ts): the owner types an instruction on the
  lead card** ("move the text left"), the text model revises the layout config through the
  SAME validated-config loop as generate (brief carries the current config + instruction,
  n=1), the result lands as a new `rev-*` layout with the same name, the predecessor is
  archived (team layouts only), and the design re-renders — replaying the SOURCE
  design's own panels when the cell count is unchanged (fallback: current resolution).
  This is the primary editing path — the editor is for fine control, not the default.
- **The editor** previews in the SAVE format's true aspect, starts in the source
  design's format/theme/effect, and has drag-to-move handles over the live preview
  (freeform cells/texts/shapes; `.le-stage` in app.css). preview-layout and
  authorTemplate both go through resolvePanelTakes + scopeInventory + selectPanels —
  never positional picks. The EFFECT select left the UI in round 7 (mate: confusing)
  but `initialEffect` still THREADS through preview + save — supersede matches on
  effect, so dropping the thread would double-card old grain/glow designs. Each text
  row has an "+ accent line" button (appends a draggable redDeep `rule` shape).
- **Supersede tuple (round 7): layout+format+theme+effect+panels_hash+words** — only a
  byte-identical re-render retires its predecessor
  (createDesign/createCollection close each insert batch with the UPDATE). Pre-0018
  rows have NULL panels_hash and are never superseded again — accepted. The design
  page also hides designs whose LAYOUT is archived (`?versions=all` shows them) — so
  "clean up the design page" = archive dead layouts, never delete rows. NOTE
  `studio design --config` creates a NEW layout row per call, which defeats the
  supersede match — iterate via `{layoutId}` API renders once a template exists.
- **Kits can carry uploaded faces**: `FontSpec.fileKey` (R2) + `family` parsed from the
  file's own name table (web/src/lib/fonts.ts); the engine materialises it via
  `localFont()` and rewrites `file` before rendering. Never hand-type a pango family —
  a mismatch falls back to DejaVu with no error. The Tasman Visa kit (Sora SemiBold on
  a navy band) is the living proof; the team also has an official-mark "Mate Wish Key"
  kit beside the read-only house kit.
- The build plan (final, reviewed): https://work.l/mat-mwk-og-image-generator/2026-08-14_plan/

## UI rules mate has set — don't regress these

- **No accordions.** Everything visible, big pages are fine. (Shots page was
  details/summary once; buttons inside collapsed it and he called it out.)
- **No popups, ever.** Destructive buttons use hold-to-confirm: `button[data-confirm]`
  (Base.astro script) — first click arms it (label → "sure?"), a 1-second press-and-hold
  fires. `confirm()` is banned.
- **Running work shows on the button that started it** — the global submit listener
  disables the submitter next-tick and swaps to its `data-running` label. Give every
  slow action a `data-running`.
- **Icons never appear without a text label**; the set is `components/Icon.astro`,
  documented at `/glossary`. Add an icon → add its glossary row.
- **Form-action dispatch is `form.getAll('action').at(-1)`**, never `get('action')` —
  a hidden default before named submit buttons silently swallowed every override
  (the round-1 co-write/delete bug).
- **Nothing that ran ever disappears.** Superseded takes stay on the contact sheet,
  dimmed with a chip, still pickable. "The old one is never overwritten" is UI, not
  just schema.
- **Generate-first, never config-first.** Twenty rendered options beat one form.
  Fine-tune panels exist for the tenth time, not the first.
- **Design tab shape**: one leading image with its actions, all versions in a grid
  under it, click a version to lead. Rendering defaults to the OG card only; "every
  format" is the one-click all-formats action on the lead, never the default (mate
  revised his earlier all-formats-default rule on 2026-08-16; round 5 removed the
  format checkbox list from the page entirely — full format control lives in the
  editor and the designs API).
- Every screen keeps a pasteable URL; filters live in the query string.
- **Nothing is ever lost, and save state is VISIBLE** (round 3, after mate lost an edit to
  a button click): the workspace autosaves every edit (debounced), every action flushes
  pending saves first, the poll never clobbers a draft, and each shot carries a live
  Saved/Unsaved badge. Any new editing surface must keep all four properties.

## The workspace islands — the interactive surfaces

Round 3 merged Shots + Takes into one island; round 4 SPLIT it into two pages after mate
called the single page heavy: `/projects/<slug>/shots` is a light overview
(`components/ws/Overview.tsx` — rows, run-all, add-shot, EVERY-shot refs) and
`/shots/<position>` is the full editor (`components/ws/ShotEditor.tsx`). Shared pieces
(api client, toJpeg, HoldButton, Modal, icons) live in `components/ws/lib.tsx`. A third
island is the layout editor (`components/ws/LayoutEditor.tsx`, below). Everything else
stays server-rendered forms. Round-4 specifics:

- **Modals are allowed for previews and pickers ONLY** (mate asked for them, revising
  the earlier blanket no-popup rule): take lightbox (RAW art + download raw/card),
  library attach picker, all-styles picker, settings style preview. Destructive actions
  keep hold-to-confirm — `confirm()` and destructive dialogs stay banned.
- **Shot-context grids show the PICTURE, not the branded card**: engine writes
  `art-thumb.webp` beside the card thumb; `take.art_thumb_key` (0013). Card thumbs stay
  on design/pack/style pages, where the band belongs. Old takes fall back to art_key.
- The per-shot style strip shows ONLY the project's selected styles; "All styles…"
  opens the full-catalog modal. `{shot N}` tokens are highlighted in the textarea via a
  transparent-text backdrop overlay (`.ws-hl-*`), warn-red when unresolvable.
- Refs UI is model-aware: hidden with a pointed hint when no selected model has
  `refStyle !== 'none'`; otherwise the numbered strip shows EXACTLY the order models
  receive (chain → shot → project) with per-model see/ignore notes.
- Takes stuck live >3 min get a hold-to-confirm **Give up** (`applyTakeAction 'giveup'`
  — the sweeper's flip scoped to one take).

Load-bearing details:

- `lib/workspace.ts` `takesPayload()` builds the state for BOTH the page shell and
  GET /api/…/takes (the island's poll) — one builder, so page and poll cannot drift.
  `lib/media.ts` `refState()` is the same idea for references.
- The poll merges server truth into local state but NEVER overwrites draft fields; the
  autosave debounce is 800ms; failed saves retry after 3s. Hold-to-confirm is a Preact
  `HoldButton` with the same timings/classes as the global `data-confirm` script.
- The icon set lives in `components/icons.ts` — ONE source imported by Icon.astro and
  the island. Add an icon there → add its /glossary row.
- `/projects/<slug>/takes` 301s to the `/shots` overview; the old takes.json poll route is gone.
- **Playwright gotcha**: `client:load` islands are server-rendered THEN hydrated — a test
  that clicks before hydration hits dead buttons. Wait for
  `astro-island:not([ssr])` before interacting (cost a full verify-run to find).

## Design round 4: accent, dark palettes, the layout editor

- **`redDeep` IS the accent** — emphasis (*word*) and kickers render in the KIT's
  redDeep, so Tasman's emphasis is green. Every label says "the kit's accent" with a
  live swatch; never write "renders red" again.
- **Dark palettes**: `BrandConfig.colorsDark` (optional, PARTIAL — overlaid onto
  `colors` when `EngineRenderRequest.theme === 'dark'` in resolveBrand). Kit editor has
  a dark section with a derive-from-light button (keeps the reds — brand colours don't
  theme). `design.theme` (0013) records which palette a design used; the render form's
  theme checkboxes render one design per checked theme. Take cards stay light.
- **The layout editor** (`/projects/<slug>/design/editor`): knobs + live preview.
  Preview path: `POST /api/projects/<slug>/preview-layout` → engine `/render` with
  `inline: true` → PNG bytes straight back, NOTHING persisted (no layout row, no design
  row, no R2 object). Saving goes through the normal author flow. The engine's inline
  mode is the only render path that writes nothing — keep it that way.
- Minimal house layouts (0014): minimal-corner / minimal-title / minimal-pair; the
  generate card's "minimal" chip fills a quiet brief.
- The media page upload is a drop zone (drop + paste + click) feeding the SAME
  `input[data-jpeg]`; the converter dispatches `jpeg-done` when it has rewritten the
  files — programmatic senders wait for it before submitting. The converter passes
  undecodable files through untouched BY DESIGN (server still sniffs).

## Round 5: the design page is preview-first — the configurator is dead

Mate's verdict: "almost nobody will use the configurator at all." The design page now
SHOWS real cards instead of asking for settings; the knobs live only in the editor.

- **`preview` table (0016) is a CACHE, not history** — one row per (project, kind
  layout|style, ref), overwritten in place. `lib/previews.ts` `ensurePreview()` hashes the
  exact engine payload (SHA-256); hash match = no render. The hash is IN the R2 key
  (`…/previews/<kind>-<ref>-<hash12>.png`) so /img's immutable cache header stays honest;
  the stale object is deleted on refresh. Composite renders are $0.00, engine `inline`.
- **NOTHING auto-renders since round 7** — refreshStylePreviews is deleted, the
  design page's preview pump is gone, and run-finished only does bookkeeping.
  Previews render on intent only (`/api/…/previews` and `ensurePreview` stay for
  callers that ask). Don't reintroduce a background sweep.
- **Panels = pick ?? newest succeeded** (`resolvePanelTakes`, optional style scope) —
  designs and previews work from DRAFTS; picking upgrades, never gates. NOTE the SQL
  shape: SQLite refuses an outer-alias reference in the ORDER BY of an ON-clause
  subquery ("no such column"), so pick-preference is a coalesce of two subqueries with
  the correlation in WHERE. Cost a live 500 to learn; don't "simplify" it back.
- **The gallery lists house layouts + NAMED team templates only** — anonymous `gen-*`
  layouts stay out (their designs are in versions history); 70 near-identical cards was
  the exact confusion the gallery exists to kill. Every card shows "N images".
- **Design actions live in `lib/design-actions.ts`** (render-from-layout, all-formats,
  generate, save-template, author, pack-link, and since round 7: panelsFromDesign /
  rerenderDesign / setPanel); design.astro's POST and /api/…/designs are thin
  wrappers — change behaviour in the lib, never in a route. The designs API also
  accepts `{ layoutId, formatIds?, themes?, effect? }`.
- **The replay path (round 7)**: `panelsFromDesign` reads a design's OWN design_panel
  rows; `rerenderDesign` re-renders from them with `preselected: true`, which SKIPS
  selectPanels (design_panel stores the POST-selectPanels flattened list — re-selecting
  would misread `cell.panel` refs as inventory indexes). `preselected` rides ONLY
  replay paths, never resolve paths. renderAllFormats replays too — a promoted design
  keeps its exact pictures, never re-resolved from current picks.
- **Quick card (round 7 phase 1b)**: upload -> branded card, no shots/runs/styles.
  `lib/quick.ts` `quickCard()` stores the image via uploadReferences (content-deduped),
  fills EVERY slot of the template with it (design_panel `source_kind='reference'` —
  the branch 0003 designed for), renders into the hidden per-team `_quick` project
  (the _style-proofs pattern). Surfaces: `/quick` page, `POST /api/quick-card`
  (bearer; `{image: base64|referenceId, template, title?, …}` — the mwk-social hook),
  `studio quick --image <f> --template <slug> [--out <dir>]`. Bearer tokens are also
  honoured on GET `/img/*` (middleware) so the CLI can download what it minted; the
  zip route looks projects up directly (not loadProject) so archived hidden projects
  still zip.
- **`updateProject` in lib/projects.ts is the ONE settings writer** — settings page,
  PATCH /api/projects/[slug], and `studio set` all call it. The brand-kit selector
  (settings + design page, changes project.brand_kit_id) rides it; kit change → new
  payload hash → every preview re-renders lazily.
- **Cost math consolidated** (the round-3 findings item): `billedRefMp` (exact, ledger)
  and `estimateRefMp` (estimate-grade) in src/models.ts are the only ref-billing rule;
  run.ts and web runs.ts both call them. The `form.get('action')` stragglers (team,
  style detail, brand-kits list) are fixed — the pattern is extinct.
- login_token timestamps are ISO-with-T; sqlite `datetime('now')` (space separator)
  string-compares as expired. Mint tokens with real ISO strings.

## Multi-style, per-shot refs, character chaining (round 3 data model)

- A project carries a style SET (`project_style`, migration 0010; `default_style_id`
  stays as the primary). A run renders shots × styles × models × iterations; a shot
  with `style_override_id` renders ONLY its override. `bundle.styles` everywhere.
- **The style slug is part of a take's identity**: it joins the R2 take key, the cell
  event (`EngineEvent.styleSlug`) and the take match in /internal/events, and the
  `take_identity` unique index includes style_id (migration 0012 — the first live
  two-style run failed the old index). createRun refuses a run where two styles share
  a slug. runSweep renders an overridden idea ONCE, not once per loop style.
- References attach at project scope ("every shot") or shot scope
  (`reference_use.owner_type='shot'`); per-shot refs ride `SeamIdea.refKeys` and lead
  the cell's ref list (single-ref models see the first image). Per-cell billing counts
  what the model actually receives (capped at maxRefs; single = first ref only).
- **`{shot N}` in a prompt chains characters**: createRun resolves shot N's picked
  take's `art_key` (the RAW unbranded output — never the branded card) as a leading
  reference and rewrites the token to "the character from reference image K". No pick
  on shot N = the run refuses with a message naming the shot. The chain is resolved
  web-side; the engine knows nothing about it.
- Per-shot `ref_role` (0010) overrides the project's, via `SeamIdea.refRole`.

## Round 8: chat-first — the decisions a reviewer panel settled (2026-08-19)

Six reviewers (3 research, 3 critique) + mate's answers fixed these; don't relitigate:

- **Artifacts as a viz layer: rejected on physics** (viewer sandbox blocks downloads,
  16MB data-URI cap, republish-per-poll). The CF site stays the eyes; chat is the hands.
- **Local generation is DIRECT-INGEST (shipped 8b), not a pull queue**: `studio run`
  (the DEFAULT; `--engine` opts out) POSTs `{dispatch:'local'}`, createRun returns the
  frozen EngineRunRequest instead of dispatching, and the CLI executes it via
  `src/executor.ts` (`createExecutor` factory — the container's run adapter, extracted;
  server.ts is now a thin HTTP shell over it). Site buttons keep the engine path.
  Reshoot/reroll also still go to the engine — extend on demand, don't pre-build.
  If the CLI dies mid-run the sweeper reclaims, same as a dead container. The round-8c
  engine deploy (main-14, 2026-08-19) baked in the executor refactor, Cancel-After and
  typography — and reproduced main-11 exactly: the first deploy showed a fresh digest
  yet the instance booted the old image (a live render proved fields were stripped);
  the INSTANCE_NAME re-bump fixed it. Treat the digest diff as necessary, never
  sufficient — always verify with a render.
- **The replicate client passes `URL` objects to its fetch option** — a wrapper doing
  `input.url` gets undefined and every prediction fails "Invalid URL" (cost one live
  run, 2026-08-19). Handle string | URL | Request and pass through on parse failure.
- **Take ordinals are permanent**: `<shot>.<n>` by (created_at, id) over ALL of a shot's
  takes — computed identically in workspace.ts (JS) and zip/run-page SQL (ROW_NUMBER).
  Printed on every tile (`.ws-ordinal`), the lightbox, `studio takes`, and watch lines;
  every CLI take arg accepts `1.3` tokens (resolved client-side in studio.ts). Never
  renumber, never reuse — a spoken number must stay valid forever.
- **`/projects/<slug>/runs/<runId>`** is the one-page run contact sheet (shots × styles,
  live-refreshing); run/reshoot/reroll print it the moment the run exists — the deep
  link comes FIRST, not at the end.
- **`studio upload-ref` / `studio zip --takes 1.3,… [--out f]`** close the chat loop:
  refs in and multi-file downloads out without touching the site. Zip take entries are
  ordinal-named, raw art + branded card each.
- **Cell events renew the whole run's take leases** (events.ts) — a >30-min gpt2 sweep
  no longer gets its tail swept as abandoned. And every Replicate prediction carries
  `Cancel-After: 15m` (format verified 2026-08-19: integer seconds or 30s/5m/2h, 5s–24h)
  so a dead process can't bill unattended.
- **Compose (shipped 8c-1)**: `renderFromPicks`/`composeFromTakes` in design-actions.ts —
  explicit ORDERED take lists, `preselected: true` (the sanctioned replay shape), pinned
  (`hasExplicitPanels`) templates refused, renderer rejects skipped. API: designs POST
  `{takes, layoutId?}` + GET (templates with slot counts + revisions). CLI: `studio
  compose --takes 1.3,2.1 [--template]`, `studio templates`. Landing URL is
  `results?ids=d1,d2` — when ?ids= is set the page shows superseded/archived designs too
  (an explicitly linked id must always resolve).
- **`.claude/skills/mwk-media/`** is the operator playbook + the SINGLE source of recipe
  definitions (recipes.md). **`/guide` (shipped 8c-2) imports that file AT BUILD TIME**
  (`recipes.md?raw`) — vocabulary, styles with proof thumbs (proofThumbs), templates by
  picture count. Editing recipes.md requires a web deploy to reach the page; never
  hand-copy recipe text anywhere.
- **Typography (8c, shipped)** stays sharp+pango — satori rejected (no kerning/ligatures,
  broken variable fonts). TextSpec grew `name` (named layer for revision instructions —
  never affects rendering), `face` (typeface override, KIT faces only), `size` (pt at kit
  canvas width, replaces the face's base; sizeScale still multiplies), `weight` (all three
  vendored faces are variable-wght, so it genuinely renders), negative `trackingEm`
  (min -0.1), `stroke`/`strokeWidth` and `shadow`/`shadowBlur`/`shadowOffset` (fractions
  of font size, tokens only). Shadow = the layer recolored + blurred + offset via
  decorateText in src/brand.ts; outline = ring composite, stamps at ≤1px arc spacing on
  rings every 2px inward — sparser rings scallop visibly. decorateText returns `pad` and
  renderTexts subtracts it, so the INK stays anchored; undecorated text is proven
  byte-identical (2-config harness, cmp). The engine's baked schema strips the fields, so
  typography is live only from the round-8c engine deploy on. All fields in the editor's
  typography row + the generate brief. NOTE the house brand is dark-scheme: paper=#101317
  (dark), ink=#f4f2f6 (light) — don't reason about tokens from their names.
- Full history: ~/.claude/plans/pls-use-3-reviewer-lazy-dream.md.

## The studio CLI — how Claude drives the site

> **DECOMMISSIONED 2026-09-01** — every `/api/*` route below is gone with the site. See
> the Phase 2 layout banner. `studio run` is dead too: it renders locally, but it still
> POSTs to the web worker to create the run first.

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

> **DECOMMISSIONED 2026-09-01** — nothing here is live: no workers to deploy, no D1 to
> back up, no crons running, no site to smoke-test. Kept as the record of how it worked.

- **Deploy web**: `cd web && npm run deploy` (build + `wrangler deploy -c dist/server/wrangler.json`
  — run it from `web/`, the -c path is relative). **Deploy engine**: bump `INSTANCE_NAME` in
  `engine/wrangler.jsonc` whenever the image changed, then `cd engine && wrangler deploy` with
  `CLOUDFLARE_DEPLOY_TOKEN` (td-sops) as CLOUDFLARE_API_TOKEN — the env token lacks Containers perms.
  `max_instances: 4` exists because drained instances hold slots for up to `sleepAfter`.
  **Check the deploy diff shows a NEW image sha256.** wrangler can push a stale image
  (main-7, 2026-08-16: "Image already exists remotely, skipping push" while the app kept the
  old digest, and the fresh instance ran old code). If the digest only changes on a second
  deploy, bump INSTANCE_NAME again — an instance that started before the digest changed
  keeps serving the old image. Even when the FIRST deploy shows a new digest, verify with
  a real render that new behaviour is live (main-11, 2026-08-18: fresh digest applied yet
  the instance booted the old image and its baked zod stripped the new schema fields; an
  INSTANCE_NAME re-bump fixed it — and "Image already exists remotely, skipping push" on
  that second deploy is fine, it proves the remote image already matches the local build).
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
- **House styles**: 46 as of round 4 (9 original + 18 round-3 + 19 round-4 from research
  sweeps of common OG-imagery looks, all proofed — count them in D1, not here, when it
  matters). Source of truth is `styles/*.yaml`; NEW styles added after 0002
  ship via `node web/scripts/gen-style-migration.mjs <NNNN_name.sql>`, which diffs the yaml
  against every existing migration's `seed_style_*` ids.
- **Co-write is an EXPANDER** (round 3): `suggestShotVariants` turns a short idea into
  100–180 word scene-only production prompts (3 variants), preserves `{shot N}` tokens
  verbatim, and knows whether refs/ref-role exist. Don't reintroduce a word cap.
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

## Music: four onboarded models, its own command, never part of the sweep

`mwk-og music` (src/music.ts) — music is prompt -> model -> audio file; no styles, no
band, no cells, and it must stay OUT of the gen sweep machinery. Facts read off
Replicate pages on MUSIC_PRICES_VERIFIED_ON (re-read before editing an input map):

- **lyria2** (google/lyria-2) $2/1000s: instrumental 48kHz stereo, NO duration knob
  (~30s, it decides), and it serves PCM WAV behind an extension-less URL — the file
  extension comes from sniffing the bytes (RIFF), never the URL.
- **song15** (minimax/music-1.5) $0.03/track: full songs to 4 min with real vocals —
  `lyrics` is a REQUIRED input ([verse]/[chorus] tags), `prompt` carries the style.
- **stab25** (stability-ai/stable-audio-2.5) $0.20/track: music AND sound design;
  the only one with a duration knob (1-190s).
- **eleven** (elevenlabs/music) $8.30/1000s: premium arrangement control;
  `force_instrumental` defaults TRUE — vocals need the --vocals flag.
- meta/musicgen stays OFF the table deliberately: it is version-pinned (not an
  official model), billed by GPU time, and the four above cover its range better.
- Real music (e.g. Dylan) is copyrighted — generated originals are the free library.

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
