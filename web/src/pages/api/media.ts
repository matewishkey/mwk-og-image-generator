import type { APIRoute } from 'astro';
import { ENV } from '../../lib/runtime';
import { err, ok, readJson } from '../../lib/api';
import { listLibrary, renameReference, uploadReferences } from '../../lib/media';

export const GET: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team) return err(403, 'no team');
  const refs = await listLibrary(ENV, team.id);
  return ok({
    references: refs.map((r) => ({
      id: r.id,
      name: r.name,
      filename: r.filename,
      width: r.width,
      height: r.height,
      uses: r.uses,
      created_at: r.created_at,
    })),
  });
};

export const POST: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  if (!team) return err(403, 'no team');
  const body = await readJson<{
    action?: string;
    ref?: string;
    name?: string;
    files?: { name: string; data: string }[];
  }>(ctx.request);
  if (!body) return err(400, 'send a JSON body (content-type: application/json)');

  if (body.action === 'rename') {
    if (!body.ref) return err(400, 'ref is required');
    const done = await renameReference(ENV, team.id, body.ref, body.name ?? '');
    if (!done) return err(404, 'no such reference');
    return ok({ ok: true });
  }

  // Chat/CLI upload: base64 files into the content-deduped library — the same
  // uploadReferences the media page and quick-card use, so sniffing and dedupe
  // rules cannot drift.
  if (body.action === 'upload') {
    if (!body.files?.length) return err(400, 'files [{name, data}] is required');
    if (body.files.length > 12) return err(400, 'at most 12 files per call');
    const files: File[] = [];
    for (const f of body.files) {
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(f.data.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0));
      } catch {
        return err(400, `${f.name} is not valid base64`);
      }
      files.push(new File([bytes.buffer as ArrayBuffer], f.name || 'upload', { type: 'application/octet-stream' }));
    }
    const up = await uploadReferences(ENV, team.id, files);
    return ok({ saved: up.saved, errors: up.errors, ids: up.ids });
  }

  return err(400, 'action must be rename or upload');
};
