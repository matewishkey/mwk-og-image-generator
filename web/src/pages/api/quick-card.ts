/**
 * POST /api/quick-card — the one-call surface for sibling projects (mwk-social
 * et al.) and the studio CLI: an image in, branded card(s) out. Bearer-token
 * friendly like every /api route.
 *
 *   { image: <base64 png/jpeg/webp> | referenceId: <library id>,
 *     template: <layout id|slug>, title?, kicker?, tagline?,
 *     theme?: 'light'|'dark', formatIds?: [<id|slug>…], brandKitId? }
 *   -> { designs: [{ id, url, format }], referenceId }
 */

import type { APIRoute } from 'astro';
import { ENV } from '../../lib/runtime';
import { err, ok, readJson } from '../../lib/api';
import { quickCard } from '../../lib/quick';

export const POST: APIRoute = async (ctx) => {
  const team = ctx.locals.team;
  const user = ctx.locals.user;
  if (!team || !user) return err(403, 'no team');

  const body = await readJson<{
    image?: string;
    referenceId?: string;
    template?: string;
    title?: string;
    kicker?: string;
    tagline?: string;
    theme?: string;
    formatIds?: string[];
    brandKitId?: string;
  }>(ctx.request);
  if (!body?.template) return err(400, 'template (layout id or slug) is required');
  if (!body.image && !body.referenceId) return err(400, 'send image (base64) or referenceId');

  let files: File[] | undefined;
  if (body.image) {
    const b64 = body.image.replace(/^data:[^,]*,/, '');
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } catch {
      return err(400, 'image is not valid base64');
    }
    files = [new File([bytes.buffer as ArrayBuffer], 'quick-upload', { type: 'application/octet-stream' })];
  }

  try {
    const result = await quickCard(ENV, team.id, user.id, {
      referenceId: body.referenceId,
      files,
      template: body.template,
      title: body.title,
      kicker: body.kicker,
      tagline: body.tagline,
      theme: body.theme === 'dark' ? 'dark' : undefined,
      formatIds: body.formatIds,
      brandKitId: body.brandKitId,
    });
    return ok(result, 201);
  } catch (e) {
    return err(422, (e as Error).message);
  }
};
