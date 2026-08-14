/**
 * Filesystem half of styles: loading and saving `styles/*.yaml`.
 *
 * Kept apart from style.ts so the schema stays importable from runtimes without
 * node:fs. The CLI is the only consumer.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parse, stringify } from 'yaml';
import { StyleSchema, type Style } from './style.ts';

export const STYLES_DIR = 'styles';

export async function loadStyle(slug: string, dir = STYLES_DIR): Promise<Style> {
  const path = slug.endsWith('.yaml') ? slug : join(dir, `${slug}.yaml`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    const available = (await listStyles(dir)).map((s) => s.slug).join(', ') || '(none yet)';
    throw new Error(`No style at ${path}. Available: ${available}`);
  }
  const parsed = StyleSchema.parse(parse(raw));
  return { ...parsed, slug: basename(path, '.yaml') };
}

export async function listStyles(dir = STYLES_DIR): Promise<Style[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const yamls = names.filter((n) => n.endsWith('.yaml') && !n.startsWith('_')).sort();
  return Promise.all(yamls.map((n) => loadStyle(basename(n, '.yaml'), dir)));
}

export async function saveStyle(style: Style, dir = STYLES_DIR): Promise<string> {
  const { slug, ...body } = style;
  const path = join(dir, `${slug}.yaml`);
  await writeFile(path, stringify(body), 'utf8');
  return path;
}
