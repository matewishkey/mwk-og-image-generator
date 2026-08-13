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
const FRAME_BASE = [
  'Wide 16:9 landscape composition, framed for a social share card.',
  'Keep the bottom fifth of the frame visually calm and uncluttered — no important detail there.',
].join(' ');

/** Default: the band is the only text, so the picture must carry none. */
const NO_TEXT =
  'Render NO text, NO letters, NO numbers, NO logos, NO watermarks, NO captions anywhere in the image.';

/**
 * With --allow-text: text in the picture is wanted, but the brand band still is not, and
 * a model asked for "text" will happily invent a logo if not told otherwise.
 */
const SOME_TEXT = [
  'Any text in the image must be short, correctly spelled English and genuinely legible.',
  'Speech bubbles and on-screen captions are welcome where they carry the joke.',
  'Still render NO logos, NO watermarks and NO brand marks of any kind.',
].join(' ');

function frameRules(allowText: boolean): string {
  return `${FRAME_BASE} ${allowText ? SOME_TEXT : NO_TEXT}`;
}

export interface ComposeOpts {
  style: Style;
  /** What is happening — the per-image idea. */
  idea: string;
  /** True when reference images are attached, which changes how we address the subject. */
  hasRefs: boolean;
  /**
   * Who the reference person is *within* the scene, e.g. "the interviewer".
   *
   * Needed whenever the scene contains more than one person. Left unsaid, models guess,
   * and they guess differently: on the 2026-08-13 honeypot run, nano-banana-2 correctly
   * cast the reference as the interviewer while gpt-image-2 put him on the monitor as the
   * candidate — the exact opposite of the point being made. Naming the role, and saying
   * plainly that everyone else is someone else, fixed it.
   */
  refRole?: string;
  /**
   * Let the model draw text inside the picture — speech bubbles, captions, signage.
   *
   * Off by default because only GPT Image 2 spells reliably and the brand band already
   * carries the words. Worth turning on for cartoon/comic styles where the bubble IS the
   * gag, and worth checking the spelling on every result when you do.
   */
  allowText?: boolean;
  /** Extra free-text appended verbatim, for one-off nudges. */
  extra?: string;
}

export function compose({ style, idea, hasRefs, refRole, allowText, extra }: ComposeOpts): string {
  const parts: string[] = [];

  parts.push(idea.trim());

  if (hasRefs && refRole?.trim()) {
    parts.push(
      `ROLE ASSIGNMENT: the person in the reference image(s) is ${refRole.trim()}, and only ` +
        `that person. Every other person in the scene is a different individual and must not ` +
        `resemble the reference image(s) in face, hair or build.`,
    );
  }

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

  parts.push(frameRules(allowText ?? false));

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
