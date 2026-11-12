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
const output = resolve(root, 'qa/runtime/reassignment-filter');
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

  for(const [phone,name,active] of [['+77000000004','QA blocked manager',0],['+77000000005','QA active manager',1]]) {
    db.prepare('INSERT INTO users(phone,full_name,department,position,password_hash,role,is_active,created_at) VALUES(?,?,?,?,?,?,?,?)').run(phone,name,'QA','Test',hash,'manager',active,new Date().toISOString());
  }
  const blocked=3,active=4;
  db.prepare("UPDATE category_routing SET manager_id=? WHERE category='it'").run(active);
  const fixtures=[['new',null],['in_review',blocked],['new',active],['resolved',null],['rejected',blocked],['in_review',null],['resolved',blocked],['new',blocked],['resolved',active]];
  for(const [index,[state,assigned]] of fixtures.entries()) {
    const now=new Date(Date.now()+index*1000).toISOString();
    db.prepare("INSERT INTO tickets(author_id,type,title,description,status,category,assigned_to,created_at,updated_at) VALUES(1,'problem',?,'Isolated reassignment filter check',?,'it',?,?,?)").run(`QA ticket ${index+1}`,state,assigned,now,now);
  }
  await login('+77000000003');
  async function settled(){await page.waitForFunction(()=>!document.querySelector('#admin-screen').hasAttribute('aria-busy'));}
  async function ids(selector='#admin-ticket-rows tr') {
    await settled();return (await page.locator(selector+' a').evaluateAll(links=>links.map(link=>Number(link.hash.split('/').pop())))).sort((a,b)=>a-b);
  }
  assert.deepEqual(await ids('#admin-ticket-rows tr[data-needs-reassignment="true"]'),[1,2,6,8]);
  assert.equal(await page.locator('.reassignment-badge').count(),4);
  await page.locator('#admin-needs-reassignment-filter').check();assert.deepEqual(await ids(),[1,2,6,8]);
  await page.locator('#admin-unassigned-filter').check();assert.deepEqual(await ids(),[1,6]);
  await page.locator('#admin-status-filter').selectOption('in_review');assert.deepEqual(await ids(),[6]);
  await page.locator('#admin-unassigned-filter').uncheck();assert.deepEqual(await ids(),[2,6]);
  await page.locator('#admin-status-filter').selectOption('resolved');assert.deepEqual(await ids(),[]);
  assert.equal(await page.locator('#admin-ticket-table').isVisible(),false);assert.ok((await page.locator('#admin-queue-status').textContent()).length>0);
  await page.locator('#admin-needs-reassignment-filter').uncheck();assert.deepEqual(await ids(),[4,7,9]);assert.equal(await page.locator('.reassignment-badge').count(),0);
  await page.locator('#admin-status-filter').selectOption('');await page.locator('#admin-needs-reassignment-filter').check();await settled();
  const filteredResponses=traffic.filter(row=>row.method==='GET' && row.path==='/api/v1/admin/tickets');assert.ok(filteredResponses.length>0);
  results.push({check:'Authoritative flags distinguish null/blocked from active/terminal; needs/status/unassigned filters intersect; empty state and reset work',result:'PASS'});
  await page.locator('#admin-ticket-rows a[href="#/admin/tickets/2"]').click();await page.locator(`#ticket-assignee option[value="${active}"]`).waitFor({state:'attached'});
  await page.locator('#ticket-assignee').selectOption(String(active));await page.locator('#ticket-assignment-form button').click();
  await page.waitForFunction(()=>document.querySelector('#ticket-assignment-status').dataset.tone==='success');
  await page.locator('#detail-back').click();assert.equal(await page.locator('#admin-needs-reassignment-filter').isChecked(),true);
  assert.deepEqual(await ids(),[1,6,8]);assert.equal(db.prepare('SELECT assigned_to FROM tickets WHERE id=2').get().assigned_to,active);
  await page.locator('a[href="#/admin/users"]').click();await page.locator('#users-role-filter').selectOption('manager');
  const blockedRow=page.locator('#users-list li').filter({hasText:'QA blocked manager'});await blockedRow.waitFor();await blockedRow.locator('button').last().click();
  await blockedRow.locator('.account-active').waitFor();await page.locator('#workspace-nav a[href="#/admin"]').click();assert.deepEqual(await ids(),[1,6]);
  results.push({check:'Manual assignment to an active manager removes marker on return; reactivation removes blocked-manager flag; null assignments remain flagged',result:'PASS'});
  const snapshot=JSON.stringify(db.prepare('SELECT id,assigned_to,status,updated_at FROM tickets ORDER BY id').all());
  const historyCount=db.prepare('SELECT count(*) n FROM ticket_events').get().n;
  await page.locator('a[href="#/admin/users"]').click();await page.locator('#users-role-filter').selectOption('manager');
  const activeRow=page.locator('#users-list li').filter({hasText:'QA active manager'});await activeRow.waitFor();await activeRow.locator('button').last().click();
  await page.locator('#block-manager-dialog').waitFor({state:'visible'});
  const filterLabel=await page.locator('#admin-needs-reassignment-filter-label span').textContent();
  assert.ok((await page.locator('#block-manager-warning').textContent()).includes(filterLabel));
  await page.locator('#confirm-block-manager').click();await activeRow.locator('.account-blocked').waitFor();
  assert.equal(JSON.stringify(db.prepare('SELECT id,assigned_to,status,updated_at FROM tickets ORDER BY id').all()),snapshot);
  assert.equal(db.prepare('SELECT count(*) n FROM ticket_events').get().n,historyCount);
  assert.equal(db.prepare("SELECT manager_id FROM category_routing WHERE category='it'").get().manager_id,active);
  await page.locator('#workspace-nav a[href="#/admin"]').click();assert.deepEqual(await ids(),[1,2,3,6]);
  assert.equal(await page.locator('#admin-ticket-rows a[href="#/admin/tickets/9"]').count(),0);
  results.push({check:'Block warning points to filter; block preserves ticket assignments/status/timestamps/history and routing rule; open tickets become flagged, closed tickets stay excluded',result:'PASS'});
  await page.locator('a[href="#/admin/routing"]').click();await page.locator('#routing-it').waitFor();
  assert.equal(await page.locator(`#routing-it option[value="${active}"]`).isDisabled(),true);
  await page.locator('#routing-it').locator('..').locator('button[type="button"]').click();
  await page.waitForFunction(()=>document.querySelector('#routing-it').value==='');
  assert.equal(db.prepare("SELECT manager_id FROM category_routing WHERE category='it'").get().manager_id,null);
  await page.locator('#workspace-nav a[href="#/admin"]').click();assert.deepEqual(await ids(),[1,2,3,6]);
  let fail=true;
  await page.route('**/api/v1/admin/tickets?*',route=>fail?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SERVICE_UNAVAILABLE'}})}):route.continue());
  await page.locator('#admin-needs-reassignment-filter').uncheck();await page.locator('#retry-admin-queue').waitFor({state:'visible'});
  assert.equal(await page.locator('#admin-ticket-rows tr').count(),0);
  fail=false;await page.locator('#retry-admin-queue').click();assert.equal((await ids()).length,9);await page.unroute('**/api/v1/admin/tickets?*');
  await page.locator('#admin-needs-reassignment-filter').check();await settled();
  for(const width of [320,390,768,1280,1920]) {
    await page.setViewportSize({width,height:900});
    for(const mode of ['light','dark']) {
      if(await page.locator('html').getAttribute('data-theme')!==mode)await page.locator('#theme-toggle').click();
      for(const lang of ['ru','kk']) {
        await page.locator(`[data-language="${lang}"]`).click();assert.equal(await page.locator('#admin-needs-reassignment-filter').isChecked(),true);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        const bounds=await page.locator('.reassignment-badge').first().boundingBox();assert.ok(bounds.width>0);
        if(width===390 || width===1280)await page.screenshot({path:join(output,`${width}-${mode}-${lang}.png`),fullPage:true});
      }
    }
  }
  const contrast=await page.locator('.reassignment-badge').first().evaluate(el=>{
    const s=getComputedStyle(el),lum=v=>v.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);
    const a=lum(s.color),b=lum(s.backgroundColor);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });assert.ok(contrast>=4.5);
  assert.deepEqual(errors,[]);
  results.push({check:'Existing users/routing/removal retained; 503 hides stale rows and retry recovers; RU/KK, light/dark and five widths without horizontal overflow; contrast >=4.5',result:'PASS'});
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
