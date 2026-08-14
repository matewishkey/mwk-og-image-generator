/**
 * Styles are the reusable half of the pipeline.
 *
 * A style is a look, not a picture: it says how things should be rendered and how a
 * real person should be treated, and says nothing about what is happening. The prompt
 * supplies what is happening. That split is the whole point — one style survives many
 * prompts, and one prompt can be shot through many styles.
 *
 * This module is pure on purpose: schema and slug only, no filesystem. The loaders
 * live in style-fs.ts so that prompt.ts (and everything that composes prompts) can run
 * where node:fs does not exist.
 */

import { z } from 'zod';

export const StyleSchema = z.object({
  /** Filename stem. Set by the loader, not written in the file. */
  slug: z.string().optional(),
  name: z.string().min(1),
  description: z.string().default(''),
  /** The visual direction: medium, lighting, palette, camera, mood. */
  look: z.string().min(1),
  /** How a real person in the reference images should be rendered. */
  subject: z.string().default(''),
  /** Things this style must not do. Folded into the prompt as a plain instruction. */
  avoid: z.string().default(''),
  /** Reference images baked into the style itself, relative to the repo root. */
  refs: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  /** Where the style came from — `hand` or the model that brainstormed it. */
  origin: z.string().default('hand'),
});

export type Style = z.infer<typeof StyleSchema> & { slug: string };

/** Turn a free-text name into a filename-safe slug. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}
