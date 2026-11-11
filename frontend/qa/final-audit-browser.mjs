import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { firefox } from '../.qa-tools/node_modules/playwright/index.mjs';
import { createApp } from '../../backend/src/index.ts';
import { openDatabase, migrate } from '../../backend/src/db.ts';
import { hashPassword } from '../../backend/src/security.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'qa');
const width = Number(process.env.QA_WIDTH ?? 1280);
const storage = await mkdtemp(join(tmpdir(), 'team-voice-browser-'));
const { serve } = createRequire(new URL('../../backend/package.json', import.meta.url))('@hono/node-server');
const { serveStatic } = createRequire(new URL('../../backend/package.json', import.meta.url))('@hono/node-server/serve-static');
const db = openDatabase(':memory:');
const traffic = [], errors = [], results = [];
let browser, server, app;
try {
  await mkdir(storage, { recursive: true });
  migrate(db);
  const secret = randomBytes(24).toString('base64url');
  const hash = await hashPassword(secret);
  for (const [phone, role] of [['+77000000001', 'employee'], ['+77000000003', 'admin']]) {
    db.prepare('INSERT INTO users (phone,full_name,department,position,password_hash,role,is_active,created_at) VALUES (?,?,?,?,?,?,1,?)')
      .run(phone, `QA ${role}`, 'QA', 'Test', hash, role, new Date().toISOString());
  }
  server = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = await createApp({ db, origin, attachmentsDir: storage, frontendDir: root });
  app.get('*', serveStatic({ root }));
  browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/')) traffic.push({ method: response.request().method(), path, status: response.status() });
  });
  async function shot(name) { await page.screenshot({ path: resolve(output, `${width}-${name}.png`), fullPage: true }); }
  async function login(phone) {
    await page.goto(`${origin}/#/login`);
    await page.locator('#submit-login').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#submit-login').disabled);
    await page.locator('#phone').fill(phone);
    await page.locator('#password').fill(secret);
    await page.locator('#submit-login').click();
    await page.waitForURL(phone.endsWith('3') ? '**/#/admin' : '**/#/employee');
  }
  const findings = [];
  for (let n = 0; n < 21; n++) db.prepare("INSERT INTO tickets (author_id,type,title,description,status,created_at,updated_at) VALUES (1,'problem',?,'Isolated audit description','new',?,?)")
    .run(`Audit ticket ${n + 1}`, new Date(Date.now() + n * 1000).toISOString(), new Date().toISOString());
  await login('+77000000001');
  await page.locator('#next-page').click();
  await page.waitForFunction(() => document.querySelector('#page-number').textContent.includes('2'));
  await page.locator('#ticket-list a').first().click();
  await page.locator('#ticket-detail-content').waitFor({ state: 'visible' });
  await page.locator('#detail-back').click();
  await page.waitForFunction(() => document.querySelector('#ticket-list').children.length > 0);
  const returnedPage = await page.locator('#page-number').textContent();
  if (returnedPage.includes('1')) findings.push({ id: 'F3', area: 'frontend', issue: 'Employee returns to page 1 after opening a ticket from page 2.' });
  await page.locator('a[href="#/new-ticket"]').click();
  for (const w of [320,390,768,1280]) {
    await page.setViewportSize({ width: w, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `New ticket overflow ${w}`);
  }
  await page.locator('[data-language="kk"]').click();
  await shot('audit-new-ticket-kk');
  await page.locator('[data-language="ru"]').click();
  let releaseOld, oldSeen;
  const oldReady = new Promise(resolve => { oldSeen = resolve; });
  await page.route('**/api/v1/tickets?*', async route => {
    if (releaseOld) return route.continue();
    oldSeen();
    await new Promise(resolve => { releaseOld = resolve; });
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHORIZED' } }) });
  });
  await page.evaluate(() => { location.hash = '#/employee'; });
  await oldReady;
  await page.locator('#logout').click();
  await page.waitForURL('**/#/login');
  await login('+77000000003');
  await page.locator('#admin-screen').waitFor({ state: 'visible' });
  releaseOld();
  await page.waitForURL('**/#/login');
  findings.push({ id: 'F1', area: 'frontend', issue: 'Delayed 401 from previous employee request logs out freshly logged-in administrator in UI.' });
  assert.equal((await page.request.get(`${origin}/api/v1/auth/me`)).status(), 200);
  await page.unroute('**/api/v1/tickets?*');
  await page.reload();
  await page.waitForURL('**/#/admin');
  await page.locator('a[href="#/admin/users"]').click();
  await page.locator('#users-list li').waitFor();
  let releaseReset, resetSeen;
  const resetReady = new Promise(resolve => { resetSeen = resolve; });
  await page.route('**/reset-password', async route => {
    resetSeen(); await new Promise(resolve => { releaseReset = resolve; }); await route.abort();
  });
  await page.locator('#users-list li button').first().click();
  await page.locator('#confirm-reset-password').click();
  await resetReady;
  assert.equal(await page.locator('#close-reset-password').isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#reset-password-dialog').isVisible(), true);
  findings.push({ id: 'F2', area: 'frontend', issue: 'Pending reset has no client timeout; modal cannot be closed via button/Escape and blocks logout/navigation while connection hangs.' });
  await shot('audit-pending-reset');
  releaseReset();
  await page.locator('#reset-password-dialog').waitFor({ state: 'hidden' });
  await page.unroute('**/reset-password');
  await page.locator('a[href="#/admin"]').click();
  await page.locator('#admin-ticket-rows a').first().click();
  await page.locator('#take-ticket').click();
  await page.locator('#ticket-decision-form').waitFor({ state: 'visible' });
  await page.locator('#ticket-decision').selectOption('resolved');
  await page.locator('#ticket-decision-comment').fill('Audit decision: problem resolved.');
  await page.locator('#save-ticket-decision').click();
  await page.waitForFunction(() => document.querySelector('#detail-status').classList.contains('status-resolved'));
  await page.locator('#detail-back').click();
  await page.locator('#admin-stats dd').first().waitFor();
  assert.equal(await page.locator('#admin-stats dd').nth(5).textContent(), '1');
  await page.locator('#admin-status-filter').selectOption('resolved');
  await page.waitForFunction(() => document.querySelectorAll('#admin-ticket-rows tr').length === 1);
  results.push({ step: 'admin-decision', result: 'UI new -> in_review -> resolved, comment, stats refresh and filter: PASS' });
  assert.deepEqual(errors, []);
  results.push({ step: 'targeted-audit', findings, errors, checks: ['pagination return','RU/KK','320/390/768/1280 overflow','late 401 session race','pending reset modal'] });
} catch (error) {
  results.push({ step: 'failure', error: error.message });
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, `audit-results-${width}.json`), JSON.stringify({ results, traffic, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  db.close();
  assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
  assert.ok(basename(storage).startsWith('team-voice-browser-'));
  await rm(storage, { recursive: true, force: true });
}
