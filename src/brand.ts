/**
 * The brand layer — composited by code, never generated.
 *
 * Image models cannot draw a logo the same way twice and cannot be trusted with text,
 * so the AI makes artwork and this makes the card. Same input, same pixels, every time,
 * for $0.00. The prompt side (see prompt.ts) tells the model to keep the bottom of the
 * frame calm precisely so the band has somewhere quiet to land.
 *
 * Everything here follows the published design system at matewishkey.com/design:
 * the RedBlock is the only logo, Fraunces 700 sets display headings, JetBrains Mono 700
 * uppercase sets kickers, and red-deep is the only red permitted at body size.
 */

import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { OverlayOptions } from 'sharp';

// The shape (and its zod schema) lives in brand-config.ts — a PURE module the
// web worker can import; this file pulls in sharp and is worker-excluded.
export type { BrandConfig, FontSpec } from './brand-config.ts';
import type { BrandConfig, FontSpec } from './brand-config.ts';

export async function loadBrand(path = 'brand/brand.json'): Promise<BrandConfig> {
  return JSON.parse(await readFile(path, 'utf8')) as BrandConfig;
}

export interface BrandOpts {
  /** The generated artwork, any size. */
  art: Buffer;
  /** Headline on the card. Falsy renders a bare band with just the RedBlock. */
  title?: string;
  /** Small red label above the title — a section, series or handle. */
  kicker?: string;
  /** Standfirst under the title. Used for the strapline in a wordmark lockup. */
  tagline?: string;
  brand: BrandConfig;
}

/** Pango markup is not HTML; these five are the only escapes it takes. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a run of text to RGBA pixels.
 *
 * dpi is pinned at 72 so one point is one pixel and the sizes in brand.json read as
 * pixels. `width` is only a wrap boundary — the result is trimmed to the glyphs, so the
 * caller must read the real size back off the metadata before placing it.
 *
 * Pango in this environment maps `weight` onto a variable font's wght axis but does NOT
 * support the `font_variations` attribute, so Fraunces' WONK and SOFT axes are out of
 * reach and the face renders at its default optical settings. Verified, not assumed.
 */
/**
 * Split on *asterisk emphasis* and set the emphasised runs in red.
 *
 * The design system writes the wordmark as "Mate *Wish* Key" — middle word in red — and
 * red at body size is only ever allowed as red-deep. Doing it as markup means the wordmark
 * is one string in one place rather than three positioned text layers.
 */
function emphasise(text: string, base: string, accent: string): string {
  return text
    .split(/(\*[^*]+\*)/)
    .filter(Boolean)
    .map((run) =>
      run.startsWith('*') && run.endsWith('*') && run.length > 2
        ? `<span foreground="${accent}">${esc(run.slice(1, -1))}</span>`
        : `<span foreground="${base}">${esc(run)}</span>`,
    )
    .join('');
}

export async function textLayer(opts: {
  text: string;
  font: FontSpec;
  color: string;
  width: number;
  /** Letter spacing in ems, converted to Pango units (1024 per point). */
  trackingEm?: number;
  /** When set, *asterisked* runs render in this colour. */
  accent?: string;
  /** Underline variant; colours are resolved hex (tokens resolve caller-side). */
  underline?: 'single' | 'low';
  underlineColor?: string;
  /** Background highlight. Changes the trimmed geometry — callers opt in. */
  highlight?: string;
  /** 0-1; pango wants 1-65536. */
  highlightAlpha?: number;
  strike?: boolean;
}): Promise<{ buf: Buffer; width: number; height: number }> {
  const tracking = opts.trackingEm ? Math.round(opts.trackingEm * opts.font.size * 1024) : 0;
  const attrs = [
    `weight="${opts.font.weight}"`,
    tracking ? `letter_spacing="${tracking}"` : '',
    opts.underline ? `underline="${opts.underline}"` : '',
    opts.underline && opts.underlineColor ? `underline_color="${opts.underlineColor}"` : '',
    opts.highlight ? `background="${opts.highlight}"` : '',
    opts.highlight && opts.highlightAlpha != null
      ? `background_alpha="${Math.max(1, Math.round(opts.highlightAlpha * 65535))}"`
      : '',
    opts.strike ? 'strikethrough="true"' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const body = opts.accent
    ? emphasise(opts.text, opts.color, opts.accent)
    : `<span foreground="${opts.color}">${esc(opts.text)}</span>`;

  const buf = await sharp({
    text: {
      text: `<span ${attrs}>${body}</span>`,
      font: `${opts.font.family} ${opts.font.size}`,
      fontfile: opts.font.file,
      rgba: true,
      dpi: 72,
      width: opts.width,
      wrap: 'word',
    },
  })
    .png()
    .toBuffer();

  const md = await sharp(buf).metadata();
  return { buf, width: md.width ?? 0, height: md.height ?? 0 };
}

/**
 * The RedBlock: a red square with the white mark centred at 64%, square corners always.
 * The design system is explicit that this is the sole logo and that a red square must
 * never be hand-built alongside it — so it is built once, here.
 */
export async function redBlock(b: BrandConfig): Promise<Buffer> {
  const { size, markScale } = b.logo;
  const markSize = Math.round(size * markScale);

  const mark = await sharp(await readFile(b.logo.mark), { density: 600 })
    .resize({ width: markSize, height: markSize, fit: 'contain', background: '#00000000' })
    .png()
    .toBuffer();
  const markMeta = await sharp(mark).metadata();

  return sharp({
    create: { width: size, height: size, channels: 4, background: b.colors.red },
  })
    .composite([
      {
        input: mark,
        top: Math.round((size - (markMeta.height ?? markSize)) / 2),
        left: Math.round((size - (markMeta.width ?? markSize)) / 2),
      },
    ])
    .png()
    .toBuffer();
}

/** The scrim, the band and the accent rule, as one SVG overlay. */
function furnitureSvg(b: BrandConfig, scrim = true): Buffer {
  const { width: W, height: H } = b.canvas;
  const bandY = H - b.band.height;
  const scrimParts = scrim
    ? `<defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${b.colors.paper}" stop-opacity="0"/>
      <stop offset="1" stop-color="${b.colors.paper}" stop-opacity="${b.scrim.opacity}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${b.scrim.startY}" width="${W}" height="${H - b.scrim.startY}" fill="url(#scrim)"/>`
    : '';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  ${scrimParts}
  <rect x="0" y="${bandY}" width="${W}" height="${b.band.height}" fill="${b.colors.paper}" fill-opacity="${b.band.opacity}"/>
  <rect x="0" y="${bandY}" width="${W}" height="${b.band.ruleHeight}" fill="${b.colors.red}"/>
</svg>`);
}

/**
 * Scale the whole brand config by a factor.
 *
 * The layout is authored at 1200x630. A video frame is 1280x720 or larger, and a band
 * sized for 1200px would sit visibly small on it — so geometry scales with width while
 * the colours and fonts stay put.
 */
function scaleBrand(b: BrandConfig, width: number, height: number): BrandConfig {
  const k = width / b.canvas.width;
  const r = (n: number) => Math.round(n * k);
  return {
    ...b,
    canvas: { width, height },
    scrim: { ...b.scrim, startY: Math.round(height - (b.canvas.height - b.scrim.startY) * k) },
    band: { ...b.band, height: r(b.band.height), ruleHeight: Math.max(1, r(b.band.ruleHeight)) },
    logo: { ...b.logo, size: r(b.logo.size), x: r(b.logo.x) },
    title: { ...b.title, size: r(b.title.size), gap: r(b.title.gap) },
    tagline: { ...b.tagline, size: r(b.tagline.size), gapAbove: r(b.tagline.gapAbove) },
    kicker: { ...b.kicker, size: r(b.kicker.size), gapBelow: r(b.kicker.gapBelow) },
  };
}

/**
 * The brand furniture alone, on transparency, at any size.
 *
 * Exists so the identical band can be composited onto a still by sharp and burned into a
 * video by ffmpeg — one implementation, so a card and its animation cannot drift apart.
 */
export async function brandOverlay(
  brand: BrandConfig,
  width: number,
  height: number,
  text: { title?: string; kicker?: string; tagline?: string },
  /**
   * The scrim exists to blend a photograph into the band. A montage has a hard grid
   * edge above the band instead, and a gradient there just dirties the bottom panels —
   * so montage passes false.
   */
  opts: { scrim?: boolean } = {},
): Promise<Buffer> {
  const b = width === brand.canvas.width && height === brand.canvas.height
    ? brand
    : scaleBrand(brand, width, height);
  const bandY = height - b.band.height;

  const layers: OverlayOptions[] = [
    { input: furnitureSvg(b, opts.scrim ?? true), top: 0, left: 0 },
  ];
  layers.push(...(await bandContents(b, bandY, width, text)));

  return sharp({
    create: { width, height, channels: 4, background: '#00000000' },
  })
    .composite(layers)
    .png()
    .toBuffer();
}

/** The RedBlock plus the kicker/title stack, placed inside the band. */
async function bandContents(
  b: BrandConfig,
  bandY: number,
  width: number,
  text: { title?: string; kicker?: string; tagline?: string },
): Promise<OverlayOptions[]> {
  const layers: OverlayOptions[] = [];

  const block = await redBlock(b);
  layers.push({
    input: block,
    top: bandY + Math.round((b.band.height - b.logo.size) / 2),
    left: b.logo.x,
  });

  const textLeft = b.logo.x + b.logo.size + b.title.gap;
  const textWidth = width - textLeft - b.logo.x;

  const kickerText = text.kicker?.trim();
  const titleText = text.title?.trim();

  // The text block is centred in the band as a unit, so a card with a kicker and one
  // without both sit optically level against the RedBlock.
  const rendered: { buf: Buffer; height: number; gapAbove: number }[] = [];

  if (kickerText) {
    const k = await textLayer({
      text: kickerText.toUpperCase(),
      font: b.kicker,
      color: b.colors.redDeep,
      width: textWidth,
      trackingEm: b.kicker.trackingEm,
    });
    rendered.push({ buf: k.buf, height: k.height, gapAbove: 0 });
  }

  if (titleText) {
    const t = await textLayer({
      text: titleText,
      font: b.title,
      color: b.colors.ink,
      width: textWidth,
      accent: b.colors.redDeep,
    });
    rendered.push({ buf: t.buf, height: t.height, gapAbove: kickerText ? b.kicker.gapBelow : 0 });
  }

  const taglineText = text.tagline?.trim();
  if (taglineText) {
    const g = await textLayer({
      text: taglineText,
      font: b.tagline,
      color: b.colors.mute,
      width: textWidth,
    });
    rendered.push({
      buf: g.buf,
      height: g.height,
      gapAbove: titleText ? b.tagline.gapAbove : 0,
    });
  }

  const blockHeight = rendered.reduce((sum, r) => sum + r.height + r.gapAbove, 0);
  let cursor = bandY + Math.round((b.band.height - blockHeight) / 2);
  for (const r of rendered) {
    cursor += r.gapAbove;
    layers.push({ input: r.buf, top: cursor, left: textLeft });
    cursor += r.height;
  }

  return layers;
}

/** Compose artwork + brand furniture into the finished OG card. */
export async function applyBrand({ art, title, kicker, tagline, brand }: BrandOpts): Promise<Buffer> {
  const { width: W, height: H } = brand.canvas;

  // `attention` crops toward the salient region rather than the centre, which keeps a
  // face in frame when a 16:9 render is squeezed into the wider OG ratio.
  const base = await sharp(art)
    .resize(W, H, { fit: 'cover', position: sharp.strategy.attention })
    .toBuffer();

  const overlay = await brandOverlay(brand, W, H, { title, kicker, tagline });
  return sharp(base).composite([{ input: overlay, top: 0, left: 0 }]).png().toBuffer();
}
