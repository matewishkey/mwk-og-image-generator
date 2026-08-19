/**
 * mwk-og studio — operate the live studio (og.matewishkey.com) from the CLI.
 *
 * A thin client for the web app's /api routes, so an agent on this box and a
 * person in the browser can work on the same project at the same time. Every
 * mutation prints the studio URL it touched.
 *
 * Auth: MWK_STUDIO_TOKEN (bearer; mint with web/scripts/mint-api-token.mjs).
 * Base URL: MWK_STUDIO_URL, default https://og.matewishkey.com.
 */

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const USAGE = `mwk-og studio — drive the live studio; results appear in the browser

  styles                       list styles (house + team)
  projects                     list the team's projects
  create -n <name> -s <style>  new project; repeat -s for a style SET (first = primary); -m models
                               (default zturbo,pimage), -i iterations, -d description, -k brand kit,
                               --allow-text lifts the no-text frame rule (comics, screens)
  show <slug>                  project detail: settings + shots with ids
  set <slug>                   change settings; --kit, --title/--kicker/--tagline, -s styles
                               (repeat, first = primary), -m models, -i iterations, --allow-text,
                               --name, --description, --extra. Only what you pass changes.
  add-shot <slug> -p <prompt>  add shot(s); repeat -p; --label names the first; --style overrides
  edit-shot <slug> <shot>      change a shot; -p prompt, --label label (shot = id, position or label)
  set-style <slug> <shot> [style]   per-shot style override; omit style to clear
  reshoot <slug> <shot>        new takes of one shot with current settings; --watch
  delete-shot <slug> <shot>    soft-delete a shot
  refs                         the media library, with names
  upload-ref <file…>           upload image(s) into the library (content-deduped)
  zip <slug> --takes 1.3,…     one zip of hand-picked takes (raw art + branded card each)
                               or --designs <id,…>; --out <file> downloads it here
  templates <slug>             list templates: slug, picture count, house/team/pinned
  compose <slug> --takes 1.3,2.1   render EVERY template matching that picture count with
                               those takes (tap order = panel order); --template <slug>
                               composes just one; --theme dark, --title/--kicker/--tagline
  name-ref <refId> <name>      name an image so we can talk about it
  attach <slug> <refId>        attach a library image to every shot; --shot <id|position> scopes it
  detach <slug> <refId>        remove that attachment; --shot scopes it the same way
  ref-role <slug> <role...>    who the reference is in the scene (empty = clear)
  run <slug>                   start a full run and render it ON THIS BOX (direct-ingest;
                               needs the td-sops env loaded); --engine runs on Cloudflare
                               instead; --watch follows from a second poll
  watch <slug>                 follow take status until the run settles; --interval <s> (default 5)
  takes <slug>                 the contact sheet as a table; --all includes hidden + superseded
  pick <slug> <take>           pick a succeeded take for its shot. Every <take> accepts the
                               speakable number from the tiles ("1.3" = shot 1, take 3) or a raw id
  reroll <slug> <take>         new take of the same shot+model; --watch
  hide <slug> <take>           hide a take (reversible: unhide)
  unhide <slug> <take>
  design <slug> --config <file.json>   render a hand-authored template (cells/texts/shapes,
                               colors as brand tokens); --name, --format <formatId>, --title/--kicker/--tagline
  quick --image <file> --template <id|slug>   image in, branded card out — no project, no shots.
                               --title/--kicker/--tagline, --theme dark, --formats og,story,…
                               (default og), --out <dir> downloads the PNGs

env: MWK_STUDIO_TOKEN (required), MWK_STUDIO_URL (default https://og.matewishkey.com)`;

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function multi(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

const BASE = (process.env.MWK_STUDIO_URL ?? 'https://og.matewishkey.com').replace(/\/$/, '');

function studioUrl(path: string): string {
  return `${BASE}${path}`;
}

async function api<T = Record<string, unknown>>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const token = process.env.MWK_STUDIO_TOKEN;
  if (!token) fail('MWK_STUDIO_TOKEN is not set. Mint one: node web/scripts/mint-api-token.mjs');
  const res = await fetch(`${BASE}/api${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`${res.status} from ${path}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) fail(`${res.status} from ${path}: ${(json as { error?: string }).error ?? text}`);
  return json as T;
}

const money = (usd: number): string => `$${usd.toFixed(4)}`;

interface TakeInfo {
  id: string;
  shot_id: string;
  ordinal: number;
  model_alias: string;
  iteration: number;
  status: string;
  cost_micros: number;
  error_kind: string | null;
  error_message: string | null;
  picked: boolean;
  superseded: boolean;
  hidden: boolean;
}
interface ShotInfo {
  id: string;
  position: number;
  label: string | null;
  prompt: string;
}
interface TakesResponse {
  takes: TakeInfo[];
  shots: ShotInfo[];
  live: boolean;
  url: string;
}

function shotName(shots: ShotInfo[], shotId: string): string {
  const s = shots.find((x) => x.id === shotId);
  return s ? (s.label ?? `shot ${s.position}`) : shotId;
}

/** "1.3" = shot 1, take 3 — the speakable number printed on every tile. Raw
 * take ids pass through untouched, so both vocabularies work everywhere. */
async function resolveTake(slug: string, token: string): Promise<string> {
  const m = /^(\d+)\.(\d+)$/.exec(token);
  if (!m) return token;
  const r = await api<TakesResponse>(`/projects/${slug}/takes`);
  const shot = r.shots.find((x) => x.position === Number(m[1]));
  if (!shot) fail(`no shot ${m[1]} in ${slug}`);
  const take = r.takes.find((t) => t.shot_id === shot.id && t.ordinal === Number(m[2]));
  if (!take) fail(`no take ${token} in ${slug} (see: mwk-og studio takes ${slug} --all)`);
  return take.id;
}

async function cmdStyles(): Promise<void> {
  const { styles } = await api<{
    styles: { slug: string; name: string; description: string; house: boolean }[];
  }>('/styles');
  for (const s of styles) {
    console.log(`${s.slug.padEnd(24)} ${s.house ? '[house]' : '[team] '} ${s.name}`);
    if (s.description) console.log(`${' '.repeat(33)}${s.description}`);
  }
}

async function cmdProjects(): Promise<void> {
  const { projects } = await api<{
    projects: { slug: string; name: string; models: string[]; iterations: number; created_at: string }[];
  }>('/projects');
  for (const p of projects) {
    console.log(
      `${p.slug.padEnd(28)} ${p.name.padEnd(28)} ${p.models.join(',')} x${p.iterations}  ${p.created_at.slice(0, 10)}`,
    );
  }
  if (!projects.length) console.log('(no projects yet)');
}

async function cmdCreate(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: 'string', short: 'n' },
      style: { type: 'string', short: 's', multiple: true },
      description: { type: 'string', short: 'd' },
      model: { type: 'string', short: 'm', multiple: true },
      iterations: { type: 'string', short: 'i' },
      kit: { type: 'string', short: 'k' },
      'allow-text': { type: 'boolean' },
    },
  });
  if (!values.name) fail('-n <name> is required');
  const styles = multi(values.style);
  if (!styles.length) fail('-s <style slug> is required (see: mwk-og studio styles)');
  const models = multi(values.model);
  const created = await api<{ slug: string; url: string }>('/projects', {
    method: 'POST',
    body: {
      name: values.name,
      description: values.description,
      styles,
      brandKit: values.kit,
      models: models.length ? models : ['zturbo', 'pimage'],
      iterations: values.iterations ? Number(values.iterations) : 1,
      allowText: values['allow-text'] ?? false,
    },
  });
  console.log(`✓ created ${created.slug}`);
  console.log(studioUrl(created.url));
}

async function cmdShow(slug: string): Promise<void> {
  const detail = await api<{
    project: {
      name: string; description: string; models: string[]; iterations: number;
      tier: string | null; title: string | null; kicker: string | null; tagline: string | null;
    };
    style: { slug: string; name: string };
    shots: (ShotInfo & { picked_take_id: string | null })[];
    url: string;
  }>(`/projects/${slug}`);
  const p = detail.project;
  console.log(`${p.name} — style ${detail.style.slug}, ${p.models.join(',')} x${p.iterations}`);
  if (p.description) console.log(p.description);
  console.log(`band: title=${JSON.stringify(p.title)} kicker=${JSON.stringify(p.kicker)} tagline=${JSON.stringify(p.tagline)}`);
  console.log('');
  for (const s of detail.shots) {
    const mark = s.picked_take_id ? '★' : ' ';
    console.log(`${mark} ${String(s.position).padStart(2)}  ${s.id}  ${s.label ?? ''}`);
    console.log(`      ${s.prompt}`);
  }
  if (!detail.shots.length) console.log('(no shots yet)');
  console.log(`\n${studioUrl(detail.url)}`);
}

async function cmdAddShot(slug: string, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      prompt: { type: 'string', short: 'p', multiple: true },
      label: { type: 'string' },
      style: { type: 'string' },
    },
  });
  const prompts = values.prompt ?? [];
  if (!prompts.length) fail('-p <prompt> is required (repeat for several)');
  for (const [i, prompt] of prompts.entries()) {
    const r = await api<{ shotId: string; position: number; label: string }>(`/projects/${slug}/shots`, {
      method: 'POST',
      body: { action: 'add', prompt, label: i === 0 ? values.label : undefined, style: values.style },
    });
    console.log(`✓ "${r.label}" added (${r.shotId})`);
  }
  console.log(studioUrl(`/projects/${slug}/shots`));
}

async function cmdRefs(): Promise<void> {
  const { references } = await api<{
    references: { id: string; name: string | null; filename: string; width: number | null; height: number | null; uses: number }[];
  }>('/media');
  for (const r of references) {
    console.log(
      `${r.id}  ${(r.name ?? `(${r.filename})`).padEnd(28)} ${r.width}×${r.height}  ${r.uses} use${r.uses === 1 ? '' : 's'}`,
    );
  }
  if (!references.length) console.log('(library is empty)');
}

async function cmdEditShot(slug: string, shotId: string, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { prompt: { type: 'string', short: 'p' }, label: { type: 'string' } },
  });
  if (values.prompt === undefined && values.label === undefined)
    fail('nothing to change: pass -p and/or --label');
  await api(`/projects/${slug}/shots`, {
    method: 'POST',
    body: { action: 'edit', shot: shotId, prompt: values.prompt, label: values.label },
  });
  console.log(`✓ shot updated`);
  console.log(studioUrl(`/projects/${slug}/shots`));
}

async function cmdDeleteShot(slug: string, shotId: string): Promise<void> {
  await api(`/projects/${slug}/shots`, { method: 'POST', body: { action: 'delete', shot: shotId } });
  console.log(`✓ shot deleted`);
}

async function watch(slug: string, intervalSec: number): Promise<void> {
  const seen = new Map<string, string>();
  let firstPass = true;
  for (;;) {
    const r = await api<TakesResponse>(`/projects/${slug}/takes`);
    for (const t of r.takes) {
      const prev = seen.get(t.id);
      if (prev === t.status) continue;
      seen.set(t.id, t.status);
      const pos = r.shots.find((x) => x.id === t.shot_id)?.position;
      const where = `${pos}.${t.ordinal} ${shotName(r.shots, t.shot_id)} · ${t.model_alias} #${t.iteration}`;
      if (t.status === 'succeeded') console.log(`✓ ${where}  succeeded  ${money(t.cost_micros / 1e6)}`);
      else if (t.status === 'failed' || t.status === 'cancelled')
        console.log(`✗ ${where}  ${t.status}: ${t.error_kind ?? ''} ${t.error_message ?? ''}`.trim());
      else if (!firstPass || t.status !== 'queued') console.log(`… ${where}  ${prev ? `${prev} → ` : ''}${t.status}`);
    }
    firstPass = false;
    if (!r.live) {
      const done = r.takes.filter((t) => t.status === 'succeeded').length;
      const failed = r.takes.filter((t) => ['failed', 'cancelled'].includes(t.status)).length;
      const spent = r.takes.reduce((s, t) => s + t.cost_micros, 0) / 1e6;
      console.log(`\n${done} succeeded, ${failed} failed · spent ${money(spent)}`);
      console.log(studioUrl(r.url));
      if (failed) process.exit(1);
      return;
    }
    await new Promise((res) => setTimeout(res, intervalSec * 1000));
  }
}

async function cmdRun(slug: string, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      watch: { type: 'boolean' },
      interval: { type: 'string' },
      engine: { type: 'boolean' },
    },
  });

  if (values.engine) {
    const r = await api<{ runId: string; takes: number; estimatedUsd: number }>(
      `/projects/${slug}/run`,
      { method: 'POST', body: {} },
    );
    console.log(`✓ run ${r.runId} started on the engine — ${r.takes} takes, ~${money(r.estimatedUsd)}`);
    console.log(studioUrl(`/projects/${slug}/runs/${r.runId}`));
    if (values.watch) await watch(slug, values.interval ? Number(values.interval) : 5);
    return;
  }

  // Direct-ingest (round 8b, the default): the web app creates the run rows
  // and returns the frozen payload; THIS process executes it and posts the
  // same HMAC events the engine would. If we die mid-run, the sweeper reclaims
  // the tail and a re-run re-queues — same story as a dead container.
  for (const name of ['SEAM_SECRET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'REPLICATE_API_TOKEN']) {
    if (!process.env[name])
      fail(`${name} is not set — load the td-sops env first, or pass --engine to run on Cloudflare`);
  }
  const r = await api<{ runId: string; takes: number; estimatedUsd: number; request: unknown }>(
    `/projects/${slug}/run`,
    { method: 'POST', body: { dispatch: 'local' } },
  );
  const runUrl = studioUrl(`/projects/${slug}/runs/${r.runId}`);
  console.log(`✓ run ${r.runId} — ${r.takes} takes, ~${money(r.estimatedUsd)}, rendering HERE`);
  console.log(runUrl);

  const { createExecutor } = await import('./executor.ts');
  const executor = createExecutor({
    seamSecret: process.env.SEAM_SECRET!,
    eventsUrl: `${BASE}/internal/events`,
    r2: {
      endpoint:
        process.env.R2_ENDPOINT ?? 'https://ef7d622089ca4480c9f6fbf368f66787.r2.cloudflarestorage.com',
      bucket: process.env.R2_BUCKET ?? 'mwk-studio',
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    onCell: (cell, done, total) => {
      const mark = cell.error ? `✗ ${cell.error.slice(0, 120)}` : `✓ ${money(cell.costUsd)}`;
      console.log(`  [${done}/${total}] ${cell.style} · ${cell.model} #${cell.iteration}  ${mark}`);
    },
  });
  const request = r.request as import('./seam.ts').EngineRunRequest;
  const { refBytes, brand } = await executor.prepareRun(request);
  await executor.executeRun(request, refBytes, brand);
  console.log(`
done — ${runUrl}`);
}

async function cmdWatch(slug: string, argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { interval: { type: 'string' } } });
  await watch(slug, values.interval ? Number(values.interval) : 5);
}

async function cmdTakes(slug: string, argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { all: { type: 'boolean' } } });
  const r = await api<TakesResponse>(`/projects/${slug}/takes`);
  const byShot = new Map<string, TakeInfo[]>();
  for (const t of r.takes) {
    if (!values.all && (t.hidden || t.superseded)) continue;
    byShot.set(t.shot_id, [...(byShot.get(t.shot_id) ?? []), t]);
  }
  for (const s of r.shots) {
    const takes = byShot.get(s.id) ?? [];
    console.log(`\n${s.position}. ${s.label ?? s.prompt.slice(0, 60)}`);
    for (const t of takes) {
      const marks = [t.picked ? 'PICK' : '', t.superseded ? 'superseded' : '', t.hidden ? 'hidden' : '']
        .filter(Boolean)
        .join(' ');
      const err = t.status === 'failed' ? `  ${t.error_kind ?? ''}` : '';
      console.log(
        `  ${`${s.position}.${t.ordinal}`.padEnd(6)} ${t.model_alias.padEnd(8)} #${t.iteration}  ${t.status.padEnd(10)} ${money(t.cost_micros / 1e6)}${err}  ${marks}  ${t.id}`,
      );
    }
  }
  console.log(`\n${studioUrl(r.url)}`);
}

interface TemplateInfo { id: string; slug: string; name: string; slots: number; pinned: boolean; house: boolean }

async function cmdTemplates(slug: string): Promise<void> {
  const r = await api<{ templates: TemplateInfo[] }>(`/projects/${slug}/designs`);
  for (const t of r.templates) {
    const marks = [t.house ? 'house' : 'team', t.pinned ? 'pinned' : ''].filter(Boolean).join(' ');
    console.log(`  ${t.slug.padEnd(22)} ${String(t.slots)} picture${t.slots === 1 ? ' ' : 's'}  ${marks}  ${t.name}`);
  }
  console.log(`
${studioUrl(`/projects/${slug}/design`)}`);
}

async function cmdCompose(slug: string, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      takes: { type: 'string' },
      template: { type: 'string' },
      theme: { type: 'string' },
      title: { type: 'string' },
      kicker: { type: 'string' },
      tagline: { type: 'string' },
    },
  });
  if (!values.takes) fail('pass --takes 1.3,2.1,… (tap order = panel order)');
  const tokens = multi([values.takes]);
  const ids = await Promise.all(tokens.map((t) => resolveTake(slug, t)));
  tokens.forEach((t, i) => console.log(`  slot ${i + 1} = ${t}`));

  let layoutId: string | undefined;
  if (values.template) {
    const r = await api<{ templates: TemplateInfo[] }>(`/projects/${slug}/designs`);
    const t = r.templates.find((x) => x.slug === values.template || x.id === values.template);
    if (!t) fail(`no template "${values.template}" (see: mwk-og studio templates ${slug})`);
    layoutId = t.id;
  }

  const r = await api<{ designs: { designId: string; layoutName?: string }[]; url: string }>(
    `/projects/${slug}/designs`,
    {
      method: 'POST',
      body: {
        takes: ids,
        ...(layoutId ? { layoutId } : {}),
        ...(values.theme === 'dark' ? { theme: 'dark' } : {}),
        ...(values.title ? { title: values.title } : {}),
        ...(values.kicker ? { kicker: values.kicker } : {}),
        ...(values.tagline ? { tagline: values.tagline } : {}),
      },
    },
  );
  for (const d of r.designs) console.log(`✓ ${d.layoutName ?? d.designId}`);
  console.log(studioUrl(r.url));
}

async function cmdUploadRef(argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  if (!positionals.length) fail('usage: mwk-og studio upload-ref <file…>');
  const files: { name: string; data: string }[] = [];
  for (const f of positionals) {
    const bytes = await readFile(f);
    files.push({ name: f.split('/').pop() ?? f, data: bytes.toString('base64') });
  }
  const r = await api<{ saved: number; errors: string[]; ids: string[] }>('/media', {
    method: 'POST',
    body: { action: 'upload', files },
  });
  for (const e of r.errors) console.error(`✗ ${e}`);
  r.ids.forEach((id, i) => console.log(`✓ ${files[i]?.name}  ${id}`));
  console.log(studioUrl('/media'));
}

async function cmdZip(slug: string, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { takes: { type: 'string' }, designs: { type: 'string' }, out: { type: 'string' } },
  });
  if (!values.takes && !values.designs) fail('pass --takes 1.3,2.1,… or --designs <id,…>');
  let qs: string;
  if (values.takes) {
    const ids = await Promise.all(multi([values.takes]).map((t) => resolveTake(slug, t)));
    qs = `takes=${ids.join(',')}`;
  } else {
    qs = `designs=${multi([values.designs!]).join(',')}`;
  }
  const url = studioUrl(`/api/projects/${slug}/zip?${qs}`);
  if (values.out) {
    const token = process.env.MWK_STUDIO_TOKEN!;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) fail(`${res.status} from zip: ${(await res.text()).slice(0, 300)}`);
    await writeFile(values.out, Buffer.from(await res.arrayBuffer()));
    console.log(`✓ saved ${values.out}`);
  }
  console.log(url);
}

async function takeAction(
  slug: string,
  takeToken: string,
  action: 'pick' | 'hide' | 'unhide' | 'reroll',
): Promise<void> {
  const takeId = await resolveTake(slug, takeToken);
  const r = await api<{ ok: true; runId?: string }>(`/projects/${slug}/takes`, {
    method: 'POST',
    body: { action, take: takeId },
  });
  console.log(action === 'reroll' ? `✓ re-roll started (run ${r.runId})` : `✓ ${action}`);
  console.log(studioUrl(action === 'reroll' && r.runId ? `/projects/${slug}/runs/${r.runId}` : `/projects/${slug}/shots`));
}

export async function runStudio(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const needSlug = (): string => {
    const s = rest[0];
    if (!s) fail(`the project slug is required. Try: mwk-og studio help`);
    return s;
  };
  const needTake = (): string => {
    const t = rest[1];
    if (!t) fail(`the take id is required (see: mwk-og studio takes ${rest[0] ?? '<slug>'})`);
    return t;
  };

  switch (command) {
    case 'styles': await cmdStyles(); break;
    case 'projects': await cmdProjects(); break;
    case 'create': await cmdCreate(rest); break;
    case 'show': await cmdShow(needSlug()); break;
    case 'set': {
      const slug = needSlug();
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          kit: { type: 'string' },
          title: { type: 'string' },
          kicker: { type: 'string' },
          tagline: { type: 'string' },
          style: { type: 'string', short: 's', multiple: true },
          model: { type: 'string', short: 'm', multiple: true },
          iterations: { type: 'string', short: 'i' },
          'allow-text': { type: 'boolean' },
          name: { type: 'string' },
          description: { type: 'string' },
          extra: { type: 'string' },
        },
      });
      const styles = multi(values.style);
      const models = multi(values.model);
      const patch: Record<string, unknown> = {};
      if (values.kit !== undefined) patch.brandKit = values.kit;
      if (values.title !== undefined) patch.title = values.title;
      if (values.kicker !== undefined) patch.kicker = values.kicker;
      if (values.tagline !== undefined) patch.tagline = values.tagline;
      if (styles.length) patch.styles = styles;
      if (models.length) patch.models = models;
      if (values.iterations !== undefined) patch.iterations = Number(values.iterations);
      if (values['allow-text'] !== undefined) patch.allowText = values['allow-text'];
      if (values.name !== undefined) patch.name = values.name;
      if (values.description !== undefined) patch.description = values.description;
      if (values.extra !== undefined) patch.extra = values.extra;
      if (!Object.keys(patch).length) fail('nothing to change — pass at least one flag');
      await api(`/projects/${slug}`, { method: 'PATCH', body: patch });
      console.log('✓ settings updated');
      console.log(studioUrl(`/projects/${slug}/settings`));
      break;
    }
    case 'add-shot': await cmdAddShot(needSlug(), rest.slice(1)); break;
    case 'edit-shot': {
      const slug = needSlug();
      const shot = rest[1];
      if (!shot) fail('the shot id is required (see: mwk-og studio show ' + slug + ')');
      await cmdEditShot(slug, shot, rest.slice(2));
      break;
    }
    case 'delete-shot': {
      const slug = needSlug();
      const shot = rest[1];
      if (!shot) fail('the shot id is required');
      await cmdDeleteShot(slug, shot);
      break;
    }
    case 'set-style': {
      const slug = needSlug();
      const shot = rest[1];
      if (!shot) fail('the shot (id, position or label) is required');
      const r = await api<{ ok: true; styleId: string | null }>(`/projects/${slug}/shots`, {
        method: 'POST',
        body: { action: 'set-style', shot, style: rest[2] ?? '' },
      });
      console.log(r.styleId ? `✓ shot renders in its own style` : `✓ back to the project style`);
      console.log(studioUrl(`/projects/${slug}/shots`));
      break;
    }
    case 'reshoot': {
      const slug = needSlug();
      const shot = rest[1];
      if (!shot) fail('the shot (id, position or label) is required');
      const { values } = parseArgs({ args: rest.slice(2), options: { watch: { type: 'boolean' } } });
      const r = await api<{ runId: string; url: string }>(`/projects/${slug}/shots`, {
        method: 'POST',
        body: { action: 'reshoot', shot },
      });
      console.log(`✓ re-shoot started (run ${r.runId})`);
      console.log(studioUrl(`/projects/${slug}/runs/${r.runId}`));
      if (values.watch) await watch(slug, 5);
      break;
    }
    case 'refs': await cmdRefs(); break;
    case 'upload-ref': await cmdUploadRef(rest); break;
    case 'templates': await cmdTemplates(needSlug()); break;
    case 'compose': await cmdCompose(needSlug(), rest.slice(1)); break;
    case 'zip': await cmdZip(needSlug(), rest.slice(1)); break;
    case 'attach':
    case 'detach': {
      const slug = needSlug();
      const ref = rest[1];
      if (!ref) fail(`usage: mwk-og studio ${command} <slug> <refId> [--shot <id|position>]`);
      const { values } = parseArgs({ args: rest.slice(2), options: { shot: { type: 'string' } } });
      await api(`/projects/${slug}/refs`, {
        method: 'POST',
        body: { action: command === 'attach' ? 'attach' : 'remove', ref, shot: values.shot },
      });
      const scope = values.shot ? `shot ${values.shot}` : 'every shot';
      console.log(`✓ ${command === 'attach' ? 'attached to' : 'detached from'} ${scope}`);
      console.log(studioUrl(`/projects/${slug}/shots`));
      break;
    }
    case 'ref-role': {
      const slug = needSlug();
      await api(`/projects/${slug}/refs`, {
        method: 'POST',
        body: { action: 'role', refRole: rest.slice(1).join(' ') },
      });
      console.log('✓ ref-role set');
      break;
    }
    case 'name-ref': {
      const ref = rest[0];
      if (!ref) fail('usage: mwk-og studio name-ref <refId> <name>');
      await api('/media', { method: 'POST', body: { action: 'rename', ref, name: rest.slice(1).join(' ') } });
      console.log('✓ named');
      break;
    }
    case 'run': await cmdRun(needSlug(), rest.slice(1)); break;
    case 'watch': await cmdWatch(needSlug(), rest.slice(1)); break;
    case 'takes': await cmdTakes(needSlug(), rest.slice(1)); break;
    case 'pick': await takeAction(needSlug(), needTake(), 'pick'); break;
    case 'reroll': {
      const slug = needSlug();
      const take = needTake();
      const { values } = parseArgs({ args: rest.slice(2), options: { watch: { type: 'boolean' } } });
      await takeAction(slug, take, 'reroll');
      if (values.watch) await watch(slug, 5);
      break;
    }
    case 'hide': await takeAction(needSlug(), needTake(), 'hide'); break;
    case 'unhide': await takeAction(needSlug(), needTake(), 'unhide'); break;
    case 'design': {
      const slug = needSlug();
      const { values } = parseArgs({
        args: rest.slice(1),
        options: {
          config: { type: 'string' },
          name: { type: 'string' },
          format: { type: 'string' },
          title: { type: 'string' },
          kicker: { type: 'string' },
          tagline: { type: 'string' },
        },
      });
      if (!values.config) fail('usage: mwk-og studio design <slug> --config <file.json>');
      let config: unknown;
      try {
        config = JSON.parse(await readFile(values.config, 'utf8'));
      } catch (e) {
        fail(`could not read ${values.config}: ${(e as Error).message}`);
      }
      const r = await api<{ designId: string; url: string; image: string }>(
        `/projects/${slug}/designs`,
        {
          method: 'POST',
          body: {
            config,
            name: values.name,
            formatId: values.format,
            title: values.title,
            kicker: values.kicker,
            tagline: values.tagline,
          },
        },
      );
      console.log(`✓ rendered design ${r.designId}`);
      console.log(studioUrl(r.url));
      break;
    }
    case 'quick': {
      const { values } = parseArgs({
        args: rest,
        options: {
          image: { type: 'string' },
          template: { type: 'string' },
          title: { type: 'string' },
          kicker: { type: 'string' },
          tagline: { type: 'string' },
          theme: { type: 'string' },
          formats: { type: 'string' },
          out: { type: 'string' },
        },
      });
      if (!values.image || !values.template)
        fail('usage: mwk-og studio quick --image <file> --template <id|slug> [--title …] [--formats og,story] [--out <dir>]');
      const bytes = await readFile(values.image);
      const result = await api<{ designs: { id: string; url: string; format: string }[] }>('/quick-card', {
        method: 'POST',
        body: {
          image: bytes.toString('base64'),
          template: values.template,
          title: values.title,
          kicker: values.kicker,
          tagline: values.tagline,
          theme: values.theme === 'dark' ? 'dark' : undefined,
          formatIds: values.formats ? multi([values.formats]) : undefined,
        },
      });
      for (const d of result.designs) console.log(`✓ ${d.format}  ${studioUrl(d.url)}`);
      if (values.out) {
        await mkdir(values.out, { recursive: true });
        for (const d of result.designs) {
          const res = await fetch(studioUrl(d.url), {
            headers: { authorization: `Bearer ${process.env.MWK_STUDIO_TOKEN}` },
          });
          if (!res.ok) fail(`download failed for ${d.format}: ${res.status}`);
          const file = `${values.out}/quick-${d.format}.png`;
          await writeFile(file, Buffer.from(await res.arrayBuffer()));
          console.log(`  saved ${file}`);
        }
      }
      console.log(studioUrl('/quick'));
      break;
    }
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      console.log(USAGE);
      break;
    default:
      fail(`Unknown studio command "${command}". Try: mwk-og studio help`);
  }
}
