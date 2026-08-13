# mwk-og-image-generator

Generate OG images from **a style and a prompt**, across several AI models at once, and put
your branding on every result — the same way, every time.

The premise: picking an OG image is a *comparison* problem, not a generation problem. One
render from one model tells you nothing. Sixteen renders across four models and four looks,
laid out on one page, tells you immediately which direction is right. At roughly $0.05 an
image that comparison costs less than the time spent staring at a single disappointing one.

**Status: phase 1 — the prompt workflow.** A CLI. No web UI yet.

```
mwk-og gen -p "a recruiter asks a honey-trap question and the candidate pauses too long" \
           --ref refs/me.jpg \
           --title "Honey-trap questions that catch AI candidates" \
           --kicker "Mate Wish Key" -n 2
```

That renders every style you have across the default four models, brands all of them, and
writes a contact sheet you open in a browser.

## The two axes

A **style** is a *look* — medium, lighting, palette, camera, how a real face should be
treated. It says nothing about what is happening. A **prompt** is what is happening. They
are independent on purpose:

- Found a look you like? Keep the style, feed it new prompts forever.
- Got an idea and no look? `brainstorm` invents styles from it.
- Not sure? Run the prompt through every style at once and look at them side by side.

Styles are plain YAML in `styles/`, so a good one is a file you keep, edit and commit.

## Branding is composited, not generated

The AI makes artwork. The brand band — logo, headline, accent rule — is drawn by code with
`sharp`.

This is not a shortcut, it is the correct answer. Image models cannot draw the same logo
twice, and text they render is a lottery. Compositing gives pixel-identical branding, in
about 50ms, for $0.00, on every image forever. Correspondingly every generated prompt ends
with an instruction to render *no* text and to keep the bottom fifth of the frame calm, so
the band always has somewhere quiet to land.

Layout and palette live in `brand/brand.json`. Point `logo.file` at your own mark and change
the colours — nothing else is Mate Wish Key-specific.

`mwk-og brand <file> --title "..."` re-brands any image with no API call at all, which is
also how you re-title a card without paying to regenerate it.

## Models

One Replicate token covers all of them, including OpenAI's — which is the reason this
targets Replicate rather than four separate APIs.

| alias | model | per image | references |
|---|---|---|---|
| `nano2` * | `google/nano-banana-2` | $0.067 (1K) | up to 14 |
| `gpt2` * | `openai/gpt-image-2` | $0.047 (medium) | up to 10 |
| `seedream` * | `bytedance/seedream-4` | $0.030 | up to 10 |
| `kontext` * | `black-forest-labs/flux-kontext-max` | $0.080 | **1 only** |
| `kontext-pro` | `black-forest-labs/flux-kontext-pro` | $0.040 | 1 only |
| `nanopro` | `google/nano-banana-pro` | $0.150 (1K) | up to 14 |
| `gpt15` | `openai/gpt-image-1.5` | $0.050 (medium) | up to 10 |

`*` = the default sweep. They are chosen to fail differently: `nano2` holds a likeness,
`gpt2` follows instructions, `seedream` is cheap and stylises hard, `kontext` comes from a
different aesthetic lineage entirely. `mwk-og models` prints the current list.

`gpt2` is the slow one — measured at 35–64s an image against 10–14s for the other three, so
it sets the wall-clock of any sweep it is in. It is also the only one that renders legible
text. Drop it with `-m nano2,seedream,kontext` when you want a fast look around.

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
gen         render a sweep: styles x models x iterations, then brand every result
brainstorm  invent new styles from an idea and save them as style files
styles      list the styles you have
models      list the models, their reference limits and their per-image price
brand       re-brand an image you already have (no API call, no cost)
```

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

## Coming later

Video is the same shape — a style, a prompt, a model that happens to return frames — and
Replicate hosts `openai/sora-2` at $0.10/second. The model registry has room for it. The
web UI is phase 2.

## Licence

MIT. Manrope is bundled under the SIL Open Font License; see `brand/fonts/OFL.txt`.
