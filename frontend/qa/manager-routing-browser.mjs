import assert from 'node:assert/strict';
import { createServer as createHttpsServer } from 'node:https';
import { spawnSync } from 'node:child_process';
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
const https = process.env.QA_HTTPS === '1';
const output = resolve(root, 'qa/runtime/manager-routing', https ? 'https' : '.');
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
  let tls = {};
  if (https) {
    const key=join(storage,'key.pem'),cert=join(storage,'cert.pem');
    const generated=spawnSync('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],{windowsHide:true,stdio:'ignore'});
    assert.equal(generated.status,0,'Temporary TLS certificate generation');
    tls={createServer:createHttpsServer,serverOptions:{key:await readFile(key),cert:await readFile(cert)}};
  }
  server = serve({ ...tls, hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const origin = `${https ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
  app = await createApp({ db, origin, production:https, attachmentsDir: storage, frontendDir: root });
  app.get('*', serveStatic({ root }));
  browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors:https, acceptDownloads: true, viewport: { width, height: 1000 } });
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

  const adminPage=page;
  await login('+77000000003');
  await adminPage.locator('a[href="#/admin/users"]').click();
  await adminPage.locator('#users-list li').first().waitFor();
  async function createAccount(role,phone,name) {
    if(!(await adminPage.locator('#create-user-panel').evaluate(el=>el.open))) await adminPage.locator('#create-user-panel summary').click();
    await adminPage.locator('#user-role').selectOption(role);
    for(const [field,value] of [['phone',phone],['full_name',name],['department','QA'],['position','Test']]) await adminPage.locator(`#user-${field}`).fill(value);
    await adminPage.locator('#create-user-form button[type="submit"]').click();
    await adminPage.locator('#user-result-dialog').waitFor({state:'visible'});
    const temporary=await adminPage.locator('#temporary-password').textContent();
    assert.ok(temporary.length>=12);
    await adminPage.locator('#close-user-created').click();
    assert.equal(await adminPage.locator('#temporary-password').textContent(),'');
    const id=db.prepare('SELECT id FROM users WHERE phone=?').get(phone).id;
    return {id,phone,temporary,password:randomBytes(24).toString('base64url')};
  }
  const it=await createAccount('manager','+77000000004','QA IT manager');
  const procurement=await createAccount('manager','+77000000005','QA Procurement manager');
  async function setRule(category,id) {
    if(new URL(adminPage.url()).hash!=='#/admin/routing') await adminPage.goto(`${origin}/#/admin/routing`);
    await adminPage.locator(`#routing-${category} option[value="${id??''}"]`).waitFor({state:'attached'});
    await adminPage.locator(`#routing-${category}`).selectOption(id===null?'':String(id));
    const response=adminPage.waitForResponse(r=>r.request().method()==='PATCH' && new URL(r.url()).pathname===`/api/v1/admin/routing/${category}`);
    await adminPage.locator(`#routing-${category}`).locator('..').locator('button[type="submit"]').click();
    assert.equal((await response).status(),200);
    await adminPage.waitForFunction(()=>!document.querySelector('#category-managers-list button')?.disabled);
    assert.equal(db.prepare('SELECT manager_id FROM category_routing WHERE category=?').get(category).manager_id,id);
  }
  await setRule('it',it.id); await setRule('procurement',procurement.id);
  async function newTab(label) {
    const ctx=await browser.newContext({ignoreHTTPSErrors:https,acceptDownloads:true,viewport:{width:1280,height:900}});
    await ctx.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    const tab=await ctx.newPage(); tab.setDefaultTimeout(12000);
    tab.on('pageerror',error=>errors.push(error.message));
    tab.on('response',response=>{const path=new URL(response.url()).pathname;if(path.startsWith('/api/'))traffic.push({role:label,path,method:response.request().method(),status:response.status()});});
    return tab;
  }
  async function loginTab(tab,phone,password,required=false) {
    await tab.goto(`${origin}/#/login`); await tab.waitForFunction(()=>!document.querySelector('#submit-login').disabled);
    await tab.locator('#phone').fill(phone);await tab.locator('#password').fill(password);await tab.locator('#submit-login').click();
    await tab.waitForURL(required?'**/#/change-password':phone==='+77000000001'?'**/#/employee':'**/#/manager');
  }
  const employeePage=await newTab('employee'),itPage=await newTab('it-manager'),procPage=await newTab('procurement-manager');
  for(const [tab,account] of [[itPage,it],[procPage,procurement]]) {
    await loginTab(tab,account.phone,account.temporary,true);
    assert.equal(await tab.locator('#workspace-nav').isVisible(),false);
    await tab.locator('#current-password').fill(account.temporary); await tab.locator('#new-password').fill(account.password);await tab.locator('#repeat-password').fill(account.password);
    await tab.locator('#change-password-form button[type="submit"]').click();await tab.waitForURL('**/#/manager');
    assert.equal(await tab.locator('#admin-stats-panel').isVisible(),false);
  }
  await loginTab(employeePage,'+77000000001',secret);
  const png=Buffer.from(await employeePage.evaluate(()=>{const c=document.createElement('canvas');c.width=480;c.height=260;const x=c.getContext('2d');x.fillStyle='#405cf5';x.fillRect(0,0,480,260);x.fillStyle='#ffd65a';x.fillRect(30,30,180,200);x.fillStyle='#fff';x.font='24px sans-serif';x.fillText('QA PNG',250,130);return c.toDataURL('image/png').split(',')[1];}),'base64');
  const pdf=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  await writeFile(join(storage,'route.png'),png);await writeFile(join(storage,'route.pdf'),pdf);
  async function createTicket(category,withFiles=false) {
    await employeePage.goto(`${origin}/#/new-ticket`);
    await employeePage.locator('#ticket-type').selectOption('problem');
    await employeePage.locator('#ticket-title').fill(`QA ${category} routing`);
    await employeePage.locator('#ticket-description').fill('Isolated real backend routing and manager review.');
    if(withFiles) await employeePage.locator('#ticket-files').setInputFiles([join(storage,'route.png'),join(storage,'route.pdf')]);
    await employeePage.locator('#ticket-category').selectOption(category);
    if(withFiles) {
      await employeePage.locator('[data-language="kk"]').click();
      assert.equal(await employeePage.locator('#ticket-category').inputValue(),category);
      assert.equal(await employeePage.locator('#ticket-previews li').count(),2);
      await employeePage.locator('[data-language="ru"]').click();
    }
    await employeePage.locator('#send-ticket').click(); await employeePage.locator('#created-ticket-details').waitFor({state:'visible'});
    const href=await employeePage.locator('#created-ticket-details').getAttribute('href');
    const id=Number(href.split('/').pop()); await employeePage.locator('#created-ticket-details').click();
    await employeePage.locator('#ticket-detail-content').waitFor({state:'visible'});
    return id;
  }
  const id=await createTicket('it',true);
  assert.equal(db.prepare('SELECT assigned_to FROM tickets WHERE id=?').get(id).assigned_to,it.id);
  await employeePage.waitForFunction(()=>document.querySelector('#attachments-list img')?.naturalWidth>0);
  await itPage.reload();await itPage.locator(`#admin-ticket-rows a[href="#/manager/tickets/${id}"]`).waitFor();
  await procPage.reload();await procPage.waitForFunction(()=>!document.querySelector('#admin-screen').hasAttribute('aria-busy'));
  assert.equal(await procPage.locator('#admin-ticket-rows tr').count(),0);
  await procPage.goto(`${origin}/#/manager/tickets/${id}`);await procPage.waitForURL('**/#/manager');
  assert.equal(await procPage.locator('#ticket-detail-content').isVisible(),false);
  const fileId=db.prepare('SELECT id FROM ticket_attachments WHERE ticket_id=? ORDER BY id LIMIT 1').get(id).id;
  assert.equal((await procPage.request.get(`${origin}/api/v1/tickets/${id}/attachments/${fileId}`)).status(),404);
  await itPage.locator(`#admin-ticket-rows a[href="#/manager/tickets/${id}"]`).click();await itPage.locator('#take-ticket').waitFor({state:'visible'});
  await itPage.waitForFunction(()=>document.querySelector('#attachments-list img')?.naturalWidth>0);
  assert.equal(await itPage.locator('#attachment-form').isVisible(),false);
  assert.equal(await itPage.locator('#detail-author-block').isVisible(),false);
  await itPage.locator('#take-ticket').click();await itPage.locator('#ticket-decision-form').waitFor({state:'visible'});
  await itPage.locator('#ticket-decision').selectOption('resolved');await itPage.locator('#ticket-decision-comment').fill('bad');
  await itPage.locator('#save-ticket-decision').click();assert.equal(db.prepare('SELECT status FROM tickets WHERE id=?').get(id).status,'in_review');
  await itPage.locator('#ticket-decision-comment').fill('QA resolution from IT manager.');await itPage.locator('#save-ticket-decision').click();
  await itPage.waitForFunction(()=>document.querySelector('#detail-status').classList.contains('status-resolved'));
  await employeePage.reload();await employeePage.waitForFunction(()=>document.querySelector('#detail-status').classList.contains('status-resolved'));
  assert.equal(await employeePage.locator('#detail-response').textContent(),'QA resolution from IT manager.');
  results.push({check:'Employee IT + PNG/PDF -> only IT manager -> real review/resolution -> employee response',result:'PASS'});
  async function reassign(ticketId,manager) {
    await adminPage.goto(`${origin}/#/admin/tickets/${ticketId}`);
    await adminPage.locator(`#ticket-assignee option[value="${manager??''}"]`).waitFor({state:'attached'});
    await adminPage.locator('#ticket-assignee').selectOption(manager===null?'':String(manager));
    await adminPage.locator('#ticket-assignment-form button').click();
    await adminPage.waitForFunction(()=>document.querySelector('#ticket-assignment-status').dataset.tone==='success');
    assert.equal(db.prepare('SELECT assigned_to FROM tickets WHERE id=?').get(ticketId).assigned_to,manager);
  }
  await reassign(id,procurement.id);
  assert.equal(db.prepare("SELECT manager_id FROM category_routing WHERE category='it'").get().manager_id,it.id);
  await itPage.reload();await itPage.waitForURL('**/#/manager');
  assert.equal(await itPage.locator('#attachments-list img').count(),0);
  assert.equal((await itPage.request.get(`${origin}/api/v1/tickets/${id}/attachments/${fileId}`)).status(),404);
  await procPage.reload();await procPage.locator(`#admin-ticket-rows a[href="#/manager/tickets/${id}"]`).click();
  await procPage.waitForFunction(()=>document.querySelector('#attachments-list img')?.naturalWidth>0);
  for(const [name,bytes] of [['route.png',png],['route.pdf',pdf]]) {
    const [download]=await Promise.all([procPage.waitForEvent('download'),procPage.locator('#attachments-list li').filter({hasText:name}).locator('a').click()]);
    assert.deepEqual(await readFile(await download.path()),bytes);
  }
  results.push({check:'Reassignment changes visibility and binary access immediately; rule unchanged; new manager downloads original PNG/PDF',result:'PASS'});
  const general=await createTicket('general');
  assert.equal(db.prepare('SELECT assigned_to FROM tickets WHERE id=?').get(general).assigned_to,null);
  await adminPage.goto(`${origin}/#/admin`);await adminPage.locator('#admin-ticket-rows tr').first().waitFor();
  await adminPage.locator('#admin-unassigned-filter').check();
  await adminPage.waitForFunction(()=>document.querySelectorAll('#admin-ticket-rows tr').length===1);
  assert.ok((await adminPage.locator('#admin-ticket-rows a').getAttribute('href')).endsWith('/'+general));
  await adminPage.goto(`${origin}/#/admin/users`);await adminPage.locator('#users-list li').first().waitFor();
  await adminPage.locator('#users-role-filter').selectOption('manager');await adminPage.locator('#users-list li').filter({hasText:'QA Procurement manager'}).waitFor();
  let row=adminPage.locator('#users-list li').filter({hasText:'QA Procurement manager'});
  await row.locator('button').last().click();
  await adminPage.locator('#block-manager-dialog').waitFor({state:'visible'});await adminPage.locator('#confirm-block-manager').click();
  await adminPage.waitForFunction(()=>!document.querySelector('#users-list button')?.disabled);
  assert.equal(db.prepare('SELECT is_active FROM users WHERE id=?').get(procurement.id).is_active,0);
  await procPage.reload();await procPage.waitForURL('**/#/login');
  await adminPage.goto(`${origin}/#/admin/routing`);
  await adminPage.waitForFunction(id=>document.querySelector(`#routing-procurement option[value="${id}"]`)?.disabled,procurement.id);
  const blockedTicket=await createTicket('procurement');
  assert.equal(db.prepare('SELECT assigned_to FROM tickets WHERE id=?').get(blockedTicket).assigned_to,null);
  await adminPage.goto(`${origin}/#/admin/users`);await adminPage.locator('#users-role-filter').selectOption('manager');await row.waitFor();
  await row.locator('button').last().click();await adminPage.waitForFunction(()=>!document.querySelector('#users-list button')?.disabled);
  await loginTab(procPage,procurement.phone,procurement.password);
  await procPage.locator(`#admin-ticket-rows a[href="#/manager/tickets/${id}"]`).waitFor();
  assert.equal(db.prepare('SELECT is_active FROM users WHERE id=?').get(procurement.id).is_active,1);
  results.push({check:'General without manager, real unassigned filter, manager block/reactivation with retained assignment',result:'PASS'});

  const conflictTicket=await createTicket('it');
  await itPage.goto(`${origin}/#/manager/tickets/${conflictTicket}`);await itPage.locator('#take-ticket').waitFor({state:'visible'});
  const race=await adminPage.request.patch(`${origin}/api/v1/admin/tickets/${conflictTicket}`,{headers:{Origin:origin},data:{status:'in_review'}});
  assert.equal(race.status(),200);
  await itPage.locator('#take-ticket').click();await itPage.locator('#ticket-decision-form').waitFor({state:'visible'});
  assert.equal(await itPage.locator('#admin-action-status').getAttribute('data-tone'),'warning');
  await reassign(conflictTicket,procurement.id);
  await itPage.locator('#ticket-decision').selectOption('resolved');await itPage.locator('#ticket-decision-comment').fill('This stale decision must be rejected.');
  await itPage.locator('#save-ticket-decision').click();await itPage.waitForURL('**/#/manager');
  assert.equal(await itPage.locator('#detail-title').textContent(),'');
  assert.equal(db.prepare('SELECT status FROM tickets WHERE id=?').get(conflictTicket).status,'in_review');
  results.push({check:'Real 409 concurrent status refresh; real 404 during stale manager decision closes private card and refreshes queue',result:'PASS'});
  await adminPage.goto(`${origin}/#/admin/tickets/${general}`);
  await adminPage.locator(`#ticket-assignee option[value="${it.id}"]`).waitFor({state:'attached'});
  let assignmentCalls=0;
  const assignmentPattern=`**/api/v1/admin/tickets/${general}/assignment`;
  await adminPage.route(assignmentPattern,async route=>{assignmentCalls++;const response=await route.fetch();assert.equal(response.status(),200);await route.abort();});
  await adminPage.locator('#ticket-assignee').selectOption(String(it.id));await adminPage.locator('#ticket-assignment-form button').click();
  await adminPage.waitForFunction(id=>document.querySelector('#ticket-assignment-status').dataset.tone==='warning' && document.querySelector('#ticket-assignee').value===String(id),it.id);
  assert.equal(assignmentCalls,1);assert.equal(db.prepare('SELECT assigned_to FROM tickets WHERE id=?').get(general).assigned_to,it.id);
  assert.equal(await adminPage.locator('#ticket-assignee').inputValue(),String(it.id));
  await adminPage.unroute(assignmentPattern);
  await reassign(general,null);
  await adminPage.goto(`${origin}/#/admin/routing`);await adminPage.locator('#routing-it').waitFor();
  let ruleCalls=0;
  await adminPage.route('**/api/v1/admin/routing/it',async route=>{ruleCalls++;const response=await route.fetch();assert.equal(response.status(),200);await route.abort();});
  await adminPage.locator('#routing-it').selectOption(String(procurement.id));await adminPage.locator('#routing-it').locator('..').locator('button[type="submit"]').click();
  await adminPage.waitForFunction(id=>document.querySelector('#category-managers-status').dataset.tone==='warning' && document.querySelector('#routing-it')?.value===String(id),procurement.id);
  assert.equal(ruleCalls,1);assert.equal(db.prepare("SELECT manager_id FROM category_routing WHERE category='it'").get().manager_id,procurement.id);
  assert.equal(await adminPage.locator('#routing-it').inputValue(),String(procurement.id));
  await adminPage.unroute('**/api/v1/admin/routing/it');
  results.push({check:'Lost assignment and rule responses: one real PATCH, persisted state refreshed, warning instead of false success; explicit null unassignment',result:'PASS'});
  await adminPage.goto(`${origin}/#/admin/users`);await adminPage.locator('#users-role-filter').selectOption('manager');
  const itRow=adminPage.locator('#users-list li').filter({hasText:'QA IT manager'});await itRow.waitFor();
  await itRow.locator('button').first().click();await adminPage.locator('#confirm-reset-password').click();
  await adminPage.locator('#reset-password-result').waitFor({state:'visible'});
  const resetTemporary=await adminPage.locator('#reset-temporary-password').textContent();
  assert.equal((await itPage.request.get(`${origin}/api/v1/auth/me`)).status(),401);
  await adminPage.locator('#close-reset-password').click();assert.equal(await adminPage.locator('#reset-temporary-password').textContent(),'');
  await loginTab(itPage,it.phone,resetTemporary,true);
  it.password=randomBytes(24).toString('base64url');
  await itPage.locator('#current-password').fill(resetTemporary);await itPage.locator('#new-password').fill(it.password);await itPage.locator('#repeat-password').fill(it.password);
  await itPage.locator('#change-password-form button').click();await itPage.waitForURL('**/#/manager');
  results.push({check:'Manager password reset revokes old session, clears one-time secret and forces password change again',result:'PASS'});
  for(const tab of [employeePage,adminPage,itPage,procPage]) {
    for(const width of [320,390,768,1280,1920]) {
      await tab.setViewportSize({width,height:900});
      for(const mode of ['light','dark']) {
        if(await tab.locator('html').getAttribute('data-theme')!==mode) await tab.locator('#theme-toggle').click();
        for(const lang of ['ru','kk']) {
          await tab.locator(`[data-language="${lang}"]`).click();
          assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        }
      }
    }
    assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  }
  await adminPage.setViewportSize({width:390,height:900});await adminPage.screenshot({path:join(output,'admin-routing-mobile.png'),fullPage:true});
  await procPage.setViewportSize({width:390,height:900});await procPage.screenshot({path:join(output,'manager-queue-mobile.png'),fullPage:true});
  await procPage.locator(`#admin-ticket-rows a[href="#/manager/tickets/${id}"]`).click();await procPage.waitForFunction(()=>document.querySelector('#attachments-list img')?.naturalWidth>0);
  await procPage.screenshot({path:join(output,'manager-details-mobile.png'),fullPage:true});
  assert.equal(traffic.filter(item=>item.role?.includes('manager') && item.path.startsWith('/api/v1/admin/')).length,0);
  assert.deepEqual(errors,[]);
  results.push({check:'RU/KK, 320/390/768/1280/1920, theme switch, no manager requests to admin APIs, no page errors',result:'PASS'});
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
