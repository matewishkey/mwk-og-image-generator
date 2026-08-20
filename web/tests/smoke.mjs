/**
 * Browser smoke test against the LIVE site, run after every deploy:
 *
 *   TOKEN=<fresh login token> node tests/smoke.mjs [screenshot-dir]
 *
 * Mint the token first (see scripts in the repo README or use wrangler d1 directly).
 * Fails loudly on any console error, failed request, or missing UI element.
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'https://og.matewishkey.com';
const TOKEN = process.env.TOKEN;
const SHOTS = process.argv[2];

if (!TOKEN) {
  console.error('TOKEN env var required (a fresh, unconsumed login token)');
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const consoleErrors = [];
const failedRequests = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`${m.text()} [${m.location()?.url ?? ''}]`);
});
// This box's DNS blackholes tracker hosts (see machine CLAUDE.md); the beacon's
// cert error is the blackhole symptom, never a site problem.
const BLACKHOLED = /cloudflareinsights\.com|google-analytics\.com|googletagmanager\.com/;
page.on('requestfailed', (r) => {
  if (!BLACKHOLED.test(r.url())) failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`);
});
page.on('response', (r) => {
  if (r.status() >= 500) failedRequests.push(`${r.url()} — HTTP ${r.status()}`);
});

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok ' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};

// logged-out: login page renders with the form
await page.goto(`${BASE}/login`);
check('login page shows email form', await page.locator('input[type=email]').isVisible());

// theme toggle flips data-theme
const before = await page.evaluate(() => document.documentElement.dataset.theme ?? 'unset');
await page.click('#theme-toggle');
const after = await page.evaluate(() => document.documentElement.dataset.theme);
check(`theme toggle flips (${before} -> ${after})`, after !== before && !!after);

// magic link signs in and lands on /projects
await page.goto(`${BASE}/auth/verify?token=${TOKEN}`);
await page.waitForURL('**/projects');
check('magic link lands on /projects', page.url().endsWith('/projects'));
check('projects heading renders', (await page.locator('h1').textContent()) === 'Projects');

// middleware guards: a logged-out context is redirected
const anon = await browser.newPage();
await anon.goto(`${BASE}/projects`);
check('anonymous /projects redirects to /login', anon.url().includes('/login'));
await anon.close();

// Pick a live project off the list rather than naming one: any given project
// can be archived (and one was), and the smoke test must not depend on that.
const SLUG =
  process.env.SMOKE_PROJECT ??
  (await page.evaluate(() =>
    [...document.querySelectorAll('a[href^="/projects/"]')]
      .map((a) => a.getAttribute('href').split('/')[2])
      .find((s) => s && s !== 'new')));
if (!SLUG) { console.error('no project on /projects to smoke against'); process.exit(2); }
console.log(`     (smoking against project "${SLUG}")`);

// overview: the old /takes URL redirects here; rows render with thumbs
await page.goto(`${BASE}/projects/${SLUG}/takes`);
check('old /takes URL lands on the overview', page.url().endsWith(`/projects/${SLUG}/shots`));
await page.waitForSelector('astro-island:not([ssr])', { timeout: 20_000 });
const rows = await page.locator('.ws-orow').count();
check(`overview renders shot rows (${rows})`, rows >= 1);
await page.locator('.ws-orow img, .ws-orow .list-ph').first().waitFor({ timeout: 15_000 });

// a shot's own page: the contact sheet lives there now
await page.goto(`${BASE}/projects/${SLUG}/shots/1`);
await page.waitForSelector('astro-island:not([ssr])', { timeout: 20_000 });
const imgs = page.locator('.take img');
await imgs.first().waitFor({ timeout: 15_000 });
const imgCount = await imgs.count();
check(`shot page renders take images (${imgCount})`, imgCount >= 1);
const firstImgOk = await page
  .waitForFunction(
    () => { const i = document.querySelector('.take img'); return i && i.complete && i.naturalWidth > 0; },
    undefined,
    { timeout: 20_000 },
  )
  .then(() => true)
  .catch(() => false);
check('first take image actually decoded', firstImgOk);
check('captions show a cost', (await page.locator('.take .money').count()) > 0);
check('re-roll buttons present', (await page.locator('button', { hasText: 'Re-roll' }).count()) > 0);

// design page (round 7): template picker renders, NOTHING auto-renders
let previewPosts = 0;
page.on('request', (r) => {
  if (r.method() === 'POST' && /\/api\/projects\/[^/]+\/previews/.test(r.url())) previewPosts++;
});
await page.goto(`${BASE}/projects/${SLUG}/design`);
const tplCards = await page.locator('.tpl-card').count();
check(`template picker renders (${tplCards})`, tplCards >= 1);
await page.waitForTimeout(1500);
check(`no preview POSTs on design-page load (${previewPosts})`, previewPosts === 0);

// results page: groups render (the project needs past renders)
await page.goto(`${BASE}/projects/${SLUG}/results`);
check('results heading renders', (await page.locator('h1').textContent()) === 'Results');
const rGroups = await page.locator('.rgroup').count();
check(`results groups render (${rGroups})`, rGroups >= 1);
const rThumbOk = await page
  .waitForFunction(
    () => { const i = document.querySelector('.rgroup img'); return i && i.complete && i.naturalWidth > 0; },
    undefined,
    { timeout: 20_000 },
  )
  .then(() => true)
  .catch(() => false);
check('first result thumb decoded', rThumbOk);

if (SHOTS) {
  await page.goto(`${BASE}/projects/${SLUG}/design`);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}/smoke-design.png`, fullPage: true });
  await page.goto(`${BASE}/projects/${SLUG}/results`);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}/smoke-results.png`, fullPage: true });
  await page.goto(`${BASE}/projects/${SLUG}/shots/1`);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SHOTS}/smoke-contact-sheet.png`, fullPage: true });
  await page.goto(`${BASE}/projects`);
  await page.screenshot({ path: `${SHOTS}/smoke-projects.png` });
  console.log(`screenshots -> ${SHOTS}`);
}

const realErrors = consoleErrors.filter((e) => !BLACKHOLED.test(e));
check('no console errors', realErrors.length === 0);
for (const e of realErrors) console.error('  console:', e);
check('no failed requests', failedRequests.length === 0);
for (const e of failedRequests) console.error('  request:', e);

await browser.close();
process.exit(failures ? 1 : 0);
