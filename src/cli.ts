#!/usr/bin/env node
/**
 * mwk-og — generate branded OG images from a style and a prompt.
 *
 * The two axes are independent on purpose: a style is a reusable look, a prompt is what
 * is happening. Pair one style with many prompts, or shoot one prompt through many styles.
 */

import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyBrand, loadBrand } from './brand.ts';
import { montage } from './montage.ts';
import { DEFAULT_SWEEP, MODELS, PRICES_VERIFIED_ON, resolveModel, priceOf } from './models.ts';
import { BRAINSTORM_SYSTEM, brainstormPrompt, parseBrainstorm } from './prompt.ts';
import { runSweep, estimate, refMegapixels } from './run.ts';
import { writeReadme, writeSheet } from './sheet.ts';
import { listStyles, loadStyle, saveStyle, slugify, type Style } from './style.ts';
import { runText, toDataUri } from './replicate.ts';
import { readFile } from 'node:fs/promises';

const BRAINSTORM_MODEL = 'openai/gpt-5.6-terra';

const USAGE = `mwk-og — branded OG images from a style + a prompt

  gen         render a sweep: styles x models x iterations, then brand every result
  brainstorm  invent new styles from an idea and save them as style files
  styles      list the styles you have
  models      list the models, their reference limits and their per-image price
  brand       re-brand an image you already have (no API call, no cost)
  montage     combine several picked cards into one branded image (no API call, no cost)

gen
  -p, --prompt <idea>      what is happening; repeat -p for variants  (required)
  -s, --style <slug>       style to use; repeat or comma-separate    (default: all)
      --all-styles         every style in styles/
  -m, --model <alias>      repeat or comma-separate                  (default: ${DEFAULT_SWEEP.join(',')})
  -n, --iterations <n>     renders per style/model cell              (default: 1)
      --ref <path>         reference image; repeat for more
      --ref-role <who>     who the reference person is in the scene, e.g. "the
                           interviewer" — REQUIRED for any scene with two people,
                           or models disagree about who the reference is
      --title <text>       headline burned into the brand band       (default: the prompt)
      --kicker <text>      small red line above the title
      --tagline <text>     standfirst under the title, e.g. a strapline
      --tier <key>         quality/resolution hint, e.g. low, 2K, without_audio
      --seconds <n>        clip length for video models (each has its own set)
      --allow-text         let the model draw text IN the picture — speech bubbles,
                           captions, signage. Off by default: the brand band is the
                           only text guaranteed to be spelled correctly
      --extra <text>       appended verbatim to every prompt
  -o, --out <dir>          run directory                             (default: out/<date>_<slug>)
  -c, --concurrency <n>    parallel renders                          (default: 4)
      --dry-run            print the grid and the cost, call nothing

brainstorm
  -p, --prompt <idea>      the register to aim at                    (required)
  -n, --count <n>          how many styles                           (default: 4)
      --ref <path>         show the brainstormer a reference image
      --save               write them to styles/ (otherwise just prints)

montage
      <file...>            the images to combine, in reading order — use the UNBRANDED
                           art/ frames, not the og/ cards, or every panel carries its
                           own band
      --label <text>       caption for each panel; repeat, one per image
      --label-prefix <t>   prepended to every label, e.g. "Vibe coding"
      --title <text>       headline for the band; *asterisks* set a word in red
      --kicker <text>      small red line above the title
      --tagline <text>     standfirst under the title
      --columns <n>        panels per row                            (default: 2)
      --og                 also write a cropped 1200x630 version
  -o, --out <file>         output path                               (default: montage.png)

brand
      <file>               the artwork to brand
      --title <text>       headline
      --kicker <text>      small red line above the title
  -o, --out <file>         output path                               (default: <file>.og.png)
`;

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** `-s a -s b -s c,d` all mean the same thing. */
function multi(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function cmdGen(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      prompt: { type: 'string', short: 'p', multiple: true },
      style: { type: 'string', short: 's', multiple: true },
      'all-styles': { type: 'boolean' },
      model: { type: 'string', short: 'm', multiple: true },
      iterations: { type: 'string', short: 'n' },
      ref: { type: 'string', multiple: true },
      'ref-role': { type: 'string' },
      title: { type: 'string' },
      kicker: { type: 'string' },
      tagline: { type: 'string' },
      tier: { type: 'string' },
      seconds: { type: 'string' },
      'allow-text': { type: 'boolean' },
      extra: { type: 'string' },
      out: { type: 'string', short: 'o' },
      concurrency: { type: 'string', short: 'c' },
      'dry-run': { type: 'boolean' },
    },
  });

  const ideas = values.prompt ?? [];
  if (!ideas.length) fail('gen needs -p "<what is happening>" (repeat -p for idea variants)');

  const wanted = multi(values.style);
  const all = await listStyles();
  if (!all.length) fail('No styles in styles/. Run `mwk-og brainstorm -p "..." --save` first.');

  const styles: Style[] = wanted.length
    ? await Promise.all(wanted.map((s) => loadStyle(s)))
    : all;

  const modelAliases = multi(values.model);
  const models = (modelAliases.length ? modelAliases : DEFAULT_SWEEP).map(resolveModel);

  const iterations = Number(values.iterations ?? 1);
  if (!Number.isInteger(iterations) || iterations < 1) fail('-n must be a positive integer');

  const refs = multi(values.ref);
  const title = values.title ?? ideas[0];
  const outDir = values.out ?? join('out', `${today()}_${slugify(title)}`);
  const concurrency = Number(values.concurrency ?? 4);

  const refMp = await refMegapixels(refs.filter((r) => !/^https?:|^data:/i.test(r)));
  const seconds = values.seconds ? Number(values.seconds) : undefined;
  const est = estimate({ ideas, styles, models, iterations, tier: values.tier, seconds }, refMp);
  const total = ideas.length * styles.length * models.length * iterations;

  console.log(`styles  ${styles.map((s) => s.slug).join(', ')}`);
  console.log(`models  ${models.map((m) => `${m.alias} (${m.id})`).join(', ')}`);
  console.log(`ideas   ${ideas.length}`);
  console.log(`grid    ${ideas.length} x ${styles.length} x ${models.length} x ${iterations} = ${total} images`);
  console.log(
    `refs    ${refs.length ? `${refs.join(', ')} (${refMp.toFixed(2)} MP total)` : '(none)'}`,
  );
  console.log(`cost    ~$${est.toFixed(2)}`);
  console.log(`out     ${outDir}`);

  if (values['dry-run']) {
    console.log('\n(dry run — nothing called)');
    console.log('\n--- prompt that would be sent for the first cell ---\n');
    const { compose } = await import('./prompt.ts');
    console.log(
      compose({
        style: styles[0],
        idea: ideas[0],
        hasRefs: refs.length > 0,
        refRole: values['ref-role'],
        allowText: values['allow-text'],
        extra: values.extra,
      }),
    );
    return;
  }

  await mkdir(outDir, { recursive: true });
  console.log('');

  const manifest = await runSweep({
    ideas,
    styles,
    models,
    iterations,
    refs,
    title,
    kicker: values.kicker,
    tagline: values.tagline,
    tier: values.tier,
    seconds,
    allowText: values['allow-text'],
    refRole: values['ref-role'],
    extra: values.extra,
    outDir,
    concurrency,
    onRetry: (cell, attempt, waitMs, message) => {
      const why = /429|throttled/i.test(message) ? 'throttled' : 'interrupted';
      console.log(
        `  … idea ${cell.ideaIndex} / ${cell.model} ${why}, retry ${attempt} in ${Math.round(waitMs / 1000)}s`,
      );
    },
    onCell: (cell, done, count) => {
      const mark = cell.error ? '✗' : '✓';
      const retried = cell.retries ? ` (after ${cell.retries} retr${cell.retries > 1 ? 'ies' : 'y'})` : '';
      const tail = cell.error ? cell.error.slice(0, 90) : `${cell.seconds}s${retried}`;
      const where = `idea ${cell.ideaIndex} · ${cell.style} / ${cell.model} #${cell.iteration}`;
      console.log(`${mark} [${done}/${count}] ${where} — ${tail}`);
    },
  });

  const report = await writeSheet(manifest, styles, outDir);
  await writeReadme(manifest, outDir, 'report.html');

  const failed = manifest.cells.filter((c) => c.error).length;
  console.log(`\nspent $${manifest.actualUsd.toFixed(2)}${failed ? ` · ${failed} failed` : ''}`);
  console.log(`sheet  ${report}`);
}

async function cmdBrainstorm(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      prompt: { type: 'string', short: 'p' },
      count: { type: 'string', short: 'n' },
      ref: { type: 'string', multiple: true },
      save: { type: 'boolean' },
    },
  });

  const idea = values.prompt;
  if (!idea) fail('brainstorm needs -p "<idea>"');
  const count = Number(values.count ?? 4);

  const existing = (await listStyles()).map((s) => s.name);
  const refs = await Promise.all(multi(values.ref).map(toDataUri));

  console.log(`brainstorming ${count} styles with ${BRAINSTORM_MODEL}...`);
  const raw = await runText(BRAINSTORM_MODEL, {
    prompt: brainstormPrompt(idea, count, existing),
    system_prompt: BRAINSTORM_SYSTEM,
    ...(refs.length ? { image_input: refs } : {}),
    reasoning_effort: 'low',
    verbosity: 'medium',
  });

  const styles = parseBrainstorm(raw, BRAINSTORM_MODEL);

  for (const s of styles) {
    console.log(`\n${s.name}  [${s.slug}]`);
    console.log(`  ${s.description}`);
    console.log(`  look: ${s.look}`);
    if (s.subject) console.log(`  subject: ${s.subject}`);
    if (s.avoid) console.log(`  avoid: ${s.avoid}`);
  }

  if (values.save) {
    console.log('');
    for (const s of styles) console.log(`saved ${await saveStyle(s)}`);
  } else {
    console.log('\n(not saved — re-run with --save)');
  }
}

async function cmdStyles(): Promise<void> {
  const styles = await listStyles();
  if (!styles.length) {
    console.log('No styles yet. `mwk-og brainstorm -p "..." --save`');
    return;
  }
  for (const s of styles) {
    const refs = s.refs.length ? ` · ${s.refs.length} ref(s)` : '';
    console.log(`${s.slug.padEnd(24)} ${s.name}${refs}`);
    if (s.description) console.log(`${' '.repeat(25)}${s.description}`);
  }
}

function cmdModels(): void {
  console.log(`per output image, read off Replicate on ${PRICES_VERIFIED_ON}\n`);
  for (const m of MODELS) {
    const prices = m.tiers.map((t) => `${t} $${priceOf(m, t).toFixed(3)}`).join('  ');
    const star = DEFAULT_SWEEP.includes(m.alias) ? '*' : ' ';
    console.log(`${star} ${m.alias.padEnd(12)} ${m.id}`);
    console.log(`    ${prices}`);
    console.log(`    refs: ${m.refStyle === 'single' ? '1 only' : `up to ${m.maxRefs}`}${m.seedable ? ' · seedable' : ''}`);
    console.log(`    ${m.notes}\n`);
  }
  console.log(`* = in the default sweep`);
}

async function cmdMontage(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      label: { type: 'string', multiple: true },
      'label-prefix': { type: 'string' },
      title: { type: 'string' },
      kicker: { type: 'string' },
      tagline: { type: 'string' },
      columns: { type: 'string' },
      og: { type: 'boolean' },
      out: { type: 'string', short: 'o' },
    },
  });

  if (!positionals.length) fail('montage needs image files: mwk-og montage a.png b.png ...');

  const brand = await loadBrand();
  const out = await montage({
    images: await Promise.all(positionals.map((p) => readFile(p))),
    labels: values.label ?? [],
    labelPrefix: values['label-prefix'],
    brand,
    title: values.title,
    kicker: values.kicker,
    tagline: values.tagline,
    columns: values.columns ? Number(values.columns) : 2,
  });

  const dest = values.out ?? 'montage.png';
  await writeFile(dest, out);
  const md = await (await import('sharp')).default(out).metadata();
  console.log(`✓ ${dest}  ${md.width}x${md.height}`);

  if (values.og) {
    const ogDest = dest.replace(/\.png$/, '') + '.og.png';
    const sharp = (await import('sharp')).default;
    await writeFile(
      ogDest,
      await sharp(out).resize(1200, 630, { fit: 'cover', position: 'top' }).png().toBuffer(),
    );
    console.log(`✓ ${ogDest}  1200x630 (cropped — panels lose their edges)`);
  }
}

async function cmdBrand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      title: { type: 'string' },
      kicker: { type: 'string' },
      tagline: { type: 'string' },
      out: { type: 'string', short: 'o' },
    },
  });

  const src = positionals[0];
  if (!src) fail('brand needs a file: mwk-og brand art.png --title "..."');

  const out = await applyBrand({
    art: await readFile(src),
    brand: await loadBrand(),
    title: values.title,
    kicker: values.kicker,
    tagline: values.tagline,
  });

  const dest = values.out ?? src.replace(/\.[^.]+$/, '') + '.og.png';
  await writeFile(dest, out);
  console.log(`✓ ${dest}`);
}

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case 'gen':
      await cmdGen(rest);
      break;
    case 'brainstorm':
      await cmdBrainstorm(rest);
      break;
    case 'styles':
      await cmdStyles();
      break;
    case 'models':
      cmdModels();
      break;
    case 'brand':
      await cmdBrand(rest);
      break;
    case 'montage':
      await cmdMontage(rest);
      break;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE);
      break;
    default:
      fail(`Unknown command "${command}". Try: mwk-og --help`);
  }
} catch (e) {
  fail((e as Error).message);
}
