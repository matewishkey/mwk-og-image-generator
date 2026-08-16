/**
 * Minimal SFNT (TTF/OTF) name-table parser — the same hand-parser habit as
 * imgsize.ts, and for the same reason: sharp can't run in the worker.
 *
 * Exists because pango resolves `font: "<family> <size>"` against the face's
 * INTERNAL name-table family. A hand-typed family that doesn't match falls back
 * to DejaVu silently — so the family is always parsed from the file, never typed.
 */

export interface FontName {
  family: string;
  subfamily: string;
}

/** Parse the family (nameID 16 preferred, else 1) out of a TTF/OTF. */
export function parseFontName(bytes: ArrayBuffer): FontName | null {
  const dv = new DataView(bytes);
  if (bytes.byteLength < 12) return null;

  const magic = dv.getUint32(0);
  // 0x00010000 = TrueType, 'OTTO' = CFF OpenType, 'true' = old Mac TrueType.
  if (magic !== 0x00010000 && magic !== 0x4f54544f && magic !== 0x74727565) return null;

  const numTables = dv.getUint16(4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > bytes.byteLength) return null;
    const tag = String.fromCharCode(dv.getUint8(rec), dv.getUint8(rec + 1), dv.getUint8(rec + 2), dv.getUint8(rec + 3));
    if (tag === 'name') {
      nameOffset = dv.getUint32(rec + 8);
      break;
    }
  }
  if (nameOffset < 0 || nameOffset + 6 > bytes.byteLength) return null;

  const count = dv.getUint16(nameOffset + 2);
  const stringsStart = nameOffset + dv.getUint16(nameOffset + 4);

  const decode = (platform: number, off: number, len: number): string | null => {
    if (off + len > bytes.byteLength) return null;
    const slice = new Uint8Array(bytes, off, len);
    // Windows (3) and Unicode (0) strings are UTF-16BE; Mac (1) is roughly ASCII.
    if (platform === 3 || platform === 0) {
      let s = '';
      for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode((slice[i]! << 8) | slice[i + 1]!);
      return s;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(slice);
  };

  // Collect candidates: nameID 16 (typographic family) beats 1 (family);
  // Windows records beat Mac when both exist.
  const found = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const rec = nameOffset + 6 + i * 12;
    if (rec + 12 > bytes.byteLength) return null;
    const platform = dv.getUint16(rec);
    const nameId = dv.getUint16(rec + 6);
    if (nameId !== 1 && nameId !== 2 && nameId !== 16 && nameId !== 17) continue;
    const len = dv.getUint16(rec + 8);
    const off = stringsStart + dv.getUint16(rec + 10);
    const value = decode(platform, off, len)?.trim();
    if (!value) continue;
    const key = `${nameId}`;
    // Prefer Windows (platform 3); first record otherwise.
    if (!found.has(key) || platform === 3) found.set(key, value);
  }

  const family = found.get('16') ?? found.get('1');
  if (!family) return null;
  return { family, subfamily: found.get('17') ?? found.get('2') ?? 'Regular' };
}
