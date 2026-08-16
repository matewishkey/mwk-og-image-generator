/**
 * The sharp side of src/effects.ts: apply a finish preset to a finished card.
 * Deterministic, cheap, and applied AFTER the band is composited — the grain
 * or vignette sitting on the band is the point, it reads as one photograph.
 */

import sharp from 'sharp';

export async function applyEffect(
  png: Buffer,
  effect: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const img = sharp(png);
  switch (effect) {
    case 'grain': {
      const noise = await sharp({
        create: {
          width,
          height,
          channels: 3,
          background: { r: 128, g: 128, b: 128 },
          noise: { type: 'gaussian', mean: 128, sigma: 22 },
        },
      })
        .ensureAlpha(0.28)
        .png()
        .toBuffer();
      return img
        .composite([{ input: noise, blend: 'soft-light' }])
        .png()
        .toBuffer();
    }
    case 'vignette': {
      const r = Math.hypot(width, height) / 2;
      const svg = Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
          `<defs><radialGradient id="v" cx="50%" cy="50%" r="${Math.round((r / Math.min(width, height)) * 100)}%">` +
          `<stop offset="55%" stop-color="#000" stop-opacity="0"/>` +
          `<stop offset="100%" stop-color="#000" stop-opacity="0.38"/>` +
          `</radialGradient></defs>` +
          `<rect width="100%" height="100%" fill="url(#v)"/></svg>`,
      );
      return img.composite([{ input: svg, blend: 'multiply' }]).png().toBuffer();
    }
    case 'glow': {
      const blurred = await sharp(png).blur(12).ensureAlpha(0.35).png().toBuffer();
      return img.composite([{ input: blurred, blend: 'screen' }]).png().toBuffer();
    }
    case 'fade': {
      // Lifted blacks (out = in*0.93 + 16) and a touch less saturation.
      return img.linear(0.93, 16).modulate({ saturation: 0.93 }).png().toBuffer();
    }
    default:
      return png;
  }
}
