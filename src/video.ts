/**
 * Video output: poster frames and burning the brand band into the footage.
 *
 * Same reasoning as the stills — the band is drawn by code, not asked for in the prompt —
 * except the compositing is done by ffmpeg over every frame. `brandOverlay()` in brand.ts
 * produces the artwork for both paths, so a card and its animation cannot drift apart.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { brandOverlay, type BrandConfig } from './brand.ts';

const run = promisify(execFile);

/** ffmpeg writes its progress to stderr and returns 0; only a non-zero exit is a failure. */
async function ffmpeg(args: string[]): Promise<void> {
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      maxBuffer: 1 << 24,
    });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`ffmpeg failed: ${(err.stderr || err.message).trim().slice(0, 300)}`);
  }
}

/**
 * First frame of a video, as PNG bytes.
 *
 * Doubles as the way we learn the video's dimensions — ffprobe is not installed on this
 * box, and reading the extracted frame with sharp answers the same question without
 * adding a dependency.
 */
export async function posterFrame(videoPath: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'mwk-og-poster-'));
  try {
    const out = join(dir, 'poster.png');
    await ffmpeg(['-i', videoPath, '-frames:v', '1', out]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Burn the brand band into every frame.
 *
 * Audio is stream-copied rather than re-encoded — Sora and Veo return synced dialogue, and
 * a needless re-encode would cost quality for nothing. `-shortest` is deliberately absent:
 * the overlay is a still image input and would otherwise decide the output duration.
 */
export async function brandVideo(
  videoPath: string,
  outPath: string,
  brand: BrandConfig,
  text: { title?: string; kicker?: string },
): Promise<{ width: number; height: number }> {
  const poster = await posterFrame(videoPath);
  const { width = 0, height = 0 } = await sharp(poster).metadata();
  if (!width || !height) throw new Error(`Could not read video dimensions from ${videoPath}`);

  const overlay = await brandOverlay(brand, width, height, text);

  const dir = await mkdtemp(join(tmpdir(), 'mwk-og-band-'));
  try {
    const bandPath = join(dir, 'band.png');
    await writeFile(bandPath, overlay);
    await ffmpeg([
      '-i', videoPath,
      '-i', bandPath,
      '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto[v]',
      '-map', '[v]',
      // Only map audio if the source has any, or ffmpeg errors on a silent input.
      '-map', '0:a?',
      '-c:a', 'copy',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outPath,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  return { width, height };
}
