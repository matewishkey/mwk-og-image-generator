/**
 * Download a whole render set as one zip: ?collection=<id> bundles every
 * design in the collection, ?design=<id> bundles just one. PNGs are already
 * compressed, so entries are STORED (level 0) — the zip is a wrapper, not a
 * squeeze. Filenames are `<project>-<format>.png`, ready to upload.
 */

import type { APIRoute } from 'astro';
import { zipSync } from 'fflate';
import { ENV } from '../../../../lib/runtime';
import { err } from '../../../../lib/api';

export const GET: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team || !ctx.locals.user) return err(403, 'no team');
  // Direct lookup, NOT loadProject: archived projects (the hidden _quick and
  // _style-proofs) must still zip — this is a read-only team-scoped export.
  const project = await ENV.DB.prepare(
    `SELECT id, slug FROM project WHERE team_id = ?1 AND slug = ?2`,
  )
    .bind(team.id, ctx.params.slug!)
    .first<{ id: string; slug: string }>();
  if (!project) return err(404, 'no such project');
  const slug = project.slug;

  const collectionId = ctx.url.searchParams.get('collection');
  const designId = ctx.url.searchParams.get('design');
  const takeIds = (ctx.url.searchParams.get('takes') ?? '').split(',').filter(Boolean);
  const designIds = (ctx.url.searchParams.get('designs') ?? '').split(',').filter(Boolean);
  if (!collectionId && !designId && !takeIds.length && !designIds.length)
    return err(400, 'send ?collection=<id>, ?design=<id>, ?takes=<id,…> or ?designs=<id,…>');
  if (takeIds.length > 40 || designIds.length > 40) return err(400, 'at most 40 ids per zip');

  // ?takes= — hand-picked takes, RAW art plus branded card each (thumbnails
  // want the bandless art). Named by the speakable ordinal (1.3), numbered over
  // ALL of the shot's takes so the name matches what chat and the tiles say.
  if (takeIds.length) {
    const marks = takeIds.map((_, i) => `?${i + 3}`).join(',');
    const rows = await ENV.DB.prepare(
      `SELECT id, shot_pos, ord, art_key, card_key FROM (
         SELECT t.id, t.art_key, t.card_key, sh.position AS shot_pos,
                ROW_NUMBER() OVER (PARTITION BY t.shot_id ORDER BY t.created_at, t.id) AS ord
           FROM take t JOIN shot sh ON sh.id = t.shot_id JOIN run r ON r.id = t.run_id
          WHERE r.project_id = ?1 AND t.team_id = ?2)
        WHERE id IN (${marks})`,
    )
      .bind(project.id, team.id, ...takeIds)
      .all<{ id: string; shot_pos: number; ord: number; art_key: string | null; card_key: string | null }>();
    if (rows.results.length !== takeIds.length) return err(404, 'unknown take in the list');

    const files: Record<string, Uint8Array> = {};
    for (const t of rows.results) {
      for (const [key, tag] of [[t.art_key, 'art'], [t.card_key, 'card']] as const) {
        if (!key) continue;
        const obj = await ENV.BUCKET.get(key);
        if (obj) files[`${slug}-${t.shot_pos}.${t.ord}-${tag}.png`] = new Uint8Array(await obj.arrayBuffer());
      }
    }
    if (!Object.keys(files).length) return err(404, 'the files are missing from storage');
    return zipResponse(files, `${slug}-takes.zip`);
  }

  // ?designs= — several finished designs in one archive.
  if (designIds.length) {
    const marks = designIds.map((_, i) => `?${i + 3}`).join(',');
    const rows = await ENV.DB.prepare(
      `SELECT d.id, d.r2_key, d.theme, f.slug AS format_slug
         FROM design d JOIN format f ON f.id = d.format_id
        WHERE d.project_id = ?1 AND d.team_id = ?2 AND d.id IN (${marks})
        ORDER BY d.created_at`,
    )
      .bind(project.id, team.id, ...designIds)
      .all<{ id: string; r2_key: string; theme: string; format_slug: string }>();
    if (!rows.results.length) return err(404, 'nothing to zip');

    const files: Record<string, Uint8Array> = {};
    for (const r of rows.results) {
      const obj = await ENV.BUCKET.get(r.r2_key);
      if (!obj) continue;
      const name = `${slug}-${r.format_slug}${r.theme === 'dark' ? '-dark' : ''}-${r.id.slice(-4).toLowerCase()}.png`;
      files[name] = new Uint8Array(await obj.arrayBuffer());
    }
    if (!Object.keys(files).length) return err(404, 'the rendered files are missing from storage');
    return zipResponse(files, `${slug}-designs.zip`);
  }

  const rows = await ENV.DB.prepare(
    `SELECT d.r2_key, d.theme, f.slug AS format_slug FROM design d JOIN format f ON f.id = d.format_id
      WHERE d.project_id = ?1 AND d.team_id = ?2
        AND ((?3 IS NOT NULL AND d.collection_id = ?3) OR (?4 IS NOT NULL AND d.id = ?4))
      ORDER BY d.created_at`,
  )
    .bind(project.id, team.id, collectionId, designId)
    .all<{ r2_key: string; theme: string; format_slug: string }>();
  if (!rows.results.length) return err(404, 'nothing to zip');

  const files: Record<string, Uint8Array> = {};
  for (const r of rows.results) {
    const obj = await ENV.BUCKET.get(r.r2_key);
    if (!obj) continue;
    const name = `${slug}-${r.format_slug}${r.theme === 'dark' ? '-dark' : ''}.png`;
    files[name] = new Uint8Array(await obj.arrayBuffer());
  }
  if (!Object.keys(files).length) return err(404, 'the rendered files are missing from storage');

  return zipResponse(files, `${slug}-designs.zip`);
};

function zipResponse(files: Record<string, Uint8Array>, filename: string): Response {
  const zipped = zipSync(files, { level: 0 });
  return new Response(zipped.buffer as ArrayBuffer, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
