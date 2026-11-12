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
  await context.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    window.__previewURLs = { created: [], revoked: [] };
    URL.createObjectURL = value => { const url = create(value); window.__previewURLs.created.push(url); return url; };
    URL.revokeObjectURL = url => { window.__previewURLs.revoked.push(url); return revoke(url); };
  });
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
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aRsAAAAASUVORK5CYII=', 'base64');
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCZgA//2Q==', 'base64');
  const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==', 'base64');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  const fixtures = [['photo.png',png],['portrait.jpg',jpeg],['portrait.jpeg',jpeg],['image.webp',webp],['document.pdf',pdf]];
  for (const [name,bytes] of fixtures) await writeFile(join(storage,name),bytes);
  async function choose(names) { await page.locator('#ticket-files').setInputFiles(names.map(name => join(storage,name))); }
  async function imagesLoaded() { await page.waitForFunction(() => [...document.querySelectorAll('#ticket-previews img')].every(image => image.complete && image.naturalWidth > 0)); }
  async function activeURLs() { return page.evaluate(() => window.__previewURLs.created.filter(url => !window.__previewURLs.revoked.includes(url)).length); }
  await choose(['photo.png', 'portrait.jpg', 'document.pdf']); await imagesLoaded();
  assert.equal(await page.locator('#ticket-previews li').count(), 3);
  assert.equal(await page.locator('#ticket-previews .attachment-pdf').textContent(), 'PDF');
  assert.equal(await activeURLs(), 2);
  await page.setViewportSize({ width: 1280, height: 1000 }); await shot('preview-desktop');
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator('[data-language="kk"]').click();
  assert.equal(await page.locator('#ticket-previews li').count(), 3);
  assert.equal(await activeURLs(), 2);
  await shot('preview-mobile-kk');
  for (const w of [320,390,1280]) {
    await page.setViewportSize({ width: w, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.locator('[data-language="ru"]').click();
  await page.locator('#new-ticket-screen .back-link').first().click();
  assert.equal(await activeURLs(), 0);
  await page.locator('a[href="#/new-ticket"]').click(); await imagesLoaded();
  assert.equal(await page.locator('#ticket-previews li').count(), 3);
  await page.locator('#ticket-previews li').filter({ hasText: 'portrait.jpg' }).getByRole('button').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#ticket-previews li').count(), 2);
  await choose(['image.webp']); await imagesLoaded();
  assert.equal(await page.locator('#ticket-previews li').count(), 3);
  await choose(['portrait.jpeg']);
  assert.equal(await page.locator('#ticket-previews li').count(), 3);
  assert.equal(await page.locator('#ticket-files-error').isVisible(), true);
  await page.locator('#ticket-previews li').filter({ hasText: 'image.webp' }).getByRole('button').click();
  await choose(['portrait.jpeg']); await imagesLoaded();
  assert.equal(await page.locator('#ticket-previews img').count(), 2);
  assert.equal(traffic.filter(item => item.method === 'POST' && item.path.endsWith('/attachments')).length, 0);
  await page.locator('#clear-ticket-files').click(); assert.equal(await activeURLs(), 0);
  await choose(['photo.png', 'portrait.jpg', 'document.pdf']); await imagesLoaded();
  await page.locator('#ticket-previews li').filter({ hasText: 'portrait.jpg' }).getByRole('button').click();
  await page.locator('#ticket-type').selectOption('problem');
  await page.locator('#ticket-category').selectOption('general');
  await page.locator('#ticket-title').fill('QA preview attachments');
  await page.locator('#ticket-description').fill('Only remaining attachments must be sent.');
  await page.locator('#send-ticket').click();
  await page.locator('#created-ticket-details').waitFor({ state: 'visible' });
  assert.equal(await activeURLs(), 0);
  assert.equal(await page.locator('#ticket-previews li').count(), 0);
  assert.equal(traffic.filter(item => item.method === 'POST' && item.path.endsWith('/attachments')).length, 2);
  await page.locator('#created-ticket-details').click();
  await page.locator('#attachments-list li').first().waitFor();
  const names = db.prepare('SELECT original_name FROM ticket_attachments ORDER BY id').all().map(row => row.original_name);
  assert.deepEqual(names, ['photo.png', 'document.pdf']);
  const ticketURL = page.url();
  async function savedPreview(role) {
    await page.waitForFunction(() => {
      const image = document.querySelector('#attachments-list .attachment-image-preview');
      return image && image.complete && image.naturalWidth > 0;
    });
    assert.equal(await page.locator('#attachments-list .attachment-pdf').textContent(), 'PDF');
    assert.equal(await page.locator('#attachments-list iframe, #attachments-list embed').count(), 0);
    for (const [name, bytes] of [['photo.png', png], ['document.pdf', pdf]]) {
      const downloadReady = page.waitForEvent('download');
      await page.locator('#attachments-list li').filter({ hasText: name }).locator('a').click();
      const download = await downloadReady;
      assert.deepEqual(await readFile(await download.path()), bytes);
    }
    for (const w of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width: w, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.locator('[data-language="kk"]').click();
    assert.equal(await page.locator('#attachments-list .attachment-image-preview').count(), 1);
    await shot(`saved-preview-${role}`);
    await page.locator('[data-language="ru"]').click();
  }
  await savedPreview('employee');
  await page.locator('#logout').click();
  await page.waitForURL('**/#/login');
  assert.equal(await activeURLs(), 0);
  await login('+77000000003');
  await page.goto(ticketURL.replace('/#/tickets/', '/#/admin/tickets/'));
  await savedPreview('admin');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#attachments-list img')?.naturalWidth > 0);
  results.push({ result: 'PASS', checks: ['saved PNG decoded for employee and administrator', 'PDF card and protected downloads match original bytes for both roles', 'saved previews survive RU/KK and reload', '320/390/768/1280 no overflow', 'logout revokes saved preview URLs'] });
  assert.deepEqual(errors, []);
  results.push({ result: 'PASS', checks: ['JPG/JPEG/PNG/WebP thumbnails decoded', 'PDF icon/name/size', 'RU/KK', '320/390/1280 layout', 'no upload before submit', 'keyboard delete preserves remaining files', 'append selection and quota', 'clear and leave revoke URLs', 'only remaining two files uploaded', 'success clears previews and URLs'] });
} catch (error) {
  results.push({ step: 'failure', error: error.stack });
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, `preview-results.json`), JSON.stringify({ results, traffic, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  db.close();
  assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
  assert.ok(basename(storage).startsWith('team-voice-browser-'));
  await rm(storage, { recursive: true, force: true });
}
