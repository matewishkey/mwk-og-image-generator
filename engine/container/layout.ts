/**
 * The layout engine: LayoutConfig + panel buffers -> one finished design.
 *
 * Ported from the proven 20-variant prototype (2026-08-14). A layout is data; this
 * renders it deterministically for $0.00. The lockup reuses brandOverlay — including
 * the rail, which is the same band laid out against the height and rotated. One
 * renderer, always.
 */

import sharp from 'sharp';
import { brandOverlay, type BrandConfig } from '../../src/brand.ts';
import { ARCHETYPE_PANELS, type LayoutConfig } from '../../src/seam.ts';

export interface PanelInput {
  buf: Buffer;
  label?: string;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  featherLeft?: boolean;
  featherTop?: boolean;
}

/** Alpha ramp on a leading edge, so a panel dissolves into the one beneath it. */
function ramp(w: number, h: number, f: number, side: 'left' | 'top'): Buffer {
  const horiz = side === 'left';
  const pct = ((horiz ? f / w : f / h) * 100).toFixed(3);
  const dir = horiz ? `x1="0" y1="0" x2="${pct}%" y2="0"` : `x1="0" y1="0" x2="0" y2="${pct}%"`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" ${dir}>
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="1"/>
    </linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`);
}

async function treat(buf: Buffer, t: string | null | undefined, red: string): Promise<Buffer> {
  if (!t || t === 'none') return buf;
  let s = sharp(buf);
  if (t === 'desaturate') s = s.modulate({ saturation: 0.15 });
  if (t === 'dim') s = s.modulate({ brightness: 0.6 });
  if (t === 'tint') s = s.tint(red);
  return s.png().toBuffer();
}

/** A label chip: mono uppercase on a paper plate with a red rule. */
async function chip(text: string, brand: BrandConfig, scale: number): Promise<Buffer> {
  const size = Math.max(9, Math.round(11 * scale));
  const t = await sharp({
    text: {
      text: `<span weight="700" letter_spacing="${Math.round(0.16 * size * 1024)}" foreground="${brand.colors.redDeep}">${text.toUpperCase().replace(/[<>&'"]/g, '')}</span>`,
      fontfile: brand.kicker.file,
      rgba: true,
      dpi: 72,
      width: 900,
    },
  })
    .png()
    .toBuffer();
  const md = await sharp(t).metadata();
  const w = (md.width ?? 0) + 20;
  const h = (md.height ?? 0) + 12;
  return sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <rect width="${w}" height="${h}" fill="${brand.colors.paper}" fill-opacity="0.88"/>
      <rect width="3" height="${h}" fill="${brand.colors.red}"/></svg>`),
  )
    .composite([{ input: t, top: 6, left: 10 }])
    .png()
    .toBuffer();
}

/** Where the lockup goes. The band is NOT always a bottom strip. */
async function lockup(
  place: LayoutConfig['lockup'],
  brand: BrandConfig,
  W: number,
  H: number,
  text: { title?: string; kicker?: string; tagline?: string },
): Promise<{ input: Buffer; top: number; left: number }[]> {
  const bandH = Math.round(brand.band.height * (W / brand.canvas.width));
  if (place === 'none') return [];
  if (place === 'bottom') return [{ input: await brandOverlay(brand, W, H, text), top: 0, left: 0 }];
  if (place === 'top')
    return [{ input: await brandOverlay(brand, W, bandH, text, { scrim: false }), top: 0, left: 0 }];
  if (place === 'inset') {
    const w = Math.round(W * 0.56);
    return [
      {
        input: await brandOverlay(brand, w, bandH, text, { scrim: false }),
        top: H - bandH - Math.round(H * 0.06),
        left: Math.round(W * 0.05),
      },
    ];
  }
  if (place === 'corner') {
    const w = Math.round(W * 0.4);
    return [
      {
        input: await brandOverlay(brand, w, bandH, text, { scrim: false }),
        top: Math.round(H * 0.05),
        left: Math.round(W * 0.05),
      },
    ];
  }
  if (place === 'rail') {
    // The same lockup laid out against the height, then rotated. One renderer, turned.
    const railH = Math.round(brand.band.height * (H / brand.canvas.width));
    const strip = await brandOverlay(brand, H, railH, text, { scrim: false });
    const rotated = await sharp(strip).rotate(-90).png().toBuffer();
    return [{ input: rotated, top: 0, left: 0 }];
  }
  return [];
}

/** Turn an archetype + a canvas into panel rectangles. */
function placeRects(kind: LayoutConfig['archetype'], W: number, H: number, bandReserve: number, g: number): Rect[] {
  const gh = H - bandReserve;
  const half = (n: number, gap: number) => Math.round((n - gap) / 2);
  switch (kind) {
    case 'quad': {
      const cw = half(W, g);
      const ch = half(gh, g);
      return [
        { x: 0, y: 0, w: cw, h: ch },
        { x: cw + g, y: 0, w: W - cw - g, h: ch, featherLeft: true },
        { x: 0, y: ch + g, w: cw, h: gh - ch - g, featherTop: true },
        { x: cw + g, y: ch + g, w: W - cw - g, h: gh - ch - g, featherLeft: true, featherTop: true },
      ];
    }
    case 'mosaic': {
      const fw = Math.round(W * 0.58);
      const ch = half(gh, g);
      return [
        { x: 0, y: 0, w: fw, h: gh },
        { x: fw + g, y: 0, w: W - fw - g, h: ch, featherLeft: true },
        { x: fw + g, y: ch + g, w: W - fw - g, h: gh - ch - g, featherLeft: true, featherTop: true },
      ];
    }
    case 'diptych': {
      const cw = half(W, g);
      return [
        { x: 0, y: 0, w: cw, h: gh },
        { x: cw + g, y: 0, w: W - cw - g, h: gh, featherLeft: true },
      ];
    }
    case 'triptych': {
      const cw = Math.round((W - g * 2) / 3);
      return [0, 1, 2].map((i) => ({
        x: i * (cw + g),
        y: 0,
        w: i === 2 ? W - 2 * (cw + g) : cw,
        h: gh,
        featherLeft: i > 0,
      }));
    }
    case 'filmstrip': {
      const cw = Math.round((W - g * 3) / 4);
      return [0, 1, 2, 3].map((i) => ({
        x: i * (cw + g),
        y: 0,
        w: i === 3 ? W - 3 * (cw + g) : cw,
        h: gh,
        featherLeft: i > 0,
      }));
    }
    case 'stack': {
      const rh = Math.round((gh - g) / 2);
      return [
        { x: 0, y: 0, w: W, h: rh },
        { x: 0, y: rh + g, w: W, h: gh - rh - g, featherTop: true },
      ];
    }
    case 'hero':
      return [{ x: 0, y: 0, w: W, h: gh }];
  }
}

export async function renderDesign(
  cfg: LayoutConfig,
  brand: BrandConfig,
  W: number,
  H: number,
  text: { title?: string; kicker?: string; tagline?: string },
  panels: PanelInput[],
): Promise<Buffer> {
  const needed = ARCHETYPE_PANELS[cfg.archetype];
  if (panels.length < needed) {
    throw new Error(`${cfg.archetype} needs ${needed} panels, got ${panels.length}`);
  }

  const bandReserve =
    cfg.lockup === 'bottom' ? Math.round(brand.band.height * (W / brand.canvas.width)) : 0;
  const gutter = cfg.seam === 'hairline' ? 2 : 0;
  const rects = placeRects(cfg.archetype, W, H, bandReserve, gutter);
  const feather =
    cfg.seam === 'feather' ? Math.round(((cfg.feather ?? 168) * W) / 1200) : 0;
  const order = cfg.order?.length ? cfg.order : panels.map((_, i) => i);

  const layers: { input: Buffer; top: number; left: number }[] = [];
  for (const [i, r] of rects.entries()) {
    const panel = panels[order[i % order.length]! % panels.length]!;
    const treated = await treat(
      await sharp(panel.buf)
        .resize(r.w + (feather && r.featherLeft ? feather : 0), r.h + (feather && r.featherTop ? feather : 0), {
          fit: 'cover',
          position: cfg.crop === 'centre' ? 'centre' : sharp.strategy[cfg.crop],
        })
        .png()
        .toBuffer(),
      cfg.treats?.[i],
      brand.colors.red,
    );
    layers.push(
      await maskPanel(treated, r, feather),
    );
    if (cfg.labels && rects.length > 1 && panel.label) {
      layers.push({ input: await chip(panel.label, brand, W / 1200), top: r.y + 12, left: r.x + 12 });
    }
  }
  layers.push(...(await lockup(cfg.lockup, brand, W, H, text)));

  return sharp({ create: { width: W, height: H, channels: 4, background: brand.colors.line } })
    .composite(layers)
    .png()
    .toBuffer();
}

/** Apply the feather mask to an already cover-cropped panel buffer. */
async function maskPanel(
  buf: Buffer,
  r: Rect,
  feather: number,
): Promise<{ input: Buffer; top: number; left: number }> {
  const growL = feather && r.featherLeft ? feather : 0;
  const growT = feather && r.featherTop ? feather : 0;
  const w = r.w + growL;
  const h = r.h + growT;
  if (!growL && !growT) return { input: buf, top: r.y, left: r.x };

  let mask = sharp(growL ? ramp(w, h, growL, 'left') : ramp(w, h, 1, 'left'));
  if (growL && growT) {
    mask = sharp(await mask.png().toBuffer()).composite([
      { input: ramp(w, h, growT, 'top'), blend: 'dest-in' },
    ]);
  } else if (growT) mask = sharp(ramp(w, h, growT, 'top'));

  const masked = await sharp(buf)
    .composite([{ input: await mask.png().toBuffer(), blend: 'dest-in' }])
    .png()
    .toBuffer();
  return { input: masked, top: r.y - growT, left: r.x - growL };
}
