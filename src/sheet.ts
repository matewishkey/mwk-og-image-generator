/**
 * The contact sheet.
 *
 * A sweep is only useful if you can see all of it at once, so every run writes a
 * `report.html` next to its images. It is deliberately a single self-contained file with
 * relative image paths: drop the run directory on the share and it renders as-is.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunManifest } from './run.ts';
import type { Style } from './style.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const usd = (n: number): string => `$${n.toFixed(3).replace(/0$/, '')}`;

export async function writeSheet(
  manifest: RunManifest,
  styles: Style[],
  outDir: string,
): Promise<string> {
  const byStyle = new Map<string, typeof manifest.cells>();
  for (const c of manifest.cells) {
    if (!byStyle.has(c.style)) byStyle.set(c.style, []);
    byStyle.get(c.style)!.push(c);
  }

  const sections = [...byStyle.entries()]
    .map(([slug, cells]) => {
      const style = styles.find((s) => s.slug === slug);
      const cards = cells
        .map((c) => {
          if (c.error) {
            return `<figure class="card failed">
  <div class="ph">failed</div>
  <figcaption><b>${esc(c.model)}</b> · #${c.iteration}<br><span class="err">${esc(c.error)}</span></figcaption>
</figure>`;
          }
          return `<figure class="card">
  <a href="${esc(c.ogFile!)}" target="_blank"><img src="${esc(c.ogFile!)}" alt="${esc(c.style)} by ${esc(c.model)}" loading="lazy"></a>
  <figcaption><b>${esc(c.model)}</b> · #${c.iteration} · ${esc(c.tier)} · ${usd(c.costUsd)} · ${c.seconds}s
    <a class="raw" href="${esc(c.artFile!)}" target="_blank">unbranded</a></figcaption>
</figure>`;
        })
        .join('\n');

      return `<section>
  <h2>${esc(style?.name ?? slug)} <span class="slug">${esc(slug)}</span></h2>
  ${style?.description ? `<p class="desc">${esc(style.description)}</p>` : ''}
  ${style ? `<details><summary>look</summary><p>${esc(style.look)}</p></details>` : ''}
  <div class="grid">${cards}</div>
</section>`;
    })
    .join('\n');

  const failed = manifest.cells.filter((c) => c.error).length;

  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(manifest.title || manifest.idea)} — OG sweep</title>
<style>
  :root { --bg:#0d1014; --panel:#14181e; --line:#232c3a; --ink:#f4f2f6; --mute:#a8a2b0; --faint:#7c7686; --red:#e2342b; }
  * { box-sizing:border-box }
  body { margin:0; padding:40px clamp(16px,4vw,56px); background:var(--bg); color:var(--ink);
         font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif }
  header { border-bottom:1px solid var(--line); padding-bottom:24px; margin-bottom:36px }
  h1 { margin:0 0 6px; font-size:clamp(22px,3vw,30px); letter-spacing:-.01em }
  .idea { color:var(--mute); max-width:70ch; margin:0 0 16px }
  .meta { display:flex; flex-wrap:wrap; gap:8px }
  .pill { background:var(--panel); border:1px solid var(--line); border-radius:999px;
          padding:4px 12px; font-size:13px; color:var(--mute) }
  .pill b { color:var(--ink); font-weight:600 }
  h2 { font-size:19px; margin:0 0 4px; display:flex; align-items:baseline; gap:10px }
  .slug { font:12px ui-monospace,monospace; color:var(--faint); font-weight:400 }
  .desc { color:var(--mute); margin:0 0 10px; max-width:70ch }
  details { margin:0 0 16px; max-width:70ch }
  summary { cursor:pointer; color:var(--faint); font-size:13px }
  details p { color:var(--mute); font-size:14px; border-left:2px solid var(--line); padding-left:12px }
  section { margin-bottom:48px }
  .grid { display:grid; gap:20px; grid-template-columns:repeat(auto-fill,minmax(min(420px,100%),1fr)) }
  .card { margin:0; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden }
  .card img { width:100%; display:block; aspect-ratio:1200/630; object-fit:cover }
  figcaption { padding:10px 12px; font-size:13px; color:var(--mute) }
  figcaption b { color:var(--ink) }
  .raw { float:right; color:var(--faint) }
  a { color:inherit }
  .failed { opacity:.6 }
  .ph { aspect-ratio:1200/630; display:grid; place-items:center; color:var(--faint);
        background:repeating-linear-gradient(45deg,#14181e,#14181e 10px,#171c23 10px,#171c23 20px) }
  .err { color:var(--red); font-size:12px }
</style>
<header>
  <h1>${esc(manifest.title || manifest.idea)}</h1>
  <p class="idea">${esc(manifest.idea)}</p>
  <div class="meta">
    <span class="pill"><b>${manifest.cells.length}</b> images</span>
    <span class="pill"><b>${byStyle.size}</b> styles</span>
    <span class="pill"><b>${new Set(manifest.cells.map((c) => c.model)).size}</b> models</span>
    <span class="pill">spent <b>${usd(manifest.actualUsd)}</b></span>
    ${failed ? `<span class="pill"><b>${failed}</b> failed</span>` : ''}
    <span class="pill">${esc(manifest.startedAt.slice(0, 16).replace('T', ' '))}</span>
  </div>
</header>
${sections}
`;

  const path = join(outDir, 'report.html');
  await writeFile(path, html, 'utf8');
  return path;
}

/** The orientation note miniserve renders under the folder index on the share. */
export async function writeReadme(
  manifest: RunManifest,
  outDir: string,
  reportUrlHint: string,
): Promise<string> {
  const ok = manifest.cells.filter((c) => !c.error);
  const lines = [
    `# ${manifest.title || manifest.idea}`,
    '',
    `**Open [report.html](${reportUrlHint}) — that's the contact sheet.** Everything below is just the receipts.`,
    '',
    `- Idea: ${manifest.idea}`,
    `- ${ok.length} images across ${new Set(ok.map((c) => c.style)).size} styles and ${new Set(ok.map((c) => c.model)).size} models`,
    `- Spent: $${manifest.actualUsd.toFixed(2)}`,
    `- \`og/\` is branded and ready to ship, \`art/\` is the unbranded render`,
    `- \`manifest.json\` has the exact prompt sent to each model`,
    '',
  ];
  const failed = manifest.cells.filter((c) => c.error);
  if (failed.length) {
    lines.push(`## ${failed.length} failed`, '');
    for (const f of failed) lines.push(`- \`${f.style}\` / \`${f.model}\` #${f.iteration} — ${f.error}`);
    lines.push('');
  }
  const path = join(outDir, 'README.md');
  await writeFile(path, lines.join('\n'), 'utf8');
  return path;
}
