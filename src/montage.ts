/**
 * The montage: several picked cards combined into one branded image.
 *
 * The last step of the workflow. You sweep, you pick a winner per scene off the contact
 * sheet, and this puts them together — for $0.00, because like the band it is drawn rather
 * than generated. Recombining or relabelling costs nothing, so it is worth trying twice.
 *
 * Panels keep their true aspect ratio rather than being squeezed into an OG shape: four
 * 16:9 frames forced into 1200x630 become letterboxed strips, and the pictures stop
 * reading. The default canvas is therefore as tall as the grid needs, and `--og` produces
 * the cropped 1200x630 variant separately for actual OG use.
 */

import sharp from 'sharp';
import type { OverlayOptions } from 'sharp';
import { brandOverlay, textLayer, type BrandConfig } from './brand.ts';

export interface MontageOpts {
  images: Buffer[];
  /** One per image; blank entries simply render no chip. */
  labels?: string[];
  brand: BrandConfig;
  title?: string;
  kicker?: string;
  /** Panels per row. 4 images at 2 gives the 2x2 grid. */
  columns?: number;
  /** Aspect ratio of each panel, width/height. Defaults to 16:9. */
  panelAspect?: number;
  /** Hairline between panels, in pixels. */
  gutter?: number;
}

/** A small mono label chip, sat in the top-left of a panel. */
async function labelChip(brand: BrandConfig, text: string): Promise<Buffer> {
  const padX = 12;
  const padY = 8;
  const t = await textLayer({
    text: text.toUpperCase(),
    font: brand.kicker,
    color: brand.colors.redDeep,
    width: 600,
    trackingEm: brand.kicker.trackingEm,
  });

  const w = t.width + padX * 2;
  const h = t.height + padY * 2;
  const plate = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <rect width="${w}" height="${h}" fill="${brand.colors.paper}" fill-opacity="0.88"/>
      <rect width="3" height="${h}" fill="${brand.colors.red}"/>
    </svg>`,
  );

  return sharp(plate)
    .composite([{ input: t.buf, top: padY, left: padX }])
    .png()
    .toBuffer();
}

export async function montage(opts: MontageOpts): Promise<Buffer> {
  const {
    images,
    labels = [],
    brand,
    title,
    kicker,
    columns = 2,
    panelAspect = 16 / 9,
    gutter = 2,
  } = opts;

  if (!images.length) throw new Error('montage needs at least one image');

  const W = brand.canvas.width;
  const rows = Math.ceil(images.length / columns);
  const panelW = Math.floor((W - gutter * (columns - 1)) / columns);
  const panelH = Math.round(panelW / panelAspect);
  const gridH = panelH * rows + gutter * (rows - 1);
  const H = gridH + brand.band.height;

  // The ground shows through the gutters, so it is the hairline colour.
  const canvas = sharp({
    create: { width: W, height: H, channels: 4, background: brand.colors.line },
  });

  const layers: OverlayOptions[] = [];

  for (const [i, img] of images.entries()) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const left = col * (panelW + gutter);
    const top = row * (panelH + gutter);

    layers.push({
      input: await sharp(img)
        .resize(panelW, panelH, { fit: 'cover', position: sharp.strategy.attention })
        .toBuffer(),
      top,
      left,
    });

    const label = labels[i]?.trim();
    if (label) {
      layers.push({ input: await labelChip(brand, label), top: top + 14, left: left + 14 });
    }
  }

  layers.push({
    input: await brandOverlay(brand, W, H, { title, kicker }, { scrim: false }),
    top: 0,
    left: 0,
  });

  return canvas.composite(layers).png().toBuffer();
}
