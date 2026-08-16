/**
 * Finish-pass presets — a deterministic "after effect" applied to a finished
 * design as the LAST render step, engine-side. Never an AI pass: a model
 * cannot preserve the band or the type, which is settled (see CLAUDE.md,
 * "Branding is composited, never generated").
 *
 * This module is PURE (no node imports) so the web worker can list presets.
 * The sharp implementation lives in engine/container/effects.ts.
 */

export interface EffectSpec {
  slug: string;
  label: string;
  /** One line for the picker. */
  blurb: string;
}

export const EFFECTS: EffectSpec[] = [
  { slug: 'grain', label: 'Grain', blurb: 'Fine film grain over the whole card — takes the digital edge off.' },
  { slug: 'vignette', label: 'Vignette', blurb: 'Corners fall off gently; the centre carries the card.' },
  { slug: 'glow', label: 'Glow', blurb: 'Soft bloom on the highlights — screens and lights breathe.' },
  { slug: 'fade', label: 'Fade', blurb: 'Lifted blacks and a touch less saturation — quiet, printed feel.' },
];

export const isEffect = (slug: string): boolean => EFFECTS.some((e) => e.slug === slug);
