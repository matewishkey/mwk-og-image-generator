/**
 * The team media library: content-addressed reference photos, stored once,
 * attachable to any project. Upload logic shared by /media and the Shots page.
 */

import { sniffImage } from './imgsize';
import { ulid } from './ulid';

export interface UploadOutcome {
  saved: number;
  errors: string[];
  /** reference ids of everything successfully stored (including deduplicates). */
  ids: string[];
}

export async function uploadReferences(
  env: Env,
  teamId: string,
  files: File[],
): Promise<UploadOutcome> {
  const now = new Date().toISOString();
  let saved = 0;
  const errors: string[] = [];
  const ids: string[] = [];
  for (const file of files) {
    if (file.size > 12 * 1024 * 1024) {
      errors.push(`${file.name} is over 12 MB.`);
      continue;
    }
    const bytes = await file.arrayBuffer();
    const info = sniffImage(bytes);
    if (!info) {
      errors.push(`${file.name} is not a PNG, JPEG or WebP.`);
      continue;
    }
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const key = `teams/${teamId}/refs/${digest}${info.ext}`;
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: info.mime } });
    await env.DB.prepare(
      `INSERT OR IGNORE INTO reference (id, team_id, r2_key, sha256, filename, mime, width, height, bytes, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(ulid(), teamId, key, digest, file.name, info.mime, info.width, info.height, file.size, now)
      .run();
    const row = await env.DB.prepare(`SELECT id FROM reference WHERE team_id=?1 AND sha256=?2`)
      .bind(teamId, digest)
      .first<{ id: string }>();
    if (row) ids.push(row.id);
    saved++;
  }
  return { saved, errors, ids };
}

export interface LibraryRef {
  id: string;
  r2_key: string;
  filename: string;
  /** Friendly, addressable name; falls back to the filename in every display. */
  name: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
  uses: number;
}

export async function listLibrary(env: Env, teamId: string): Promise<LibraryRef[]> {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.r2_key, r.filename, r.name, r.width, r.height, r.created_at,
            (SELECT count(*) FROM reference_use u WHERE u.reference_id = r.id) AS uses
       FROM reference r WHERE r.team_id = ?1 ORDER BY r.created_at DESC`,
  )
    .bind(teamId)
    .all<LibraryRef>();
  return rows.results;
}

/** Set (or clear) a reference's friendly name. Team id in the WHERE is the authz. */
export async function renameReference(
  env: Env,
  teamId: string,
  refId: string,
  name: string,
): Promise<boolean> {
  const r = await env.DB.prepare(`UPDATE reference SET name = ?1 WHERE id = ?2 AND team_id = ?3`)
    .bind(name.trim() || null, refId, teamId)
    .run();
  return r.meta.changes > 0;
}
