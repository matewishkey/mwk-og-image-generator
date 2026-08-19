/**
 * Music generation over the SAME Replicate account as everything else — the
 * single-credential property that keeps this project on Replicate.
 *
 * Music is deliberately NOT part of the image sweep pipeline: no styles, no
 * band, no cells — a track is prompt -> model -> audio file. Every price and
 * input field below was read off the model's own Replicate page; re-read the
 * schema before changing an input map (curl -sL replicate.com/<m>/api/schema).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { firstOutput, replicate } from './replicate.ts';

export const MUSIC_PRICES_VERIFIED_ON = '2026-08-19';

export interface MusicOpts {
  prompt: string;
  /** Sung lyrics — REQUIRED by song15 (supports [verse]/[chorus] section tags). */
  lyrics?: string;
  /** Track length in seconds where the model has a knob (stab25, eleven). */
  seconds?: number;
  /** eleven only: allow vocals (its default is instrumental). */
  vocals?: boolean;
  seed?: number;
}

export interface MusicModelSpec {
  id: string;
  alias: string;
  label: string;
  /** Human pricing note, verified MUSIC_PRICES_VERIFIED_ON. */
  price: string;
  /** Estimated USD for one track with the given opts. */
  estimate: (o: MusicOpts) => number;
  notes: string;
  buildInput: (o: MusicOpts) => Record<string, unknown>;
}

export const MUSIC_MODELS: MusicModelSpec[] = [
  {
    id: 'google/lyria-2',
    alias: 'lyria2',
    label: 'Lyria 2',
    price: '$2 per 1000s of output (~$0.06 for its ~30s track)',
    estimate: () => 0.06,
    notes:
      'Instrumental only, 48 kHz stereo, the quality default. No duration knob — it decides (~30s).',
    buildInput: (o) => ({ prompt: o.prompt, ...(o.seed !== undefined ? { seed: o.seed } : {}) }),
  },
  {
    id: 'minimax/music-1.5',
    alias: 'song15',
    label: 'MiniMax Music 1.5',
    price: '$0.03 per track',
    estimate: () => 0.03,
    notes:
      'Full SONGS up to 4 minutes with natural vocals — lyrics are REQUIRED ' +
      '(use [verse] / [chorus] section tags); prompt describes the style.',
    buildInput: (o) => {
      if (!o.lyrics?.trim()) throw new Error('song15 needs --lyrics — it sings them.');
      return {
        lyrics: o.lyrics,
        prompt: o.prompt,
        audio_format: 'mp3',
        bitrate: 256000,
        sample_rate: 44100,
      };
    },
  },
  {
    id: 'stability-ai/stable-audio-2.5',
    alias: 'stab25',
    label: 'Stable Audio 2.5',
    price: '$0.20 per track (any length up to 190s)',
    estimate: () => 0.2,
    notes:
      'Music AND sound design (stingers, idents, ambiences). The only one with a ' +
      'real duration knob: 1-190s.',
    buildInput: (o) => ({
      prompt: o.prompt,
      duration: Math.max(1, Math.min(190, Math.round(o.seconds ?? 60))),
      steps: 8,
      ...(o.seed !== undefined ? { seed: o.seed } : {}),
    }),
  },
  {
    id: 'elevenlabs/music',
    alias: 'eleven',
    label: 'ElevenLabs Music',
    price: '$8.30 per 1000s of output (~$0.25 for 30s, ~$1.50 for a full song)',
    estimate: (o) => ((o.seconds ?? 30) * 8.3) / 1000,
    notes:
      'The premium tier: strongest arrangement control, can sing (its own lyrics) with ' +
      '--vocals; instrumental by DEFAULT. 5-300s.',
    buildInput: (o) => ({
      prompt: o.prompt,
      music_length_ms: Math.max(5000, Math.min(300000, Math.round((o.seconds ?? 30) * 1000))),
      force_instrumental: !o.vocals,
      output_format: 'mp3_high_quality',
    }),
  },
];

export function resolveMusicModel(nameOrAlias: string): MusicModelSpec {
  const key = nameOrAlias.trim().toLowerCase();
  const hit = MUSIC_MODELS.find((m) => m.alias === key || m.id.toLowerCase() === key);
  if (!hit)
    throw new Error(
      `Unknown music model "${nameOrAlias}". Known: ${MUSIC_MODELS.map((m) => m.alias).join(', ')}`,
    );
  return hit;
}

/** Generate one track and write it to outDir. Returns the file path. */
export async function generateTrack(
  spec: MusicModelSpec,
  o: MusicOpts,
  outDir: string,
  name: string,
): Promise<string> {
  const output = await replicate().run(spec.id as `${string}/${string}`, {
    input: spec.buildInput(o),
  });
  const bytes = await firstOutput(output);
  // Extension from the BYTES — Lyria serves 48kHz PCM WAV behind an
  // extension-less URL, so the URL is not evidence of the format.
  const ext = bytes.subarray(0, 4).toString('latin1') === 'RIFF' ? '.wav' : '.mp3';
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `${name}${ext}`);
  await writeFile(file, bytes);
  return file;
}
