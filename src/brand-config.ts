/**
 * BrandConfig — the shape of brand/brand.json and of every brand_kit.config
 * row in the studio.
 *
 * PURE module (zod only, no node imports): the web worker imports the schema
 * to validate kit edits before they can ever reach the renderer, and the
 * engine parses instead of casting. brand.ts re-exports the types so its
 * consumers are unchanged.
 *
 * NOT .strict(): brand.json carries "$comment" documentation keys the seeded
 * kit must survive; unknown keys are stripped, never fatal.
 */

import { z } from 'zod';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be #rrggbb');
const opacity = z.number().min(0).max(1);

const FontSpecSchema = z.object({
  family: z.string().min(1),
  /** Font FILE path inside the engine image — fixed assets, not kit payload. */
  file: z.string().min(1),
  size: z.number().int().min(8).max(120),
  weight: z.number().int().min(100).max(1000),
  /**
   * R2 key of an UPLOADED font (TTF/OTF). When set, the engine materialises it
   * to a temp file and rewrites `file` before rendering; `family` must be the
   * face's internal name-table family (parsed from the file at upload — pango
   * silently falls back to DejaVu on a mismatch, so it is never hand-typed).
   */
  fileKey: z.string().optional(),
});

export const BrandConfigSchema = z
  .object({
    canvas: z.object({
      width: z.number().int().min(600).max(4000),
      height: z.number().int().min(300).max(4000),
    }),
    colors: z.object({
      paper: hex,
      ink: hex,
      mute: hex,
      faint: hex,
      red: hex,
      redField: hex,
      /** The ACCENT: emphasis (*word*) and kickers render in this at text size. */
      redDeep: hex,
      line: hex,
      onRed: hex,
    }),
    /**
     * Optional DARK palette: same nine roles, overlaid onto `colors` when a
     * design renders with theme 'dark'. Absent = the kit renders identically
     * in both themes. Partial on purpose — override only what changes.
     */
    colorsDark: z
      .object({
        paper: hex,
        ink: hex,
        mute: hex,
        faint: hex,
        red: hex,
        redField: hex,
        redDeep: hex,
        line: hex,
        onRed: hex,
      })
      .partial()
      .optional(),
    scrim: z.object({ startY: z.number().int().min(0), opacity }),
    band: z.object({
      height: z.number().int().min(60).max(300),
      opacity,
      ruleHeight: z.number().int().min(0).max(20),
    }),
    logo: z.object({
      /** Path inside the engine image, or (over the seam) a markKey-materialised temp path. */
      mark: z.string().min(1),
      size: z.number().int().min(24).max(200),
      markScale: z.number().min(0.2).max(1),
      x: z.number().int().min(0).max(400),
    }),
    title: FontSpecSchema.extend({ gap: z.number().int().min(0).max(120) }),
    kicker: FontSpecSchema.extend({
      trackingEm: z.number().min(0).max(1),
      gapBelow: z.number().int().min(0).max(60),
    }),
    tagline: FontSpecSchema.extend({ gapAbove: z.number().int().min(0).max(60) }),
  })
  .refine((b) => b.scrim.startY < b.canvas.height, {
    message: 'scrim.startY must sit inside the canvas',
  })
  .refine((b) => b.logo.size <= b.band.height, {
    message: 'the RedBlock must fit inside the band',
  });

export type BrandConfig = z.infer<typeof BrandConfigSchema>;
export type FontSpec = z.infer<typeof FontSpecSchema>;
