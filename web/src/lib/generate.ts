/**
 * The validated-config loop. The model writes CONFIGS; our engine draws the pixels.
 *
 * gpt-5.6-terra has no response_format (verified against its own schema), so the
 * guarantee is ours: fenced JSON -> parse -> Zod validate -> one repair turn with the
 * error text -> drop what still fails. A malformed variant is dropped, not shown.
 */

import {
  ARCHETYPE_PANELS,
  LayoutConfigSchema,
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

const NamedLayoutSchema = LayoutConfigSchema.extend({
  name: z.string().min(1).max(60),
});

export interface PanelInfo {
  label: string;
  width: number | null;
  height: number | null;
}

export interface LayoutBriefCtx {
  panels: PanelInfo[];
  format: { name: string; width: number; height: number; safe_w: number | null; safe_h: number | null };
}

const LAYOUT_SYSTEM = `You are an art director arranging picked images into one branded share card.
You write LAYOUT CONFIGS as data; a deterministic renderer draws them. You never draw anything.

Return ONLY a JSON array, no prose, no markdown fence. Each element:
{
  "name": "Two To Four Words",
  "archetype": "hero" | "diptych" | "stack" | "triptych" | "mosaic" | "quad" | "filmstrip",
  "seam": "butt" | "hairline" | "feather",
  "feather": 60-400,                    // optional; px at 1200 canvas width; only meaningful with seam "feather"
  "lockup": "bottom" | "top" | "corner" | "inset" | "rail" | "none",
  "labels": true | false,               // per-panel label chips; false for single-panel layouts
  "order": [0, 2, 1],                   // optional; 0-based indexes into the inventory, first = biggest panel
  "treats": [null, "desaturate", "dim"],// optional; per-panel; use sparingly, to make one panel the feature
  "crop": "attention" | "entropy" | "centre"  // optional
}

Panel counts are fixed by archetype: hero=1, diptych=2, stack=2, triptych=3, mosaic=3, quad=4, filmstrip=4.
NEVER propose an archetype needing more panels than the inventory has.
The configs must be genuinely different arrangements — different archetypes and lockups, not
the same grid with a different name. "mosaic" makes its first panel the feature; use "order"
to choose which image carries the card.`;

export function layoutBrief(ctx: LayoutBriefCtx, brief: string, n: number): string {
  const inv = ctx.panels
    .map((p, i) => `  ${i}: "${p.label}"${p.width && p.height ? ` (${p.width}x${p.height})` : ''}`)
    .join('\n');
  const safe =
    ctx.format.safe_w && ctx.format.safe_h
      ? ` Safe area ${ctx.format.safe_w}x${ctx.format.safe_h}, centred — the lockup and anything essential must sit inside it.`
      : '';
  return `Inventory — ${ctx.panels.length} picked image(s), 0-based:
${inv}

Target format: ${ctx.format.name}, ${ctx.format.width}x${ctx.format.height}.${safe}

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
      if (ARCHETYPE_PANELS[config.archetype] > ctx.panels.length) {
        bad.push({ item, error: `${config.archetype} needs more panels than the inventory has` });
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
