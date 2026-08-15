# mwk-og-image-generator

Generate OG images from **a style and a prompt**, across several AI models at once, and put
your branding on every result — the same way, every time.

The premise: picking an OG image is a *comparison* problem, not a generation problem. One
render from one model tells you nothing. Sixteen renders across four models and four looks,
laid out on one page, tells you immediately which direction is right. At roughly $0.05 an
image that comparison costs less than the time spent staring at a single disappointing one.

**Status: phase 1 (this CLI) + phase 2 (the web studio at og.matewishkey.com,
invite-only — `web/` and `engine/` in this repo).** Both run the same `src/` library.

```
mwk-og gen -p "a recruiter asks a honey-trap question and the candidate pauses too long" \
           -p "the same interview, seen over the recruiter's shoulder" \
           --ref refs/me.jpg --ref-role "the interviewer" \
           --title "Honey-trap questions that catch AI candidates" \
           --kicker "Mate Wish Key"
```

That renders both ideas through every style you have across the default four models, brands
all of them, and writes a contact sheet you open in a browser.

Repeat `-p` to iterate a concept. The grid is **ideas × styles × models × iterations**, and
`--dry-run` prices it before you commit.

## The two axes

A **style** is a *look* — medium, lighting, palette, camera, how a real face should be
treated. It says nothing about what is happening. A **prompt** is what is happening. They
are independent on purpose:

- Found a look you like? Keep the style, feed it new prompts forever.
- Got an idea and no look? `brainstorm` invents styles from it.
- Not sure? Run the prompt through every style at once and look at them side by side.

Styles are plain YAML in `styles/`, so a good one is a file you keep, edit and commit.

## Naming who the reference person is

`--ref-role` matters more than it looks. Give a model reference photos and a scene with two
people in it, and it has to decide which person the reference is — and models decide
differently. On the first honeypot run, Nano Banana 2 correctly cast the reference as the
interviewer while GPT Image 2 put him on the monitor as the *candidate*: the exact opposite
of the point the image was making. Nothing failed; the picture was just wrong.

`--ref-role "the interviewer"` states the assignment and adds that everyone else in the
frame is somebody else. Use it for any scene with more than one person.

## Branding is composited, not generated

The AI makes artwork. The brand band — logo, headline, accent rule — is drawn by code with
`sharp`.

This is not a shortcut, it is the correct answer. Image models cannot draw the same logo
twice, and text they render is a lottery. Compositing gives pixel-identical branding, in
about 50ms, for $0.00, on every image forever. Correspondingly every generated prompt ends
with an instruction to render *no* text and to keep the bottom fifth of the frame calm, so
the band always has somewhere quiet to land.

Layout, palette and type live in `brand/brand.json`, built from the published design system
at [matewishkey.com/design](https://matewishkey.com/design/): the RedBlock (a red square with
the white mark centred at 64%) is the only logo, Fraunces 700 sets the headline, JetBrains
Mono 700 uppercase at 0.16em sets the kicker, and red-deep `#f0524a` is the only red allowed
at body size. Point it at your own mark, fonts and colours — nothing else in the code is Mate
Wish Key-specific.

`mwk-og brand <file> --title "..."` re-brands any image with no API call at all, which is
also how you re-title a card without paying to regenerate it.

## Models

One Replicate token covers all of them, including OpenAI's — which is the reason this
targets Replicate rather than four separate APIs.

| alias | model | per image | references |
|---|---|---|---|
| `nano2` * | `google/nano-banana-2` | $0.067 (1K) | up to 14 |
| `gpt2` * | `openai/gpt-image-2` | $0.047 (medium) | up to 10 |
| `seedream45` * | `bytedance/seedream-4.5` | $0.040 | up to 10 |
| `flux2` * | `black-forest-labs/flux-2-pro` | $0.030 + $0.015/input MP | up to 10 |
| `seedream` | `bytedance/seedream-4` | $0.030 | up to 10 |
| `kontext` | `black-forest-labs/flux-kontext-max` | $0.080 | **1 only** |
| `kontext-pro` | `black-forest-labs/flux-kontext-pro` | $0.040 | 1 only |
| `ideogram3` | `ideogram-ai/ideogram-v3-quality` | $0.090 | 1 style ref |
| `imagen4` | `google/imagen-4-ultra` | $0.060 | **none — text only** |
| `recraft3` | `recraft-ai/recraft-v3` | $0.040 | **none — text only** |
| `nanopro` | `google/nano-banana-pro` | $0.150 (1K) | up to 14 |
| `gpt15` | `openai/gpt-image-1.5` | $0.050 (medium) | up to 10 |
| `seedream5` | `bytedance/seedream-5-lite` | $0.035 | up to 10 |
| `grok` | `xai/grok-imagine-image` | $0.020 | **1 only** |
| `pimage` | `prunaai/p-image` | $0.005 | none — text only |
| `zturbo` | `prunaai/z-image-turbo` | $0.0025 | none — text only |

`*` = the default sweep. They are chosen to fail differently: `nano2` holds a likeness,
`gpt2` follows instructions, `seedream45` reads a scene's spatial layout best, `flux2` comes
from a different aesthetic lineage entirely. `mwk-og models` prints the current list.

**FLUX 2 is billed by the megapixel**, not per image: $0.015 per run, per output MP *and per
input MP*. Three 0.8 MP reference photos add ~$0.035 to every render, which is most of its
cost. The tool measures your actual reference files and prices accordingly rather than
assuming — so the number `--dry-run` shows is the real one.

`zturbo` and `pimage` are the draft models: together under a cent, good enough to test
whether a scene idea works before finishing on `gpt2`. `flux-2-flex` exists at $0.060 and is
deliberately excluded — its `prompt_upsampling` defaults to **true**, so it would rewrite
prompts the way Seedream 4 did. `mwk-og models` prints the authoritative list; prices live
in `src/models.ts` and nowhere else.

`gpt2` is the slow one — measured at 35–64s an image against 10–27s for the others, so it
sets the wall-clock of any sweep it is in. Drop it with `-m nano2,seedream45,flux2` when you
want a fast look around.

**On `gpt2`'s quality tiers.** Measured on an identical four-prompt A/B: `high` ($0.128) buys
slightly finer detail than `medium` ($0.047) and composes no better. Stay on `medium` and
spend the difference on more iterations. `low` ($0.012) is for thumbnails only.

**Going direct to OpenAI gains nothing.** Verified with a real billed call: the same prompt at
`high` costs $0.165 through `api.openai.com` (5,488 output image tokens at $30/M) against
$0.128 on Replicate, for the same model, the same three quality tiers and the same parameter
set. Replicate is a passthrough with a better price, not a restricted tier.

**What GPT Image 2 is actually better at.** Not spelling — given the same two-panel comic
prompt with `--allow-text`, Nano Banana 2 spelled its speech bubbles perfectly too. The
difference is *compositional* instruction-following: the prompt asked for the candidate
glancing at a second screen off to the side, and only `gpt2` drew that screen, populated it
with the four metrics, and pointed the candidate's eyes at it — the detail the whole joke
rests on. Nano Banana drew two people talking. `gpt2` also spends roughly five times the
wall-clock per image, which is the trade you are making.

Prices were read off each model's Replicate page on 2026-08-13. Replicate is the source of
truth; treat the table as an estimate.

### Going through Replicate is not a markup penalty

Replicate charges one flat price per image. OpenAI meters output tokens, so their price
climbs with resolution. At 1536×1024 — landscape, roughly the OG shape — Replicate is
*cheaper* than calling OpenAI directly:

| | Replicate | OpenAI direct | |
|---|---|---|---|
| `gpt-image-2` high | $0.128 | $0.165 | 22% cheaper |
| `gpt-image-1.5` high | $0.136 | $0.200 | 32% cheaper |

The markup only appears at the low-quality tier, on images that cost half a cent anyway.

## Setup

Needs Node 24+ — it runs the TypeScript directly, there is no build step.

```
npm install
export REPLICATE_API_TOKEN=r8_...
node src/cli.ts --help
```

## Commands

```
gen         render a sweep: ideas x styles x models x iterations, then brand every result
brainstorm  invent new styles from an idea and save them as style files
styles      list the styles you have
models      list the models, their reference limits and their per-image price
brand       re-brand an image you already have (no API call, no cost)
montage     combine several picked cards into one branded image (no API call, no cost)
```

## The montage — several picks, one card

The end of the workflow. Sweep, pick a winner per scene off the contact sheet, then combine:

```
mwk-og montage art/scene1.png art/scene2.png art/scene3.png art/scene4.png \
  --label "At home" --label "Teaching a friend" --label "At work" --label "At NASA" \
  --title "Vibe coding isn't the same everywhere you do it" --kicker "Vibe coding" --og
```

Panels keep their true aspect ratio — four 16:9 frames forced into a 1200x630 OG shape become
letterboxed strips and stop reading, so the canvas is as tall as the grid needs (1200x826 for
a 2x2) and `--og` writes the cropped OG variant alongside it.

**Feed it the unbranded `art/` frames, not the `og/` cards**, or every panel arrives carrying
its own brand band.

`gen --dry-run` prints the grid, the total cost and the exact prompt the first cell would
send, without calling anything. Use it whenever `-n` looks ambitious.

## What a run leaves behind

```
out/2026-08-13_honey-trap-questions/
├── report.html      the contact sheet — open this
├── README.md        orientation note
├── manifest.json    every cell: the exact prompt, model, tier, cost, duration
├── og/              branded, 1200x630, ready to ship
└── art/             the unbranded renders
```

## Video

Same grid, same styles, same brand band — the band is burned into every frame with ffmpeg
from the identical overlay the stills use, so a card and its animation cannot drift apart.
Each video cell also yields a poster frame branded as an ordinary OG card.

| alias | model | price | audio | clip lengths |
|---|---|---|---|---|
| `sora2` | `openai/sora-2` | $0.10/sec | **yes** | 4, 8, 12s |
| `veo31` | `google/veo-3.1` | $0.40/sec with audio, $0.20 without | **yes** | 4, 6, 8s |
| `kling25` | `kwaivgi/kling-v2.5-turbo-pro` | $0.07/sec | no | 5, 10s |
| `seedance` | `bytedance/seedance-1-pro` | $0.06/sec @720p | no | 5, 10s |

Only Sora and Veo return synced dialogue, so those two are the only options when the clip
has to say something. Sora is four times cheaper per second than Veo with audio on. Note
Veo's price tier is **audio on/off, not resolution** — 1080p costs the same as 720p.

Feed a still you already like in as the first frame: `--ref out/<run>/art/<card>.png`.
`--seconds` picks the clip length; each model has its own permitted set and falls back to
its default rather than erroring.

## The studio

Phase 2 shipped: **og.matewishkey.com** — projects, contact sheets, picks, layouts,
collections, style proof sheets and concept packs, running this same `src/` library in a
Cloudflare container. Invite-only; the `web/` and `engine/` directories are its code, and
`CLAUDE.md` carries the ops notes.

## Licence

MIT. Fraunces, Manrope and JetBrains Mono are bundled under the SIL Open Font License; each
licence sits beside the fonts in `brand/fonts/`.
