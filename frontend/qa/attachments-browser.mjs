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
  await page.locator('#ticket-type').selectOption('problem');
  await page.locator('#ticket-category').selectOption('general');
  await page.locator('#ticket-title').fill('QA attachment browser');
  await page.locator('#ticket-description').fill('Isolated Firefox attachment scenario.');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  const sourceFile = join(storage, 'фото.pdf');
  await writeFile(sourceFile, pdf);
  await page.locator('#ticket-files').setInputFiles(sourceFile);
  await shot('01-selected');
  await page.locator('#send-ticket').click();
  await page.locator('#created-ticket-details').waitFor({ state: 'visible' });
  results.push({ step: 'create-result', text: await page.locator('#create-ticket-status').innerText() });
  await shot('02-created');
  await page.locator('#created-ticket-details').click();
  await page.locator('#ticket-detail-content').waitFor({ state: 'visible' });
  results.push({ step: 'employee-details', text: await page.locator('#attachments-list').innerText(), databaseCount: db.prepare('SELECT count(*) AS n FROM ticket_attachments').get().n });
  await shot('03-employee');
  assert.equal(await page.locator('#attachments-list li').count(), 1, 'Employee must see the uploaded attachment');
  async function download(role) {
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#attachments-list a').click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), 'фото.pdf');
    const path = await download.path();
    assert.deepEqual(await readFile(path), pdf);
    results.push({ step: `${role}-download`, result: 'identical bytes' });
  }
  await download('employee');
  await page.reload();
  await page.locator('#attachments-list li').waitFor();
  await page.locator('#logout').click();
  await page.waitForURL('**/#/login');
  await login('+77000000003');
  await page.locator('#admin-ticket-rows a').first().click();
  await page.locator('#attachments-list li').waitFor();
  await shot('04-admin');
  await download('admin');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('05-mobile');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  results.push({ step: 'final', result: 'PASS' });
} catch (error) {
  results.push({ step: 'failure', error: error.message });
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, `browser-results-${width}.json`), JSON.stringify({ results, traffic, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  db.close();
  assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
  assert.ok(basename(storage).startsWith('team-voice-browser-'));
  await rm(storage, { recursive: true, force: true });
}
