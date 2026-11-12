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
  const fixtures = [
    ['problem','new','Replace warehouse lighting'],['suggestion','in_review','Improve the shift handover process'],
    ['complaint','rejected','Parking access near the office'],['gratitude','resolved','Thank you to the support team'],
  ];
  for (const [type,state,title] of fixtures) {
    const now = new Date().toISOString();
    const ticket = db.prepare('INSERT INTO tickets (author_id,type,title,description,status,created_at,updated_at) VALUES (1,?,?,?,?,?,?)')
      .run(type,title,'Detailed example for reviewing the redesigned interface.',state,now,now);
    db.prepare("INSERT INTO ticket_events(ticket_id,actor_id,old_status,new_status,comment,created_at) VALUES (?,1,NULL,'new',NULL,?)").run(ticket.lastInsertRowid,now);
  }
  await login('+77000000001');
  const adminContext = await browser.newContext({ viewport:{width:1280,height:1000} });
  await adminContext.route('**/*',route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const adminPage = await adminContext.newPage();
  adminPage.on('pageerror',error => errors.push(error.message));
  adminPage.setDefaultTimeout(12000);
  await adminPage.goto(`${origin}/#/login`);
  await adminPage.waitForFunction(() => !document.querySelector('#submit-login').disabled);
  await adminPage.locator('#phone').fill('+77000000003'); await adminPage.locator('#password').fill(secret);
  await adminPage.locator('#submit-login').click(); await adminPage.waitForURL('**/#/admin');
  async function theme(tab,value) { if(await tab.locator('html').getAttribute('data-theme')!==value) await tab.locator('#theme-toggle').click(); }
  async function capture(tab,name,w) {
    assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth),false,`Overflow ${name}/${w}`);
    const missing = await tab.evaluate(() => [...document.querySelectorAll('button')].filter(el => el.getClientRects().length && !el.textContent.trim() && !el.getAttribute('aria-label')).length);
    assert.equal(missing,0);
    await tab.screenshot({path:resolve(output,`redesign-${w}-${name}.png`),fullPage:true});
  }
  const ratios = [];
  for (const w of [320,390,768,1280,1920]) {
    await page.setViewportSize({width:w,height:1000}); await adminPage.setViewportSize({width:w,height:1000});
    for (const mode of ['light','dark']) {
      await theme(page,mode); await theme(adminPage,mode);
      await page.goto(`${origin}/#/employee`); await page.locator('#ticket-list li').first().waitFor();
      await capture(page,`${mode}-employee`,w);
      assert.equal(await page.locator('#workspace-nav a[aria-current="page"]:visible').count(),1);
      await page.locator('a[href="#/new-ticket"]').click();
      await page.locator('#ticket-type').selectOption('problem');
  await page.locator('#ticket-category').selectOption('general');
      await page.locator('#ticket-title').fill('Workplace issue');
      await page.locator('#ticket-description').fill('Please check the lighting in the warehouse work area.');
      if (!(await page.locator('#ticket-writing-help').evaluate(el=>el.open))) await page.locator('#ticket-writing-help summary').click();
      if(await page.locator('#ticket-previews li').count()) await page.locator('#clear-ticket-files').click();
      const chooserEvent = page.waitForEvent('filechooser');
      await page.locator('#choose-ticket-files').focus(); await page.keyboard.press('Enter');
      await (await chooserEvent).setFiles({name:'details.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')});
      await capture(page,`${mode}-form`,w);
      await adminPage.goto(`${origin}/#/admin`); await adminPage.locator('#admin-ticket-rows tr').first().waitFor();
      await capture(adminPage,`${mode}-admin`,w);
      await adminPage.locator('a[href="#/admin/users"]').click(); await adminPage.locator('#users-list li').first().waitFor();
      await capture(adminPage,`${mode}-users`,w);
      await adminPage.locator('#users-list li button').first().click();
      await adminPage.locator('#reset-password-dialog').waitFor({state:'visible'});
      const rect = await adminPage.locator('#reset-password-dialog').boundingBox();
      assert.ok(rect.x>=0 && rect.y>=0 && rect.x+rect.width<=w+1 && rect.y+rect.height<=1001);
      await capture(adminPage,`${mode}-reset-dialog`,w);
      await adminPage.keyboard.press('Escape');
      const contrast = await page.evaluate(() => {
        const s=getComputedStyle(document.documentElement);
        const lum = value => { const c=value.trim().replace('#','').match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722; };
        return [['--color-text','--color-surface'],['--color-muted','--color-surface'],['--color-error','--color-surface'],['--color-on-primary','--color-primary'],...['new','review','resolved','rejected'].map(x=>[`--color-status-${x}`,`--color-status-${x}-bg`])].map(([a,b])=>{const x=lum(s.getPropertyValue(a)),y=lum(s.getPropertyValue(b));return {token:a,ratio:(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};});
      });
      assert.ok(contrast.every(row=>row.ratio>=4.5),JSON.stringify({mode,contrast}));
      if(w===1280) ratios.push({mode,contrast});
      results.push({width:w,theme:mode,result:'PASS'});
    }
  }
  await page.setViewportSize({width:390,height:900});
  await page.locator('[data-language="kk"]').click(); await capture(page,'dark-form-kk',390);
  await page.locator('#send-ticket').click(); await page.locator('#created-ticket-details').waitFor({state:'visible'});
  await page.locator('#created-ticket-details').click(); await page.locator('#ticket-detail-content').waitFor({state:'visible'});
  await capture(page,'dark-details-kk',390);
  await adminPage.goto(`${origin}/#/admin`); await adminPage.locator('#admin-ticket-rows tr').first().waitFor();
  await adminPage.locator('#admin-ticket-rows a').first().click();
  await adminPage.locator('#take-ticket').click(); await adminPage.locator('#ticket-decision-form').waitFor({state:'visible'});
  await adminPage.locator('#ticket-decision').selectOption('resolved'); await adminPage.locator('#ticket-decision-comment').fill('The lighting has been replaced.');
  await adminPage.locator('#save-ticket-decision').click();
  await adminPage.waitForFunction(()=>document.querySelector('#detail-status').classList.contains('status-resolved'));
  await capture(adminPage,'dark-admin-decision',1920);
  await adminPage.goto(`${origin}/#/admin/users`); await adminPage.locator('#users-list li').first().waitFor();
  const summary=adminPage.locator('#create-user-panel summary'); await summary.focus(); await adminPage.keyboard.press('Enter');
  await adminPage.locator('#user-full_name').fill('New QA colleague'); await adminPage.locator('#user-phone').fill('+77000000005');
  await adminPage.locator('#user-department').fill('Warehouse'); await adminPage.locator('#user-position').fill('Operator');
  await adminPage.locator('#create-user-form button[type="submit"]').click();
  await adminPage.locator('#user-result-dialog').waitFor({state:'visible'});
  assert.ok((await adminPage.locator('#temporary-password').textContent()).length>0);
  await adminPage.keyboard.press('Escape');
  await adminPage.waitForFunction(()=>document.querySelector('#temporary-password').textContent==='');
  await adminPage.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await adminPage.locator('#theme-toggle').evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
  assert.deepEqual(errors,[]);
  results.push({result:'PASS',checks:['contrast >=4.5','five widths and two themes','one active nav item','keyboard disclosure and dialog Escape','employee creation clears secret','create with file and admin decision preserved','reduced motion'],ratios});
  await adminContext.close();
} catch (error) {
  results.push({ step: 'failure', error: error.message });
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, `redesign-results.json`), JSON.stringify({ results, traffic, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  db.close();
  assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
  assert.ok(basename(storage).startsWith('team-voice-browser-'));
  await rm(storage, { recursive: true, force: true });
}
