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
  const employeeContext = await browser.newContext();
  await employeeContext.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const employeePage = await employeeContext.newPage();
  await employeePage.goto(`${origin}/#/login`);
  await employeePage.waitForFunction(() => !document.querySelector('#submit-login').disabled);
  await employeePage.locator('#phone').fill('+77000000001');
  await employeePage.locator('#password').fill(secret);
  await employeePage.locator('#submit-login').click();
  await employeePage.waitForURL('**/#/employee');
  await login('+77000000003');
  await page.locator('a[href="#/admin/users"]').click();
  const row = page.locator('#users-list li').first();
  await row.waitFor();
  await page.locator('[data-language="kk"]').click();
  await row.locator('button').first().click();
  await page.locator('#reset-password-dialog').waitFor({ state: 'visible' });
  assert.equal(traffic.filter(r => r.path.endsWith('/reset-password')).length, 0);
  assert.ok((await page.locator('#reset-password-warning').innerText()).length > 20);
  await shot('reset-confirm-kk');
  await page.locator('#close-reset-password').click();
  await page.locator('[data-language="ru"]').click();
  await row.locator('button').first().click();
  await shot('reset-confirm-ru');
  await page.locator('#confirm-reset-password').click();
  await page.locator('#reset-password-result').waitFor({ state: 'visible' });
  const temporary = await page.locator('#reset-temporary-password').textContent();
  assert.ok(temporary.length >= 12);
  assert.equal((await employeePage.request.get(`${origin}/api/v1/auth/me`)).status(), 401);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } }));
  await page.locator('#copy-reset-password').click();
  await page.waitForFunction(() => document.querySelector('#reset-copy-status').textContent.length > 0);
  assert.equal(await page.locator('#reset-temporary-password').textContent(), temporary);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#reset-temporary-password').textContent === '');
  assert.equal(traffic.filter(r => r.path.endsWith('/reset-password')).length, 1);
  results.push({ step: 'reset', result: 'confirm RU/KK, one POST, revoked old employee session, copy fallback and Escape cleanup: PASS' });
  await employeePage.reload();
  await employeePage.locator('#phone').waitFor({ state: 'visible' });
  await employeePage.locator('#phone').fill('+77000000001');
  await employeePage.locator('#password').fill(temporary);
  await employeePage.locator('#submit-login').click();
  await employeePage.waitForURL('**/#/change-password');
  await employeePage.locator('#current-password').fill(temporary);
  const replacement = randomBytes(24).toString('base64url');
  await employeePage.locator('#new-password').fill(replacement);
  await employeePage.locator('#repeat-password').fill(replacement);
  await employeePage.locator('#change-password-form button[type="submit"]').click();
  await employeePage.waitForURL('**/#/employee');
  results.push({ step: 'first-login', result: 'temporary login forces existing password change screen, then employee cabinet: PASS' });
  await row.locator('button').last().click();
  await page.waitForFunction(() => document.querySelector('#users-list li button:last-child').textContent === 'Активировать');
  await row.locator('button').first().click();
  await page.locator('#confirm-reset-password').click();
  await page.locator('#reset-password-result').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#reset-password-blocked').isVisible(), true);
  assert.equal(db.prepare('SELECT is_active FROM users WHERE role = ?').get('employee').is_active, 0);
  await page.locator('#close-reset-password').click();
  assert.equal(await page.locator('#reset-temporary-password').textContent(), '');
  await page.setViewportSize({ width: 390, height: 844 });
  await row.locator('button').first().click();
  await shot('reset-blocked-mobile-confirm');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#close-reset-password').click();
  assert.equal(traffic.filter(r => r.path.endsWith('/reset-password')).length, 2);
  await page.locator('#logout').click();
  await page.waitForURL('**/#/login');
  assert.equal(await page.locator('#reset-temporary-password').textContent(), '');
  assert.deepEqual(errors, []);
  results.push({ step: 'blocked', result: 'reset stays blocked, warning, mobile confirmation, logout cleanup: PASS' });
  await employeeContext.close();
} catch (error) {
  results.push({ step: 'failure', error: error.message });
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, `reset-results-${width}.json`), JSON.stringify({ results, traffic, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  db.close();
  assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
  assert.ok(basename(storage).startsWith('team-voice-browser-'));
  await rm(storage, { recursive: true, force: true });
}
