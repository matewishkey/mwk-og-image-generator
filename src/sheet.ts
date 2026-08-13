/**
 * The contact sheet.
 *
 * A sweep is only useful if you can see all of it at once, so every run writes a
 * `report.html` next to its images. It is deliberately a single self-contained file with
 * relative image paths: drop the run directory on the share and it renders as-is.
 *
 * Grouping follows the grid: idea first, then style. Idea is the outer axis because when
 * you are iterating a concept the question is "which telling of this works", and the
 * answer is easiest to see with all the tellings stacked apart from each other.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Cell, RunManifest } from './run.ts';
import type { Style } from './style.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const usd = (n: number): string => `$${n.toFixed(3).replace(/0$/, '')}`;

function cardHtml(c: Cell): string {
  if (c.error) {
    return `<figure class="card failed">
  <div class="ph">failed</div>
  <figcaption><b>${esc(c.model)}</b> · #${c.iteration}<br><span class="err">${esc(c.error)}</span></figcaption>
</figure>`;
  }
  // A video cell shows the branded clip itself; the poster card is linked beside it.
  const media = c.videoFile
    ? `<video src="${esc(c.videoFile)}" poster="${esc(c.ogFile!)}" controls preload="none" playsinline></video>`
    : `<a href="${esc(c.ogFile!)}" target="_blank"><img src="${esc(c.ogFile!)}" alt="${esc(c.style)} by ${esc(c.model)}" loading="lazy"></a>`;

  const extras = c.videoFile
    ? `<a class="raw" href="${esc(c.rawVideoFile!)}" target="_blank">unbranded</a> <a class="raw" href="${esc(c.ogFile!)}" target="_blank">poster</a>`
    : `<a class="raw" href="${esc(c.artFile!)}" target="_blank">unbranded</a>`;

  const len = c.seconds_ ? ` · ${c.seconds_}s clip` : '';

  return `<figure class="card">
  ${media}
  <figcaption><b>${esc(c.model)}</b> · #${c.iteration} · ${esc(c.tier)}${len} · ${usd(c.costUsd)} · ${c.seconds}s gen
    ${extras}</figcaption>
</figure>`;
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(it);
  }
  return out;
}

export async function writeSheet(
  manifest: RunManifest,
  styles: Style[],
  outDir: string,
): Promise<string> {
  const multiIdea = manifest.ideas.length > 1;

  const sections = [...groupBy(manifest.cells, (c) => c.ideaIndex).entries()]
    .map(([ideaIndex, ideaCells]) => {
      const styleBlocks = [...groupBy(ideaCells, (c) => c.style).entries()]
        .map(([slug, cells]) => {
          const style = styles.find((s) => s.slug === slug);
          return `<div class="styleblock">
  <h3>${esc(style?.name ?? slug)} <span class="slug">${esc(slug)}</span></h3>
  ${style ? `<details><summary>look</summary><p>${esc(style.look)}</p></details>` : ''}
  <div class="grid">${cells.map(cardHtml).join('\n')}</div>
</div>`;
        })
        .join('\n');

      const header = multiIdea
        ? `<h2><span class="num">${ideaIndex}</span> Idea ${ideaIndex}</h2>
  <p class="ideatext">${esc(ideaCells[0].idea)}</p>`
        : '';

      return `<section>${header}\n${styleBlocks}</section>`;
    })
    .join('\n');

  const failed = manifest.cells.filter((c) => c.error).length;
  const models = new Set(manifest.cells.map((c) => c.model)).size;
  const stylesUsed = new Set(manifest.cells.map((c) => c.style)).size;

  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(manifest.title)} — OG sweep</title>
<style>
  /* matewishkey.com/design tokens, dark ground */
  :root { --paper:#101317; --surface:#161b23; --surface2:#1c232d; --line:#232c3a;
          --ink:#f4f2f6; --mute:#a8a2b0; --faint:#8e8896; --red:#e2342b; --red-deep:#f0524a; }
  * { box-sizing:border-box }
  body { margin:0; padding:40px clamp(16px,4vw,56px); background:var(--paper); color:var(--ink);
         font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif }
  header { border-bottom:1px solid var(--line); padding-bottom:24px; margin-bottom:40px }
  h1 { margin:0 0 10px; font-size:clamp(22px,3vw,30px); letter-spacing:-.01em }
  .kicker { font:700 13px/1 ui-monospace,"JetBrains Mono",monospace; letter-spacing:.16em;
            text-transform:uppercase; color:var(--red-deep); margin:0 0 10px }
  .meta { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px }
  .pill { background:var(--surface); border:1px solid var(--line); border-radius:8px;
          padding:4px 12px; font-size:13px; color:var(--mute) }
  .pill b { color:var(--ink); font-weight:600 }
  section { margin-bottom:56px }
  h2 { font-size:21px; margin:0 0 6px; display:flex; align-items:center; gap:12px }
  .num { display:inline-grid; place-items:center; width:32px; height:32px; flex:none;
         background:var(--red); color:#fff; font-size:15px; font-weight:700 }
  .ideatext { color:var(--mute); max-width:78ch; margin:0 0 24px; border-left:2px solid var(--red);
              padding-left:14px }
  .styleblock { margin-bottom:32px }
  h3 { font-size:17px; margin:0 0 4px; display:flex; align-items:baseline; gap:10px; font-weight:600 }
  .slug { font:12px ui-monospace,monospace; color:var(--faint); font-weight:400 }
  details { margin:0 0 14px; max-width:72ch }
  summary { cursor:pointer; color:var(--faint); font-size:13px }
  details p { color:var(--mute); font-size:14px; border-left:2px solid var(--line); padding-left:12px }
  .grid { display:grid; gap:20px; grid-template-columns:repeat(auto-fill,minmax(min(420px,100%),1fr)) }
  .card { margin:0; background:var(--surface); border:1px solid var(--line); border-radius:8px; overflow:hidden }
  .card img, .card video { width:100%; display:block; aspect-ratio:1200/630; object-fit:cover;
                           background:#000 }
  figcaption { padding:10px 12px; font-size:13px; color:var(--mute) }
  figcaption b { color:var(--ink) }
  .raw { float:right; color:var(--faint) }
  a { color:inherit }
  .failed { opacity:.6 }
  .ph { aspect-ratio:1200/630; display:grid; place-items:center; color:var(--faint);
        background:repeating-linear-gradient(45deg,#161b23,#161b23 10px,#1c232d 10px,#1c232d 20px) }
  .err { color:var(--red-deep); font-size:12px }
</style>
<header>
  ${manifest.kicker ? `<p class="kicker">${esc(manifest.kicker)}</p>` : ''}
  <h1>${esc(manifest.title)}</h1>
  <div class="meta">
    <span class="pill"><b>${manifest.cells.length}</b> images</span>
    <span class="pill"><b>${manifest.ideas.length}</b> ideas</span>
    <span class="pill"><b>${stylesUsed}</b> styles</span>
    <span class="pill"><b>${models}</b> models</span>
    <span class="pill">spent <b>${usd(manifest.actualUsd)}</b></span>
    ${manifest.refs.length ? `<span class="pill"><b>${manifest.refs.length}</b> reference photos</span>` : ''}
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
    `# ${manifest.title}`,
    '',
    `**Open [report.html](${reportUrlHint}) — that's the contact sheet.** Everything below is just the receipts.`,
    '',
    `- ${ok.length} images across ${manifest.ideas.length} ideas, ${new Set(ok.map((c) => c.style)).size} styles and ${new Set(ok.map((c) => c.model)).size} models`,
    `- Spent: $${manifest.actualUsd.toFixed(2)}`,
    `- \`og/\` is branded and ready to ship, \`art/\` is the unbranded render`,
    `- \`manifest.json\` has the exact prompt sent to each model`,
    '',
    '## The ideas',
    '',
    ...manifest.ideas.map((idea, i) => `${i + 1}. ${idea}`),
    '',
  ];
  const failed = manifest.cells.filter((c) => c.error);
  if (failed.length) {
    lines.push(`## ${failed.length} failed`, '');
    for (const f of failed) {
      lines.push(`- idea ${f.ideaIndex} · \`${f.style}\` / \`${f.model}\` #${f.iteration} — ${f.error}`);
    }
    lines.push('');
  }
  const path = join(outDir, 'README.md');
  await writeFile(path, lines.join('\n'), 'utf8');
  return path;
}
