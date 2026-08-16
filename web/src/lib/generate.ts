/**
 * The validated-config loop. The model writes CONFIGS; our engine draws the pixels.
 *
 * gpt-5.6-terra has no response_format (verified against its own schema), so the
 * guarantee is ours: fenced JSON -> parse -> Zod validate -> one repair turn with the
 * error text -> drop what still fails. A malformed variant is dropped, not shown.
 */

import {
  layoutPanels,
  LayoutConfigObject,
  seamHeaders,
  type EngineGenerateRequest,
  type LayoutConfig,
} from '../../../src/seam.ts';
import { z } from 'zod';

export async function askEngine(env: Env, req: EngineGenerateRequest): Promise<string> {
  if (!env.ENGINE) throw new Error('ENGINE binding is not configured');
  const body = JSON.stringify(req);
  const res = await env.ENGINE.fetch('https://engine/generate', {
    method: 'POST',
    headers: await seamHeaders(env.SEAM_SECRET, body),
    body,
  });
  if (!res.ok) throw new Error(`generate failed: ${res.status} ${await res.text()}`);
  const parsed = (await res.json()) as { text: string };
  return parsed.text;
}

/** Models wrap JSON in prose or a fence no matter how firmly you ask. */
export function extractJsonArray(raw: string): unknown[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end < 0) throw new Error(`No JSON array in reply:\n${raw.slice(0, 300)}`);
  return JSON.parse(body.slice(start, end + 1)) as unknown[];
}

const NamedLayoutSchema = LayoutConfigObject.extend({
  name: z.string().min(1).max(60),
}).refine((c) => c.archetype != null || (c.cells?.length ?? 0) > 0, {
  message: 'a layout needs an archetype or cells',
});

export interface PanelInfo {
  label: string;
  width: number | null;
  height: number | null;
}

export interface LayoutBriefCtx {
  panels: PanelInfo[];
  format: { name: string; width: number; height: number; safe_w: number | null; safe_h: number | null };
  /** The rendering kit's token->hex palette, so color choices are informed. */
  palette?: Record<string, string>;
  /** band.height / canvas.height of the kit — how much a bottom lockup consumes. */
  bandFrac?: number;
}

const LAYOUT_SYSTEM = `You are an art director arranging picked images into one branded share card.
You write LAYOUT CONFIGS as data; a deterministic renderer draws them. You never draw anything.

Return ONLY a JSON array, no prose, no markdown fence.

MODE A — PRESET. A hand-tuned arrangement:
{
  "name": "Two To Four Words",
  "archetype": "hero" | "diptych" | "stack" | "triptych" | "mosaic" | "quad" | "filmstrip",
  "seam": "butt" | "hairline" | "feather",
  "feather": 60-400,                    // optional; px at 1200 canvas width; only meaningful with seam "feather"
  "lockup": "bottom" | "top" | "corner" | "inset" | "rail" | "none",
  "labels": true | false,               // per-panel label chips; false for single-panel layouts
  "order": [0, 2, 1],                   // optional; 0-based indexes into the inventory, first = biggest panel
  "treats": [null, "desaturate", "dim"],// optional; per-panel; use sparingly, to make one panel the feature
  "crop": "attention" | "entropy" | "centre",  // optional
  "split": 0.2-0.8                      // optional; mosaic feature width / diptych / stack ratio
}
Panel counts are fixed by archetype: hero=1, diptych=2, stack=2, triptych=3, mosaic=3, quad=4, filmstrip=4.

MODE B — FREEFORM. Place everything yourself. Instead of "archetype", give "cells"
(1-8), and optionally "texts" (max 6), "shapes" (max 8), "background", "chipStyle",
"lockupBox". All geometry is 0-1 fractions. Cells map into the panel area (the canvas
minus a reserved bottom band when lockup is "bottom"); texts and shapes map to the FULL canvas.
{
  "name": "...",
  "cells":  [{ "x":0, "y":0, "w":0.65, "h":1, "feather":["right"], "fit":"cover"|"contain",
               "crop":"attention", "treat":"desaturate", "z":0 }],
  "texts":  [{ "content": "literal string" | {"role":"projectTitle"|"projectKicker"|"projectTagline"},
               "font":"title"|"kicker"|"tagline", "x":0.06, "y":0.1, "w":0.5,
               "align":"left"|"center"|"right", "sizeScale":0.3-4, "color":"ink",
               "accentColor":"redDeep", "case":"upper"|"none", "z":60 }],
  "shapes": [{ "kind":"rect"|"rule"|"gradient", "x":0, "y":0.9, "w":1, "h":0.1,
               "color":"red", "opacity":0.9, "angle":0, "z":40 }],
  "background": "paper",
  "chipStyle": { "plate":"paper", "text":"redDeep", "rule":"red", "corner":"tl"|"tr"|"bl"|"br" },
  "lockup": "bottom" | ... | "none",
  "lockupBox": { "width":0-1, "x":0-1, "y":0-1, "reserve":true|false, "scrim":true|false }
}

COLOR RULE: colors are brand TOKEN NAMES only — paper, ink, mute, faint, red, redField,
redDeep, line, onRed. Never hex. Red at text size is only ever "redDeep"; text sitting on a
red field uses "onRed". Never rebuild a red square with shapes — the RedBlock logo lives only
in the lockup.

Z ORDER: cells default 0, shapes 40, texts 60; the lockup always renders last. A cell's
feather fades inside its own rect on the listed edges — use it where cells overlap.
Text "y" is the ink top of the line. Craft guardrails: at most 2 extra text layers beyond a
role-bound title; freeform cards may use lockup "none" with a role-bound projectTitle text
instead. NEVER propose more cells than the inventory has images.

The configs must be genuinely different arrangements — vary archetype/cells, lockups and
scale contrast, not the same grid with a different name. "mosaic" makes its first panel the
feature; use "order" to choose which image carries the card. Mix modes: presets are reliable,
freeform earns its place when it does something a preset cannot.`;

export function layoutBrief(ctx: LayoutBriefCtx, brief: string, n: number): string {
  const inv = ctx.panels
    .map((p, i) => `  ${i}: "${p.label}"${p.width && p.height ? ` (${p.width}x${p.height})` : ''}`)
    .join('\n');
  const safe =
    ctx.format.safe_w && ctx.format.safe_h
      ? ` Safe area ${ctx.format.safe_w}x${ctx.format.safe_h}, centred — the lockup and anything essential must sit inside it.`
      : '';
  const palette = ctx.palette
    ? `\nBrand palette (token: hex — name tokens, never hex): ${Object.entries(ctx.palette)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')}.`
    : '';
  const band = ctx.bandFrac
    ? `\nA bottom lockup's band consumes the bottom ${(ctx.bandFrac * 100).toFixed(0)}% of the canvas; cells sit above it.`
    : '';
  return `Inventory — ${ctx.panels.length} picked image(s), 0-based:
${inv}

Target format: ${ctx.format.name}, ${ctx.format.width}x${ctx.format.height}.${safe}${palette}${band}

Direction from the user: ${brief || 'your call — a varied, confident spread'}

Propose ${n} layout configs.`;
}

export interface GeneratedLayout {
  name: string;
  config: LayoutConfig;
}

/** One generation pass + one repair turn; returns survivors and the drop count. */
export async function generateLayouts(
  env: Env,
  ctx: LayoutBriefCtx,
  brief: string,
  n: number,
): Promise<{ layouts: GeneratedLayout[]; dropped: number }> {
  const raw = await askEngine(env, { prompt: layoutBrief(ctx, brief, n), system: LAYOUT_SYSTEM });

  const validate = (items: unknown[]) => {
    const good: GeneratedLayout[] = [];
    const bad: { item: unknown; error: string }[] = [];
    for (const item of items) {
      const parsed = NamedLayoutSchema.safeParse(item);
      if (!parsed.success) {
        bad.push({ item, error: parsed.error.issues.map((i) => i.message).join('; ') });
        continue;
      }
      const { name, ...config } = parsed.data;
      if (layoutPanels(config) > ctx.panels.length) {
        bad.push({ item, error: `needs ${layoutPanels(config)} panels but the inventory has ${ctx.panels.length}` });
        continue;
      }
      good.push({ name, config });
    }
    return { good, bad };
  };

  let items: unknown[];
  try {
    items = extractJsonArray(raw);
  } catch (e) {
    items = [];
  }
  let { good, bad } = validate(items);

  if (bad.length || good.length === 0) {
    // One repair turn with the error text; still-bad variants are dropped, not shown.
    const repair = await askEngine(env, {
      system: LAYOUT_SYSTEM,
      prompt:
        `${layoutBrief(ctx, brief, bad.length || n)}\n\nYour previous reply had invalid entries:\n` +
        bad.map((b) => `- ${JSON.stringify(b.item)} -> ${b.error}`).join('\n') +
        `\n\nReturn ONLY the corrected JSON array.`,
    });
    try {
      const retry = validate(extractJsonArray(repair));
      good = [...good, ...retry.good];
      bad = retry.bad;
    } catch {
      /* repair failed wholesale; keep what we have */
    }
  }
  return { layouts: good, dropped: bad.length };
}

const SHOT_SYSTEM = `You are a co-writer for image-generation shot prompts on branded share cards.
A shot says WHAT IS HAPPENING — the scene, the subjects, the action, the telling detail.
It must NEVER specify a medium, palette, lighting or camera: the style axis carries those,
and a shot that mentions them breaks the whole comparison grid.

Return ONLY a JSON array of strings, no prose, no fence. Each string is a complete
replacement shot prompt: same core idea, sharper scene. Vary the telling detail and the
staging between variants; keep each under 60 words.
Never introduce trademarked characters, brands or logos — image models refuse them at
render time, and a refused take is money spent on nothing.`;

export async function suggestShotVariants(
  env: Env,
  o: { current: string; projectName: string; otherShots: string[]; n: number },
): Promise<string[]> {
  const raw = await askEngine(env, {
    system: SHOT_SYSTEM,
    prompt:
      `Project: ${o.projectName}\n` +
      (o.otherShots.length
        ? `Other shots in the series (for tone, do not repeat them):\n${o.otherShots.map((s) => `- ${s}`).join('\n')}\n`
        : '') +
      `\nCurrent shot prompt:\n"${o.current}"\n\nPropose ${o.n} improved variants.`,
  });
  const items = extractJsonArray(raw);
  return items.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, o.n);
}
