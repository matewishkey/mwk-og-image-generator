---
name: mwk-media
description: >
  Generate branded media with the MWK studio: OG images, YouTube-style
  thumbnails, social cards, music stings, video clips. Use when mate asks to
  generate/brainstorm/compose pictures or thumbnails, try styles, make a card
  from an image, pick takes ("I like 1.3"), or download results. DECOMMISSIONED
  2026-09-01 — the studio it drove (og.matewishkey.com) no longer exists, so
  every command here fails; read the warning before acting on any of it.
---

# mwk-media — the studio operator playbook

> ## ⛔ DECOMMISSIONED 2026-09-01 — do not run these commands
>
> The studio this playbook drives is **gone**. On 2026-09-01 the workers
> `mwk-studio` and `mwk-studio-engine`, the D1 database, the R2 bucket and the
> domain `og.matewishkey.com` were all deleted from Cloudflare at mate's request.
> The host does not resolve.
>
> **Every `studio` command below will fail**, including `studio run` — it renders
> images on this box, but it still POSTs to the web worker to create the run
> first, so it dies at the same place as the rest. There is no fallback path and
> no site for mate to watch.
>
> If mate asks for generated media, say the studio was retired and offer the
> Phase 1 CLI instead (`node src/cli.ts` — sweeps, brand, montage, music, video),
> which is untouched and writes files locally. Do not try to "fix" a failing
> command here, and do not stand the infrastructure back up without asking.
>
> The recipes in `recipes.md` are still the real vocabulary and still useful as
> prompt patterns. The data is archived at
> `~/share/work/mat-mwk-og-image-generator/2026-09-01_cloudflare-teardown/`.

You (Claude) are the hands; the site is mate's eyes. **Every action ends by
handing mate a URL.** Print the run URL the moment a run exists, never only at
the end.

## Preflight (once per session)

```bash
cd ~/projects/mwk-og-image-generator
set -a; eval "$(sops -d ~/projects/td-sops/apps/mwk-og-image-generator.enc.env)"; set +a
```

That loads `MWK_STUDIO_TOKEN` (and the rest) without printing values. The CLI
is `node src/cli.ts …` from the repo root — there is no installed `mwk-og`
binary. `node src/cli.ts studio help` is the live command list; trust it over
any doc.

## The loop (most-used: thumbnails, a few refs, several styles)

1. **Refs in**: `studio upload-ref <files…>` → ids; `studio attach <slug> <refId>`;
   `studio ref-role <slug> "<who the reference is>"` for ANY scene with 2+ people.
2. **Project**: `studio create -n "<name>" -s <style> -s <style2> …` (style SET;
   first = primary). Draft models default cheap (`zturbo,pimage`). Browse styles:
   `studio styles` or https://og.matewishkey.com/styles
3. **Shots**: `studio add-shot <slug> -p "<scene, no medium/palette>" --label <word>`.
   Style is the LOOK, prompt is the SCENE — never mix the axes. `{shot N}` chains
   a character from shot N's picked take.
4. **Run**: `studio run <slug>` — renders ON THIS BOX (direct-ingest; the
   td-sops env from the preflight is required) and prints each cell as it
   lands. The run contact-sheet URL (`/projects/<slug>/runs/<runId>`) prints
   immediately: hand it to mate, it fills in live. `--engine` falls back to
   the Cloudflare container.
5. **Describe + pick**: fetch a few `art_thumb` images via
   `curl -H "authorization: Bearer $MWK_STUDIO_TOKEN" <base>/img/<key>` and LOOK
   at them; describe takes by their speakable numbers ("1.3 has the best grin").
   Mate answers with numbers → `studio pick <slug> 1.3`.
6. **Finish**: rerun the winners on gpt2 (`studio set <slug> -m gpt2` +
   `studio reshoot <slug> <shot>`). Draft cheap, finish on gpt2 — never explore
   on the expensive model.
7. **Deliver**: `studio zip <slug> --takes 1.3,2.1,…` prints one zip URL (raw
   art + branded card per take; thumbnails want the raw art). `--out <file>`
   downloads it locally instead.

Cards/designs: `studio compose <slug> --takes 1.3,2.1` renders EVERY template
matching that picture count with those takes (tap order = panel order; $0
composites) and prints ONE results URL showing exactly that set; `--template
<slug>` composes just one (`studio templates <slug>` lists them). Words ride
`--title/--kicker/--tagline`. `studio quick --image <f> --template <slug>` for
no-project one-offs; fine control stays on `/projects/<slug>/design`.

Music: `node src/cli.ts music …`; video models ride `gen`. Same axes rules.

## Recipes

Named patterns mate can ask for by name — definitions in [recipes.md](recipes.md).

## House rules that bind you

- Always print the cost estimate before confirming a run happened; money lives
  at https://og.matewishkey.com/history — never quote a price from memory.
- Take numbers are permanent: never renumber, never reuse.
- Deep model lore (input quirks, prices, prompt-fidelity pins) lives in the
  repo's CLAUDE.md — read it before touching model maps.
