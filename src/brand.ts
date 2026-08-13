/**
 * The brand layer — composited by code, never generated.
 *
 * Image models cannot draw a logo the same way twice and cannot be trusted with text,
 * so the AI makes artwork and this makes the card. Same input, same pixels, every time,
 * for $0.00. The prompt side (see prompt.ts) tells the model to keep the bottom of the
 * frame calm precisely so the band has somewhere quiet to land.
 */

import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { OverlayOptions } from 'sharp';

export interface BrandConfig {
  canvas: { width: number; height: number };
  colors: { ground: string; accent: string; accentSoft: string; ink: string; mute: string };
  scrim: { startY: number; opacity: number };
  band: { height: number; opacity: number; ruleHeight: number };
  logo: { file: string; height: number; x: number };
  title: { size: number; weight: number; gap: number; maxLines: number };
  kicker: { size: number; weight: number; tracking: number };
  font: { family: string; file: string };
}

export async function loadBrand(path = 'brand/brand.json'): Promise<BrandConfig> {
  return JSON.parse(await readFile(path, 'utf8')) as BrandConfig;
}

export interface BrandOpts {
  /** The generated artwork, any size. */
  art: Buffer;
  /** Headline on the card. Falsy renders a bare band with just the mark. */
  title?: string;
  /** Small red line above the title — a section, series or handle. */
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
 * Render a line of text to RGBA pixels.
 *
 * dpi is pinned at 72 so that one point is one pixel and the sizes in brand.json can be
 * read as pixels. `width` only sets a wrap boundary — the returned image is trimmed to
 * the text, so the caller must read the real size back off the metadata to place it.
 */
async function textLayer(
  text: string,
  opts: { brand: BrandConfig; size: number; weight: number; color: string; width: number; tracking?: number },
): Promise<{ buf: Buffer; width: number; height: number }> {
  const attrs = [
    `weight="${opts.weight}"`,
    `foreground="${opts.color}"`,
    opts.tracking ? `letter_spacing="${opts.tracking}"` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const buf = await sharp({
    text: {
      text: `<span ${attrs}>${esc(text)}</span>`,
      font: `${opts.brand.font.family} ${opts.size}`,
      fontfile: opts.brand.font.file,
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

/** The scrim + band + accent rule, as one SVG overlay. */
function furnitureSvg(b: BrandConfig): Buffer {
  const { width: W, height: H } = b.canvas;
  const bandY = H - b.band.height;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${b.colors.ground}" stop-opacity="0"/>
      <stop offset="1" stop-color="${b.colors.ground}" stop-opacity="${b.scrim.opacity}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${b.scrim.startY}" width="${W}" height="${H - b.scrim.startY}" fill="url(#scrim)"/>
  <rect x="0" y="${bandY}" width="${W}" height="${b.band.height}" fill="${b.colors.ground}" fill-opacity="${b.band.opacity}"/>
  <rect x="0" y="${bandY}" width="${W}" height="${b.band.ruleHeight}" fill="${b.colors.accent}"/>
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

  const logoSvg = await readFile(brand.logo.file);
  const logo = await sharp(logoSvg, { density: 600 })
    .resize({ height: brand.logo.height })
    .png()
    .toBuffer();
  const logoMeta = await sharp(logo).metadata();
  const logoW = logoMeta.width ?? brand.logo.height;
  const logoTop = bandY + Math.round((brand.band.height - brand.logo.height) / 2);
  layers.push({ input: logo, top: logoTop, left: brand.logo.x });

  const textLeft = brand.logo.x + logoW + brand.title.gap;
  const textWidth = W - textLeft - brand.logo.x;

  const kickerText = kicker?.trim();
  const titleText = title?.trim();

  // The text block is centred in the band as a unit, so a card with a kicker and one
  // without both sit optically level against the mark.
  const rendered: { buf: Buffer; height: number; gapAbove: number }[] = [];

  if (kickerText) {
    const k = await textLayer(kickerText.toUpperCase(), {
      brand,
      size: brand.kicker.size,
      weight: brand.kicker.weight,
      color: brand.colors.accentSoft,
      width: textWidth,
      tracking: brand.kicker.tracking,
    });
    rendered.push({ buf: k.buf, height: k.height, gapAbove: 0 });
  }

  if (titleText) {
    const t = await textLayer(titleText, {
      brand,
      size: brand.title.size,
      weight: brand.title.weight,
      color: brand.colors.ink,
      width: textWidth,
    });
    rendered.push({ buf: t.buf, height: t.height, gapAbove: kickerText ? 10 : 0 });
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
