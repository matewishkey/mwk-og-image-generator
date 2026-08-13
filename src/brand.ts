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

export interface FontSpec {
  family: string;
  file: string;
  size: number;
  weight: number;
}

export interface BrandConfig {
  canvas: { width: number; height: number };
  colors: {
    paper: string;
    ink: string;
    mute: string;
    faint: string;
    red: string;
    redField: string;
    redDeep: string;
    line: string;
    onRed: string;
  };
  scrim: { startY: number; opacity: number };
  band: { height: number; opacity: number; ruleHeight: number };
  logo: { mark: string; size: number; markScale: number; x: number };
  title: FontSpec & { gap: number };
  kicker: FontSpec & { trackingEm: number; gapBelow: number };
}

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
async function textLayer(opts: {
  text: string;
  font: FontSpec;
  color: string;
  width: number;
  /** Letter spacing in ems, converted to Pango units (1024 per point). */
  trackingEm?: number;
}): Promise<{ buf: Buffer; width: number; height: number }> {
  const tracking = opts.trackingEm ? Math.round(opts.trackingEm * opts.font.size * 1024) : 0;
  const attrs = [
    `weight="${opts.font.weight}"`,
    `foreground="${opts.color}"`,
    tracking ? `letter_spacing="${tracking}"` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const buf = await sharp({
    text: {
      text: `<span ${attrs}>${esc(opts.text)}</span>`,
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
async function redBlock(b: BrandConfig): Promise<Buffer> {
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
function furnitureSvg(b: BrandConfig): Buffer {
  const { width: W, height: H } = b.canvas;
  const bandY = H - b.band.height;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${b.colors.paper}" stop-opacity="0"/>
      <stop offset="1" stop-color="${b.colors.paper}" stop-opacity="${b.scrim.opacity}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${b.scrim.startY}" width="${W}" height="${H - b.scrim.startY}" fill="url(#scrim)"/>
  <rect x="0" y="${bandY}" width="${W}" height="${b.band.height}" fill="${b.colors.paper}" fill-opacity="${b.band.opacity}"/>
  <rect x="0" y="${bandY}" width="${W}" height="${b.band.ruleHeight}" fill="${b.colors.red}"/>
</svg>`);
}

/** Compose artwork + brand furniture into the finished OG card. */
export async function applyBrand({ art, title, kicker, brand }: BrandOpts): Promise<Buffer> {
  const { width: W, height: H } = brand.canvas;
  const bandY = H - brand.band.height;

  // `attention` crops toward the salient region rather than the centre, which keeps a
  // face in frame when a 16:9 render is squeezed into the wider OG ratio.
  const base = await sharp(art)
    .resize(W, H, { fit: 'cover', position: sharp.strategy.attention })
    .toBuffer();

  const layers: OverlayOptions[] = [{ input: furnitureSvg(brand), top: 0, left: 0 }];

  const block = await redBlock(brand);
  layers.push({
    input: block,
    top: bandY + Math.round((brand.band.height - brand.logo.size) / 2),
    left: brand.logo.x,
  });

  const textLeft = brand.logo.x + brand.logo.size + brand.title.gap;
  const textWidth = W - textLeft - brand.logo.x;

  const kickerText = kicker?.trim();
  const titleText = title?.trim();

  // The text block is centred in the band as a unit, so a card with a kicker and one
  // without both sit optically level against the RedBlock.
  const rendered: { buf: Buffer; height: number; gapAbove: number }[] = [];

  if (kickerText) {
    const k = await textLayer({
      text: kickerText.toUpperCase(),
      font: brand.kicker,
      color: brand.colors.redDeep,
      width: textWidth,
      trackingEm: brand.kicker.trackingEm,
    });
    rendered.push({ buf: k.buf, height: k.height, gapAbove: 0 });
  }

  if (titleText) {
    const t = await textLayer({
      text: titleText,
      font: brand.title,
      color: brand.colors.ink,
      width: textWidth,
    });
    rendered.push({
      buf: t.buf,
      height: t.height,
      gapAbove: kickerText ? brand.kicker.gapBelow : 0,
    });
  }

  const blockHeight = rendered.reduce((sum, r) => sum + r.height + r.gapAbove, 0);
  let cursor = bandY + Math.round((brand.band.height - blockHeight) / 2);
  for (const r of rendered) {
    cursor += r.gapAbove;
    layers.push({ input: r.buf, top: cursor, left: textLeft });
    cursor += r.height;
  }

  return sharp(base).composite(layers).png().toBuffer();
}
