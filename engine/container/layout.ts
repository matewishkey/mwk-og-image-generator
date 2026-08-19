/**
 * The layout engine: LayoutConfig + panel buffers -> one finished design.
 *
 * Ported from the proven 20-variant prototype (2026-08-14). A layout is data; this
 * renders it deterministically for $0.00. The lockup reuses brandOverlay — including
 * the rail, which is the same band laid out against the height and rotated. One
 * renderer, always.
 */

import sharp from 'sharp';
import { brandOverlay, decorateText, textLayer, type BrandConfig } from '../../src/brand.ts';
import {
  layoutPanels,
  type Cell,
  type ChipStyle,
  type LayoutConfig,
  type Shape,
  type TextSpec,
} from '../../src/seam.ts';

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

/** A composite layer with its stacking order. seq keeps the sort stable-by-construction. */
interface ZLayer {
  input: Buffer;
  top: number;
  left: number;
  z: number;
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
async function chip(text: string, brand: BrandConfig, scale: number, style?: ChipStyle): Promise<Buffer> {
  const size = Math.max(9, Math.round(11 * scale));
  // `font:` names the face so an UPLOADED kicker font actually applies — but
  // only when one is present: adding it unconditionally would change how the
  // baked font rasterises and break pixel identity for every existing layout.
  const fontAttr = brand.kicker.fileKey ? { font: `${brand.kicker.family} ${size}` } : {};
  const t = await sharp({
    text: {
      text: `<span weight="700" letter_spacing="${Math.round(0.16 * size * 1024)}" foreground="${brand.colors[style?.text ?? 'redDeep']}">${text.toUpperCase().replace(/[<>&'"]/g, '')}</span>`,
      fontfile: brand.kicker.file,
      ...fontAttr,
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
      <rect width="${w}" height="${h}" fill="${brand.colors[style?.plate ?? 'paper']}" fill-opacity="0.88"/>
      <rect width="3" height="${h}" fill="${brand.colors[style?.rule ?? 'red']}"/></svg>`),
  )
    .composite([{ input: t, top: 6, left: 10 }])
    .png()
    .toBuffer();
}

/** Where a chip sits inside its cell rect. Presets always use 'tl'. */
async function chipAt(
  label: string,
  brand: BrandConfig,
  scale: number,
  r: { x: number; y: number; w: number; h: number },
  style?: ChipStyle,
): Promise<{ input: Buffer; top: number; left: number }> {
  const input = await chip(label, brand, scale, style);
  const md = await sharp(input).metadata();
  const cw = md.width ?? 0;
  const ch = md.height ?? 0;
  const corner = style?.corner ?? 'tl';
  const left = corner === 'tl' || corner === 'bl' ? r.x + 12 : r.x + r.w - cw - 12;
  const top = corner === 'tl' || corner === 'tr' ? r.y + 12 : r.y + r.h - ch - 12;
  return { input, top, left };
}

/** Where the lockup goes. The band is NOT always a bottom strip. */
async function lockup(
  place: LayoutConfig['lockup'],
  brand: BrandConfig,
  W: number,
  H: number,
  text: { title?: string; kicker?: string; tagline?: string },
  box?: LayoutConfig['lockupBox'],
): Promise<{ input: Buffer; top: number; left: number }[]> {
  const bandH = Math.round(brand.band.height * (W / brand.canvas.width));
  if (place === 'none') return [];
  if (place === 'bottom')
    return [
      {
        input: await brandOverlay(brand, W, H, text, box?.scrim === false ? { scrim: false } : undefined),
        top: 0,
        left: 0,
      },
    ];
  if (place === 'top')
    return [{ input: await brandOverlay(brand, W, bandH, text, { scrim: false }), top: 0, left: 0 }];
  if (place === 'inset') {
    const w = Math.round(W * (box?.width ?? 0.56));
    return [
      {
        input: await brandOverlay(brand, w, bandH, text, { scrim: false }),
        top: box?.y != null ? Math.round(H * box.y) : H - bandH - Math.round(H * 0.06),
        left: Math.round(W * (box?.x ?? 0.05)),
      },
    ];
  }
  if (place === 'corner') {
    const w = Math.round(W * (box?.width ?? 0.4));
    return [
      {
        input: await brandOverlay(brand, w, bandH, text, { scrim: false }),
        top: Math.round(H * (box?.y ?? 0.05)),
        left: Math.round(W * (box?.x ?? 0.05)),
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

/** Turn an archetype + a canvas into panel rectangles.
 *  `split` nudges the mosaic/diptych/stack ratio; when unset every expression
 *  is the original — that is what keeps old layouts pixel-identical. */
function placeRects(
  kind: NonNullable<LayoutConfig['archetype']>,
  W: number,
  H: number,
  bandReserve: number,
  g: number,
  split?: number,
): Rect[] {
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
      const fw = Math.round(W * (split ?? 0.58));
      const ch = half(gh, g);
      return [
        { x: 0, y: 0, w: fw, h: gh },
        { x: fw + g, y: 0, w: W - fw - g, h: ch, featherLeft: true },
        { x: fw + g, y: ch + g, w: W - fw - g, h: gh - ch - g, featherLeft: true, featherTop: true },
      ];
    }
    case 'diptych': {
      const cw = split ? Math.round((W - g) * split) : half(W, g);
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
      const rh = split ? Math.round((gh - g) * split) : Math.round((gh - g) / 2);
      return [
        { x: 0, y: 0, w: W, h: rh },
        { x: 0, y: rh + g, w: W, h: gh - rh - g, featherTop: true },
      ];
    }
    case 'hero':
      return [{ x: 0, y: 0, w: W, h: gh }];
  }
}

/** Alpha ramp fading OUT toward one edge of the cell's own rect. Distinct from
 *  ramp(): that one fades IN from a leading edge for the grow-over-neighbour
 *  preset semantics, and its SVG must not change. */
function edgeRamp(w: number, h: number, f: number, side: 'left' | 'right' | 'top' | 'bottom'): Buffer {
  const coords = {
    left: `x1="0" y1="0" x2="${f}" y2="0"`,
    right: `x1="${w}" y1="0" x2="${w - f}" y2="0"`,
    top: `x1="0" y1="0" x2="0" y2="${f}"`,
    bottom: `x1="0" y1="${h}" x2="0" y2="${h - f}"`,
  }[side];
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" ${coords} gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="1"/>
    </linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`);
}

/** Fade a freeform cell inside its own rect on the listed edges. */
async function insetMask(buf: Buffer, w: number, h: number, f: number, edges: Cell['feather']): Promise<Buffer> {
  if (!edges?.length) return buf;
  let out = buf;
  for (const edge of edges) {
    const cap = Math.min(f, edge === 'left' || edge === 'right' ? w : h);
    out = await sharp(out)
      .composite([{ input: edgeRamp(w, h, cap, edge), blend: 'dest-in' }])
      .png()
      .toBuffer();
  }
  return out;
}

/** Freeform cells: 0-1 fractions -> px, rounding EDGES not sizes so shared
 *  borders never leak a 1px seam. y maps into the panel area (above any band). */
function cellRects(cells: Cell[], W: number, H: number, bandReserve: number): { r: Rect; cell: Cell }[] {
  const gh = H - bandReserve;
  return cells.map((cell) => {
    const x0 = Math.min(W, Math.round(cell.x * W));
    const x1 = Math.min(W, Math.round(Math.min(1, cell.x + cell.w) * W));
    const y0 = Math.min(gh, Math.round(cell.y * gh));
    const y1 = Math.min(gh, Math.round(Math.min(1, cell.y + cell.h) * gh));
    return { r: { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }, cell };
  });
}

/** One furniture shape as a full-canvas SVG layer. */
function shapeSvg(s: Shape, brand: BrandConfig, W: number, H: number): Buffer {
  const x = Math.round(s.x * W);
  const y = Math.round(s.y * H);
  const w = Math.max(1, Math.round(s.w * W));
  // A rule is a rect that never collapses below 2px.
  const h = Math.max(s.kind === 'rule' ? 2 : 1, Math.round(s.h * H));
  const color = brand.colors[s.color];
  let body: string;
  if (s.kind === 'gradient') {
    const a = ((s.angle ?? 0) * Math.PI) / 180;
    const [dx, dy] = [Math.cos(a) / 2, Math.sin(a) / 2];
    body = `<defs><linearGradient id="s" x1="${0.5 - dx}" y1="${0.5 - dy}" x2="${0.5 + dx}" y2="${0.5 + dy}">
      <stop offset="0" stop-color="${color}" stop-opacity="${s.opacity}"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#s)"/>`;
  } else {
    body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" fill-opacity="${s.opacity}"/>`;
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`);
}

/** Freeform text layers. x/w map to the canvas width, y is the INK TOP (pango
 *  trims to the glyphs); fonts are the kit's three faces scaled by sizeScale. */
async function renderTexts(
  texts: TextSpec[],
  brand: BrandConfig,
  W: number,
  H: number,
  text: { title?: string; kicker?: string; tagline?: string },
): Promise<ZLayer[]> {
  const roleValue = {
    projectTitle: text.title,
    projectKicker: text.kicker,
    projectTagline: text.tagline,
  } as const;
  const out: ZLayer[] = [];
  for (const t of texts) {
    const content = typeof t.content === 'string' ? t.content : roleValue[t.content.role];
    if (!content?.trim()) continue; // unbound role: skip the layer, never render a placeholder
    // `font` sets the size baseline and defaults; `face` (round 8c) swaps only
    // the typeface — always one of the kit's faces, never a hand-typed family.
    const spec = brand[t.face ?? t.font];
    const scale = (W / brand.canvas.width) * t.sizeScale;
    const size = Math.min(400, Math.max(8, Math.round((t.size ?? brand[t.font].size) * scale)));
    const layer = await textLayer({
      text: t.case === 'upper' ? content.toUpperCase() : content,
      font: { ...spec, size, ...(t.weight ? { weight: t.weight } : {}) },
      color: brand.colors[t.color],
      accent: brand.colors[t.accentColor ?? 'redDeep'],
      trackingEm: t.trackingEm ?? (t.font === 'kicker' ? brand.kicker.trackingEm : undefined),
      width: Math.max(20, Math.round(t.w * W)),
      // 'accent' = single underline in the kit's accent (redDeep) by default.
      underline: t.underline ? (t.underline === 'accent' ? 'single' : t.underline) : undefined,
      underlineColor: t.underlineColor
        ? brand.colors[t.underlineColor]
        : t.underline === 'accent'
          ? brand.colors.redDeep
          : undefined,
      highlight: t.highlight ? brand.colors[t.highlight] : undefined,
      highlightAlpha: t.highlightAlpha,
      strike: t.strike,
    });
    // Shadow/stroke grow the canvas by `pad` on every side; alignment is
    // computed from the INK width and the pad subtracted after, so the text
    // itself stays exactly where an undecorated layer would sit.
    const dec =
      t.stroke || t.shadow
        ? await decorateText(layer, {
            stroke: t.stroke ? brand.colors[t.stroke] : undefined,
            strokeWidth: t.stroke ? (t.strokeWidth ?? 0.05) * size : undefined,
            shadow: t.shadow ? brand.colors[t.shadow] : undefined,
            shadowBlur: t.shadow ? (t.shadowBlur ?? 0.1) * size : undefined,
            shadowOffset: t.shadow ? (t.shadowOffset ?? 0.05) * size : undefined,
          })
        : { ...layer, pad: 0 };
    const boxW = Math.round(t.w * W);
    const left =
      t.align === 'center'
        ? Math.round(t.x * W + (boxW - layer.width) / 2)
        : t.align === 'right'
          ? Math.round(t.x * W + boxW - layer.width)
          : Math.round(t.x * W);
    out.push({
      input: dec.buf,
      top: Math.round(t.y * H) - dec.pad,
      left: Math.max(0, left) - dec.pad,
      z: t.z,
    });
  }
  return out;
}

export async function renderDesign(
  cfg: LayoutConfig,
  brand: BrandConfig,
  W: number,
  H: number,
  text: { title?: string; kicker?: string; tagline?: string },
  panels: PanelInput[],
): Promise<Buffer> {
  const needed = layoutPanels(cfg);
  if (needed === 0) throw new Error('layout has neither archetype nor cells');
  if (panels.length < needed) {
    throw new Error(`${cfg.cells ? 'cells' : cfg.archetype} needs ${needed} panels, got ${panels.length}`);
  }

  const bandH = Math.round(brand.band.height * (W / brand.canvas.width));
  const bandReserve = (cfg.lockupBox?.reserve ?? cfg.lockup === 'bottom') ? bandH : 0;
  const feather = cfg.seam === 'feather' ? Math.round(((cfg.feather ?? 168) * W) / 1200) : 0;
  const order = cfg.order?.length ? cfg.order : panels.map((_, i) => i);
  const chipScale = W / 1200;

  const layers: ZLayer[] = [];

  if (cfg.cells?.length) {
    // Freeform: place each cell, fade inside its own rect, chip per chipStyle.
    for (const [i, { r, cell }] of cellRects(cfg.cells, W, H, bandReserve).entries()) {
      const panel = panels[order[i % order.length]! % panels.length]!;
      const crop = cell.crop ?? cfg.crop;
      const resized = await sharp(panel.buf)
        .resize(r.w, r.h, {
          fit: cell.fit,
          position: crop === 'centre' ? 'centre' : sharp.strategy[crop],
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
      const treated = await treat(resized, cell.treat ?? cfg.treats?.[i], brand.colors.red);
      // Freeform feather width follows cfg.feather regardless of `seam`.
      const faded = await insetMask(treated, r.w, r.h, Math.round(((cfg.feather ?? 168) * W) / 1200), cell.feather);
      layers.push({ input: faded, top: r.y, left: r.x, z: cell.z });
      if (cfg.labels && cfg.cells.length > 1 && panel.label) {
        const c = await chipAt(panel.label, brand, chipScale, r, cfg.chipStyle);
        layers.push({ ...c, z: cell.z }); // right after its cell, same z: stable sort keeps them adjacent
      }
    }
  } else {
    // Preset path — the original loop, byte-for-byte semantics, all at z 0.
    const rects = placeRects(cfg.archetype!, W, H, bandReserve, cfg.seam === 'hairline' ? 2 : 0, cfg.split);
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
      layers.push({ ...(await maskPanel(treated, r, feather)), z: 0 });
      if (cfg.labels && rects.length > 1 && panel.label) {
        if (cfg.chipStyle) {
          layers.push({ ...(await chipAt(panel.label, brand, chipScale, r, cfg.chipStyle)), z: 0 });
        } else {
          layers.push({ input: await chip(panel.label, brand, chipScale), top: r.y + 12, left: r.x + 12, z: 0 });
        }
      }
    }
  }

  for (const s of cfg.shapes ?? []) layers.push({ input: shapeSvg(s, brand, W, H), top: 0, left: 0, z: s.z });
  layers.push(...(await renderTexts(cfg.texts ?? [], brand, W, H, text)));

  // Stable sort by z (legacy configs are all z 0 — a no-op), lockup ALWAYS last.
  layers.sort((a, b) => a.z - b.z);
  const composite: { input: Buffer; top: number; left: number }[] = layers.map(({ input, top, left }) => ({ input, top, left }));
  composite.push(...(await lockup(cfg.lockup, brand, W, H, text, cfg.lockupBox)));

  return sharp({
    create: { width: W, height: H, channels: 4, background: brand.colors[cfg.background ?? 'line'] },
  })
    .composite(composite)
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
