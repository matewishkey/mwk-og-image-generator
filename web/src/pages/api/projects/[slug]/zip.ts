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
  if (!collectionId && !designId) return err(400, 'send ?collection=<id> or ?design=<id>');

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

  const zipped = zipSync(files, { level: 0 });
  return new Response(zipped.buffer as ArrayBuffer, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${slug}-designs.zip"`,
      'cache-control': 'no-store',
    },
  });
};
