/**
 * Prompt composition and style brainstorming.
 *
 * Two jobs:
 *   compose()   style + idea            -> the string a render model actually receives
 *   brainstorm() idea (+ optional refs) -> N new styles, written as ordinary style files
 */

import type { Style } from './style.ts';
import { slugify } from './style.ts';

/**
 * The brand band is composited by code, not drawn by the model (see brand.ts). So every
 * prompt tells the model two things it would otherwise get wrong: don't render text, and
 * keep the bottom of the frame calm so the band has somewhere quiet to sit.
 */
const FRAME_RULES = [
  'Wide 16:9 landscape composition, framed for a social share card.',
  'Keep the bottom fifth of the frame visually calm and uncluttered — no important detail there.',
  'Render NO text, NO letters, NO numbers, NO logos, NO watermarks, NO captions anywhere in the image.',
].join(' ');

export interface ComposeOpts {
  style: Style;
  /** What is happening — the per-image idea. */
  idea: string;
  /** True when reference images are attached, which changes how we address the subject. */
  hasRefs: boolean;
  /** Extra free-text appended verbatim, for one-off nudges. */
  extra?: string;
}

export function compose({ style, idea, hasRefs, extra }: ComposeOpts): string {
  const parts: string[] = [];

  parts.push(idea.trim());
  parts.push(`Visual style: ${style.look.trim()}`);

  if (style.subject.trim()) {
    parts.push(
      hasRefs
        ? `The person in the reference image(s): ${style.subject.trim()} Keep them clearly recognisable as the same person.`
        : `Subject treatment: ${style.subject.trim()}`,
    );
  } else if (hasRefs) {
    parts.push('Use the person in the reference image(s) as the subject, clearly recognisable.');
  }

  parts.push(FRAME_RULES);

  if (style.avoid.trim()) parts.push(`Avoid: ${style.avoid.trim()}`);
  if (extra?.trim()) parts.push(extra.trim());

  return parts.join('\n\n');
}

const BRAINSTORM_SYSTEM = `You are an art director naming distinct visual styles for social share cards (OG images).

A style is a LOOK, never a scene. It must be reusable across completely unrelated subjects.
Never mention the specific idea you were given — it is only a hint about the register the
styles should sit in (funny, technical, dramatic...).

Return ONLY a JSON array, no prose, no markdown fence. Each element:
{
  "name": "Two To Four Words",
  "description": "one line, what this look is for",
  "look": "2-4 sentences: medium, lighting, palette, camera/lens, texture, mood. Concrete and visual.",
  "subject": "1-2 sentences: how a real person should be rendered in this style",
  "avoid": "short comma-separated list of things this style must not do",
  "tags": ["three", "short", "tags"]
}

The styles must be genuinely different from each other — different media, not different
adjectives on the same medium. Vary illustration vs photographic vs 3D vs graphic/flat.`;

export function brainstormPrompt(idea: string, count: number, existing: string[]): string {
  const avoidLine = existing.length
    ? `\n\nStyles that already exist — produce something different from all of these: ${existing.join(', ')}.`
    : '';
  return `Propose ${count} distinct visual styles suited to share cards in the register of this idea:\n\n"${idea}"${avoidLine}`;
}

export interface BrainstormedStyle {
  name: string;
  description: string;
  look: string;
  subject: string;
  avoid: string;
  tags: string[];
}

/** Models like to wrap JSON in prose or a fence no matter how firmly you ask. */
export function parseBrainstorm(raw: string, origin: string): Style[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end < 0) {
    throw new Error(`Brainstorm returned no JSON array. Got:\n${raw.slice(0, 400)}`);
  }

  let items: BrainstormedStyle[];
  try {
    items = JSON.parse(body.slice(start, end + 1));
  } catch (e) {
    throw new Error(`Brainstorm JSON did not parse: ${(e as Error).message}\n${body.slice(0, 400)}`);
  }

  return items.map((it) => ({
    slug: slugify(it.name),
    name: it.name,
    description: it.description ?? '',
    look: it.look,
    subject: it.subject ?? '',
    avoid: it.avoid ?? '',
    refs: [],
    tags: it.tags ?? [],
    origin,
  }));
}

export { BRAINSTORM_SYSTEM };
