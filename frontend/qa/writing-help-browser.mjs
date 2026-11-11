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
  assert.equal(await page.locator('#ticket-title').inputValue(), '');
  assert.equal(await page.locator('#ticket-writing-help').evaluate(el => el.open), false);
  const summary = page.locator('#ticket-writing-help summary');
  await summary.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#ticket-help-choose').isVisible(), true);
  const title = 'Original draft title', description = 'Original description should never be replaced by prompts.';
  await page.locator('#ticket-title').fill(title); await page.locator('#ticket-description').fill(description);
  await page.locator('#ticket-files').setInputFiles({ name: 'document.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n') });
  for (const viewport of [1280,390]) {
    await page.setViewportSize({ width:viewport,height:1000 });
    for (const theme of ['light','dark']) {
      if ((await page.locator('html').getAttribute('data-theme')) !== theme) await page.locator('#theme-toggle').click();
      for (const [type,count] of [['problem',4],['suggestion',3],['complaint',4],['gratitude',3]]) {
        await page.locator('[data-language="ru"]').click();
        await page.locator('#ticket-type').selectOption(type);
        const ru = await page.locator('#ticket-help-prompts li').allTextContents();
        assert.equal(ru.length,count); assert.ok(ru.every(text => text.length > 2 && text !== 'undefined'));
        await page.locator('[data-language="kk"]').click();
        const kk = await page.locator('#ticket-help-prompts li').allTextContents();
        assert.equal(kk.length,count); assert.ok(kk.every(text => text.length > 2 && text !== 'undefined'));
        assert.notDeepEqual(ru,kk);
        assert.equal(await page.locator('#ticket-title').inputValue(),title);
        assert.equal(await page.locator('#ticket-description').inputValue(),description);
        assert.equal(await page.locator('#ticket-previews li').count(),1);
        assert.equal(await page.locator('#ticket-writing-help').evaluate(el => el.open),true);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
      await page.screenshot({ path:resolve(output,`writing-help-${viewport}-${theme}.png`),fullPage:true });
      results.push({ width:viewport,theme,result:'PASS',checks:['four existing types','RU/KK','draft/files preserved','details stays open','no overflow'] });
    }
  }
  assert.equal(traffic.filter(row => row.path.endsWith('/attachments')).length,0);
  const creation = page.waitForRequest(request => new URL(request.url()).pathname === '/api/v1/tickets' && request.method() === 'POST');
  await page.locator('#send-ticket').click();
  const body = (await creation).postDataJSON();
  assert.deepEqual(body,{type:'gratitude',title,description});
  await page.locator('#created-ticket-details').waitFor({state:'visible'});
  assert.equal(db.prepare('SELECT count(*) AS n FROM ticket_attachments').get().n,1);
  assert.deepEqual(errors,[]);
  results.push({result:'PASS',checks:['keyboard disclosure','no automatic field fill','only type/title/description sent','existing attachment upload preserved']});
} catch (error) {
  results.push({ step: 'failure', error: error.message });
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, `writing-help-results.json`), JSON.stringify({ results, traffic, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  db.close();
  assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
  assert.ok(basename(storage).startsWith('team-voice-browser-'));
  await rm(storage, { recursive: true, force: true });
}
