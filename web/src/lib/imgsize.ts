/**
 * Image dimensions from file headers — no image library, because sharp cannot run in
 * workerd and the dimensions are money: the FLUX 2 family bills per input megapixel,
 * so a reference row must carry real width/height for estimates to be honest.
 */

export interface ImageInfo {
  mime: string;
  ext: string;
  width: number;
  height: number;
}

export function sniffImage(buf: ArrayBuffer): ImageInfo | null {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);

  // PNG: 8-byte signature, then IHDR with width/height at offsets 16/20.
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { mime: 'image/png', ext: '.png', width: dv.getUint32(16), height: dv.getUint32(20) };
  }

  // JPEG: scan markers for a SOF segment (C0-CF except C4/C8/CC).
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let off = 2;
    while (off + 9 < b.length) {
      if (b[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = b[off + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          mime: 'image/jpeg',
          ext: '.jpg',
          height: dv.getUint16(off + 5),
          width: dv.getUint16(off + 7),
        };
      }
      off += 2 + dv.getUint16(off + 2);
    }
    return null;
  }

  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X.
  if (
    b.length > 30 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (fourcc === 'VP8X') {
      const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
      const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
      return { mime: 'image/webp', ext: '.webp', width: w, height: h };
    }
    if (fourcc === 'VP8 ') {
      const w = dv.getUint16(26, true) & 0x3fff;
      const h = dv.getUint16(28, true) & 0x3fff;
      return { mime: 'image/webp', ext: '.webp', width: w, height: h };
    }
    if (fourcc === 'VP8L') {
      const bits = dv.getUint32(21, true);
      return {
        mime: 'image/webp',
        ext: '.webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
  }
  return null;
}
