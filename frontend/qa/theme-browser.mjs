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
  const context = await browser.newContext({ acceptDownloads: true, colorScheme: 'dark', viewport: { width, height: 1000 } });
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
  const checks = [];
  for (const status of ['new','in_review','resolved','rejected']) db.prepare("INSERT INTO tickets (author_id,type,title,description,status,created_at,updated_at) VALUES (1,'problem',?,'Theme audit description',?,?,?)")
    .run(`Theme ${status}`, status, new Date().toISOString(), new Date().toISOString());
  let releaseApp, appSeen;
  const appReady = new Promise(resolve => { appSeen = resolve; });
  await page.route('**/js/app.js?*', async route => {
    appSeen(); await new Promise(resolve => { releaseApp = resolve; }); await route.continue();
  });
  await page.goto(`${origin}/#/login`, { waitUntil: 'commit' });
  await appReady;
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.documentElement).colorScheme === 'dark');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgb(21, 26, 34)');
  checks.push('System dark applied before app module executes (no light bootstrap frame)');
  releaseApp();
  await page.waitForFunction(() => !document.querySelector('#submit-login').disabled);
  await page.unroute('**/js/app.js?*');
  await shot('theme-dark-login');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await shot('theme-light-login');
  await page.locator('#theme-toggle').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => localStorage.getItem('team-voice-theme')), 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#submit-login').disabled);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.locator('#theme-toggle').click(); await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload(); await page.waitForFunction(() => !document.querySelector('#submit-login').disabled);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.locator('#theme-toggle').click();
  checks.push('Keyboard toggle, localStorage/reload and explicit light overrides system dark');
  await page.locator('#phone').fill('+77000000001'); await page.locator('#password').fill(secret);
  const baseColor = await page.locator('#submit-login').evaluate(el => getComputedStyle(el).backgroundColor);
  await page.locator('#submit-login').hover();
  assert.notEqual(await page.locator('#submit-login').evaluate(el => getComputedStyle(el).backgroundColor), baseColor);
  await page.locator('#phone').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.locator('#password').evaluate(el => getComputedStyle(el).outlineWidth), '3px');
  let releaseLogin, loginSeen;
  const loginReady = new Promise(resolve => { loginSeen = resolve; });
  await page.route('**/api/v1/auth/login', async route => { loginSeen(); await new Promise(resolve => { releaseLogin = resolve; }); await route.continue(); });
  await page.locator('#submit-login').click(); await loginReady;
  await page.locator('#theme-toggle').click();
  assert.equal(await page.locator('#submit-login').isDisabled(), true);
  assert.equal(await page.locator('#submit-login').evaluate(el => getComputedStyle(el).opacity), '0.65');
  assert.equal(await page.locator('#password').inputValue(), secret);
  releaseLogin(); await page.waitForURL('**/#/employee'); await page.unroute('**/api/v1/auth/login');
  await page.locator('#theme-toggle').click();
  await page.locator('#ticket-list li').first().waitFor();
  await shot('theme-dark-employee');
  checks.push('Hover/focus/disabled/loading readable; toggle preserves pending login');
  const contrast = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const rgb = hex => hex.trim().replace('#','').match(/../g).map(v => parseInt(v,16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
    const luminance = hex => { const v=rgb(hex); return v[0]*.2126+v[1]*.7152+v[2]*.0722; };
    const ratio = (a,b) => { const x=luminance(a),y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
    return ['--color-text','--color-muted','--color-error','--color-status-new','--color-status-review','--color-status-resolved','--color-status-rejected'].map(name => ({ name, ratio: ratio(style.getPropertyValue(name),style.getPropertyValue('--color-inset')) }));
  });
  assert.ok(contrast.every(value => value.ratio >= 4.5));
  await page.locator('a[href="#/new-ticket"]').click();
  await page.locator('#ticket-title').fill('Theme draft');
  await page.locator('#ticket-description').fill('Draft must survive theme and language switches.');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aRsAAAAASUVORK5CYII=', 'base64');
  await page.locator('#ticket-files').setInputFiles({ name: 'theme.png', mimeType: 'image/png', buffer: png });
  await page.locator('#ticket-previews img').waitFor();
  const src = await page.locator('#ticket-previews img').getAttribute('src');
  await page.locator('#theme-toggle').click(); await page.locator('#theme-toggle').click();
  assert.equal(await page.locator('#ticket-title').inputValue(), 'Theme draft');
  assert.equal(await page.locator('#ticket-previews img').getAttribute('src'), src);
  await page.locator('[data-language="kk"]').click();
  const kkLabel = await page.locator('#theme-toggle').getAttribute('aria-label');
  await page.locator('[data-language="ru"]').click();
  assert.notEqual(await page.locator('#theme-toggle').getAttribute('aria-label'), kkLabel);
  assert.equal(await page.locator('#ticket-previews li').count(), 1);
  await page.locator('#ticket-title').fill('x'.repeat(121));
  await page.locator('#send-ticket').click(); assert.equal(await page.locator('#ticket-title-error').isVisible(), true);
  await shot('theme-dark-form-preview');
  for (const w of [320,390,1280]) {
    await page.setViewportSize({ width:w,height:900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.setViewportSize({ width:390,height:900 }); await shot('theme-dark-mobile-form');
  checks.push('RU/KK, forms/files/counters preserved; errors/previews and 320/390/1280 layout');
  await page.locator('#new-ticket-screen .back-link').first().click();
  await page.locator('#ticket-list a').first().click();
  await page.locator('#ticket-detail-content').waitFor({ state:'visible' });
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark'); await shot('theme-dark-details');
  await page.locator('#logout').click(); await page.waitForURL('**/#/login');
  await login('+77000000003');
  await page.setViewportSize({ width:1280,height:1000 });
  await page.locator('#admin-ticket-rows tr').first().waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark'); await shot('theme-dark-admin');
  await page.locator('a[href="#/admin/users"]').click();
  await page.locator('#users-list li').waitFor();
  await page.locator('#user-full_name').fill('Preserved user draft');
  await page.locator('#theme-toggle').click(); await page.locator('#theme-toggle').click();
  assert.equal(await page.locator('#user-full_name').inputValue(),'Preserved user draft');
  await page.locator('#users-list li button').first().click();
  await page.locator('#reset-password-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#reset-password-dialog').evaluate(el => getComputedStyle(el).backgroundColor),'rgb(30, 38, 50)');
  await shot('theme-dark-modal');
  await page.locator('#close-reset-password').click();
  await page.locator('#theme-toggle').click(); await page.locator('#users-list li button').first().click();
  await shot('theme-light-modal'); await page.locator('#close-reset-password').click();
  checks.push('Theme survives SPA/role navigation; employee list/admin table/stats and modal use palette');
  db.prepare("INSERT INTO users (phone,full_name,department,position,password_hash,role,is_active,must_change_password,created_at) SELECT '+77000000002','QA first login',department,position,password_hash,'employee',1,1,created_at FROM users WHERE phone='+77000000001'").run();
  await page.locator('#theme-toggle').click();
  await page.locator('#logout').click(); await page.waitForURL('**/#/login');
  await page.locator('#phone').fill('+77000000002'); await page.locator('#password').fill(secret);
  await page.locator('#submit-login').click(); await page.waitForURL('**/#/change-password');
  const passwordDraft = randomBytes(24).toString('base64url');
  await page.locator('#new-password').fill(passwordDraft);
  await page.locator('#theme-toggle').click(); await page.locator('#theme-toggle').click();
  assert.equal(await page.locator('#new-password').inputValue(), passwordDraft);
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.locator('#new-password').fill(''); await shot('theme-dark-first-password');
  checks.push('Mandatory first-password screen uses theme and preserves password draft');
  assert.deepEqual(errors,[]);
  results.push({result:'PASS',checks,contrast});
} catch (error) {
  results.push({ step: 'failure', error: error.message });
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, `theme-results.json`), JSON.stringify({ results, traffic, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  db.close();
  assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
  assert.ok(basename(storage).startsWith('team-voice-browser-'));
  await rm(storage, { recursive: true, force: true });
}
