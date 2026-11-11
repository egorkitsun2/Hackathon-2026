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
  await login('+77000000001');
  await page.locator('a[href="#/new-ticket"]').click();
  for (const viewport of [1280, 390]) {
    await page.setViewportSize({ width: viewport, height: 900 });
    const title = '  ' + '\u{1F600}'.repeat(120) + '  ';
    const description = '  ' + '\u049B'.repeat(4000) + '  ';
    await page.locator('#ticket-title').fill(title);
    await page.locator('#ticket-description').fill(description);
    assert.equal(await page.locator('#ticket-title-counter').textContent(), '120 / 120');
    assert.equal(await page.locator('#ticket-description-counter').textContent(), '4000 / 4000');
    const normalColor = await page.locator('#ticket-title-counter').evaluate(element => getComputedStyle(element).color);
    await page.locator('[data-language="kk"]').click();
    assert.equal(await page.locator('#ticket-title').inputValue(), title);
    assert.equal(await page.locator('#ticket-description').inputValue(), description);
    assert.equal(await page.locator('#ticket-description-counter').textContent(), '4000 / 4000');
    assert.ok((await page.locator('#ticket-title-counter').getAttribute('aria-label')).length > 10);
    await page.screenshot({ path: resolve(output, `counter-${viewport}-kk.png`), fullPage: true });
    await page.locator('#ticket-title').fill('\u{1F600}'.repeat(121));
    await page.locator('#ticket-description').fill('x'.repeat(4001));
    assert.equal(await page.locator('#ticket-title-counter').getAttribute('data-exceeded'), 'true');
    assert.equal(await page.locator('#ticket-description-counter').getAttribute('data-exceeded'), 'true');
    assert.notEqual(await page.locator('#ticket-title-counter').evaluate(element => getComputedStyle(element).color), normalColor);
    await page.locator('[data-language="ru"]').click();
    assert.equal(await page.locator('#ticket-title-counter').textContent(), '121 / 120');
    await page.screenshot({ path: resolve(output, `counter-${viewport}-over.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#ticket-title').fill('   ');
    await page.locator('#ticket-description').fill('');
    assert.equal(await page.locator('#ticket-title-counter').textContent(), '0 / 120');
    assert.equal(await page.locator('#ticket-description-counter').textContent(), '0 / 4000');
    assert.equal(await page.locator('#ticket-title-counter').getAttribute('data-exceeded'), 'false');
    results.push({ width: viewport, result: 'PASS', checks: ['Unicode code points and trimming', 'exact limits', 'over-limit styling', 'RU/KK preserves values', 'clear resets count', 'no horizontal overflow'] });
  }
  assert.deepEqual(errors, []);
} catch (error) {
  results.push({ step: 'failure', error: error.message });
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, `counter-results.json`), JSON.stringify({ results, traffic, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  db.close();
  assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
  assert.ok(basename(storage).startsWith('team-voice-browser-'));
  await rm(storage, { recursive: true, force: true });
}
