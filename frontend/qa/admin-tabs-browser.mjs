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
const output = resolve(root, 'qa/runtime/admin-tabs');
const width = Number(process.env.QA_WIDTH ?? 1280);
const storage = await mkdtemp(join(tmpdir(), 'team-voice-browser-'));
const { serve } = createRequire(new URL('../../backend/package.json', import.meta.url))('@hono/node-server');
const { serveStatic } = createRequire(new URL('../../backend/package.json', import.meta.url))('@hono/node-server/serve-static');
const db = openDatabase(':memory:');
const traffic = [], errors = [], results = [];
let browser, server, app;
try {
  await mkdir(output, { recursive: true });
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

  for(const [phone,name] of [['+77000000004','QA rule manager'],['+77000000005','QA ticket manager'],['+77000000006','QA free manager']]) {
    db.prepare('INSERT INTO users(phone,full_name,department,position,password_hash,role,is_active,created_at) VALUES(?,?,?,?,?,?,1,?)').run(phone,name,'QA','Test',hash,'manager',new Date().toISOString());
  }
  const ruleManager=3,ticketManager=4,freeManager=5;
  db.prepare("UPDATE category_routing SET manager_id=? WHERE category='it'").run(ruleManager);
  for(const [category,assigned] of [['it',ruleManager],['procurement',ticketManager]]) {
    const now=new Date().toISOString();
    db.prepare("INSERT INTO tickets(author_id,type,title,description,status,category,assigned_to,created_at,updated_at) VALUES(1,'problem','QA previous ticket','Isolated existing assigned ticket','new',?,?,?,?)").run(category,assigned,now,now);
  }
  await login('+77000000003');
  const mutations=[];
  page.on('request',request=>{if(request.method()==='PATCH')mutations.push(new URL(request.url()).pathname);});
  await page.locator('a[href="#/admin/users"]').click();await page.locator('#users-list li').first().waitFor();
  assert.equal(await page.locator('#routing-screen').isVisible(),false);
  assert.equal(await page.locator('#category-managers-panel').isVisible(),false);
  await page.evaluate(()=>{window.__navigationMarker='same-document';});
  async function routing() {
    await page.locator('a[href="#/admin/routing"]').click();
    await page.locator('#routing-it').waitFor();
    assert.equal(await page.locator('#users-screen').isVisible(),false);
    assert.equal(await page.locator('#workspace-nav a[aria-current="page"]:visible').count(),1);
  }
  async function users() {
    await page.locator('a[href="#/admin/users"]').click();await page.locator('#users-list li').first().waitFor();
    await page.locator('#users-role-filter').selectOption('manager');
    await page.locator('#users-list li').filter({hasText:'QA rule manager'}).waitFor();
  }
  const row=name=>page.locator('#users-list li').filter({hasText:name});
  const ruleForm=()=>page.locator('#routing-it').locator('..');
  await routing();assert.equal(await page.evaluate(()=>window.__navigationMarker),'same-document');
  await page.goBack();await page.locator('#users-screen').waitFor({state:'visible'});await routing();
  let release,seen;
  const ready=new Promise(resolve=>{seen=resolve;});
  await page.route('**/api/v1/admin/routing/it',async route=>{const response=await route.fetch();seen();await new Promise(resolve=>{release=resolve;});await route.fulfill({response});});
  await ruleForm().locator('button[type="button"]').click();await ready;
  assert.equal(await ruleForm().locator('button[type="button"]').isDisabled(),true);
  assert.notEqual(await page.locator('#category-managers-status').getAttribute('data-tone'),'success');
  release();await page.waitForFunction(()=>document.querySelector('#routing-it').value==='');
  assert.equal(db.prepare("SELECT manager_id FROM category_routing WHERE category='it'").get().manager_id,null);
  assert.equal(db.prepare("SELECT assigned_to FROM tickets WHERE category='it'").get().assigned_to,ruleManager);
  assert.equal(mutations.filter(path=>path==='/api/v1/admin/routing/it').length,1);
  await page.unroute('**/api/v1/admin/routing/it');
  // Create a real new employee ticket after removing the rule.
  const employeeContext=await browser.newContext();
  await employeeContext.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const employeePage=await employeeContext.newPage();
  employeePage.on('pageerror',error=>errors.push(error.message));
  await employeePage.goto(`${origin}/#/login`);await employeePage.waitForFunction(()=>!document.querySelector('#submit-login').disabled);
  await employeePage.locator('#phone').fill('+77000000001');await employeePage.locator('#password').fill(secret);await employeePage.locator('#submit-login').click();await employeePage.waitForURL('**/#/employee');
  await employeePage.locator('a[href="#/new-ticket"]').click();await employeePage.locator('#ticket-type').selectOption('problem');await employeePage.locator('#ticket-category').selectOption('it');
  await employeePage.locator('#ticket-title').fill('QA no route manager');await employeePage.locator('#ticket-description').fill('New ticket after explicit rule removal.');await employeePage.locator('#send-ticket').click();
  await employeePage.locator('#created-ticket-details').waitFor({state:'visible'});
  const created=Number((await employeePage.locator('#created-ticket-details').getAttribute('href')).split('/').pop());
  assert.equal(db.prepare('SELECT assigned_to FROM tickets WHERE id=?').get(created).assigned_to,null);
  await page.locator('a[href="#/admin"]').click();await page.locator('#admin-ticket-rows tr').first().waitFor();await page.locator('#admin-unassigned-filter').check();
  await page.waitForFunction(()=>document.querySelectorAll('#admin-ticket-rows tr').length===1);
  assert.ok((await page.locator('#admin-ticket-rows a').getAttribute('href')).endsWith('/'+created));
  results.push({check:'Separate same-document tabs; one explicit null PATCH; existing ticket retained; new IT ticket appears in admin unassigned queue',result:'PASS'});
  await routing();await page.locator(`#routing-it option[value="${ruleManager}"]`).waitFor({state:'attached'});await page.locator('#routing-it').selectOption(String(ruleManager));await ruleForm().locator('button[type="submit"]').click();
  await page.waitForFunction(()=>document.querySelector('#category-managers-status').dataset.tone==='success');
  await users();await row('QA rule manager').locator('button').last().click();await page.locator('#block-manager-dialog').waitFor({state:'visible'});
  assert.equal(db.prepare('SELECT is_active FROM users WHERE id=?').get(ruleManager).is_active,1);
  assert.equal(mutations.filter(path=>path===`/api/v1/admin/users/${ruleManager}`).length,0);
  const ruWarning=await page.locator('#block-manager-warning').textContent();
  await page.keyboard.press('Escape');await page.locator('[data-language="kk"]').click();
  await row('QA rule manager').locator('button').last().click();await page.locator('#block-manager-dialog').waitFor({state:'visible'});
  const kkWarning=await page.locator('#block-manager-warning').textContent();assert.notEqual(kkWarning,ruWarning);
  for(const width of [320,390,768,1280]) {
    await page.setViewportSize({width,height:760});
    const rect=await page.locator('#block-manager-dialog').boundingBox();assert.ok(rect.x>=0 && rect.x+rect.width<=width+1 && rect.y>=0 && rect.y+rect.height<=761);
  }
  await shot('block-manager-warning-kk');
  await page.keyboard.press('Escape');assert.equal(db.prepare('SELECT is_active FROM users WHERE id=?').get(ruleManager).is_active,1);
  await row('QA rule manager').locator('button').last().click();await page.locator('#block-manager-dialog').waitFor({state:'visible'});await page.locator('#confirm-block-manager').click();
  await row('QA rule manager').locator('.account-blocked').waitFor();
  assert.equal(db.prepare('SELECT is_active FROM users WHERE id=?').get(ruleManager).is_active,0);
  assert.equal(db.prepare("SELECT manager_id FROM category_routing WHERE category='it'").get().manager_id,ruleManager);
  await routing();assert.equal(await page.locator(`#routing-it option[value="${ruleManager}"]`).isDisabled(),true);
  assert.equal(await ruleForm().locator('.routing-current').getAttribute('data-blocked'),'true');
  assert.ok((await ruleForm().locator('.routing-note').textContent()).length>0);
  results.push({check:'Assigned manager confirmation precedes block; Escape cancels; RU/KK warning; actual block preserves rule and is clearly displayed',result:'PASS'});
  await users();await row('QA ticket manager').locator('button').last().click();await page.locator('#block-manager-dialog').waitFor({state:'visible'});
  assert.equal(db.prepare('SELECT is_active FROM users WHERE id=?').get(ticketManager).is_active,1);
  await page.locator('#cancel-block-manager').click();
  await row('QA free manager').locator('button').last().click();await row('QA free manager').locator('.account-blocked').waitFor();
  assert.equal(await page.locator('#block-manager-dialog').isVisible(),false);
  await page.route('**/api/v1/admin/routing',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SERVICE_UNAVAILABLE'}})}));
  await row('QA ticket manager').locator('button').last().click();await page.locator('#block-manager-dialog').waitFor({state:'visible'});
  assert.notEqual(await page.locator('#block-manager-warning').textContent(),kkWarning);
  await page.locator('#cancel-block-manager').click();await page.unroute('**/api/v1/admin/routing');
  assert.equal(db.prepare('SELECT is_active FROM users WHERE id=?').get(ticketManager).is_active,1);
  results.push({check:'Ticket-only assignments warn; no assignments block directly; failed check requires explicit uncertainty confirmation and cancellation does not write',result:'PASS'});
  for(const width of [320,390,768,1280,1920]) {
    await page.setViewportSize({width,height:900});
    for(const mode of ['light','dark']) {
      if(await page.locator('html').getAttribute('data-theme')!==mode) await page.locator('#theme-toggle').click();
      for(const lang of ['ru','kk']) {
        await page.locator(`[data-language="${lang}"]`).click();
        await routing();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        if(width>=1280)assert.ok((await page.locator('#category-managers-list form').first().boundingBox()).width<600);
        if(width===390 && lang==='ru')await shot(`routing-${mode}-mobile`);
        await users();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        if(width===390 && lang==='ru')await shot(`users-${mode}-mobile`);
      }
    }
  }
  await routing();await page.reload();await page.locator('#routing-it').waitFor();assert.equal(await page.locator('#routing-screen').isVisible(),true);
  assert.equal(await page.locator('#users-screen').isVisible(),false);assert.deepEqual(errors,[]);
  results.push({check:'RU/KK, both themes, five widths, compact desktop cards, direct routing URL restore, no page errors',result:'PASS'});
  await employeeContext.close();
} catch (error) {
  results.push({ step: 'failure', error: error.stack });
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, traffic, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  db.close();
  assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
  assert.ok(basename(storage).startsWith('team-voice-browser-'));
  await rm(storage, { recursive: true, force: true });
}
