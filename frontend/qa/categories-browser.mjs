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
const output = resolve(root, 'qa/runtime/categories');
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

  // Contract fixtures only: the new category API is not published in the local backend yet.
  const categories = [
    {code:'general',name_ru:'Administration',name_kz:'Akimshilik',is_active:true,manager_id:null},
    {code:'it',name_ru:'IT',name_kz:'IT',is_active:true,manager_id:null}
  ];
  const writes=[];
  await context.route('**/api/v1/**', async route=>{
    const req=route.request(), url=new URL(req.url()), path=url.pathname, body=req.headers()['content-type']?.includes('application/json')?req.postDataJSON():null;
    const send=(data,status=200)=>route.fulfill({status,json:{data}});
    if(path==='/api/v1/categories')return send(categories.filter(c=>c.is_active).map(({manager_id,...rest})=>rest));
    if(path==='/api/v1/admin/categories') {
      if(req.method()==='GET')return send(categories);
      writes.push({path,body});
      if(categories.some(c=>c.code===body.code))return route.fulfill({status:409,json:{error:{code:'CATEGORY_EXISTS'}}});
      const created={...body,is_active:true};categories.push(created);return send(created,201);
    }
    if(path.startsWith('/api/v1/admin/categories/')) {
      writes.push({path,body});const entry=categories.find(c=>c.code===path.split('/').at(-1));entry.is_active=body.is_active;return send(entry);
    }
    return route.fallback();
  });
  await login('+77000000003');
  await page.locator('a[href="#/admin/routing"]').click();
  await page.locator('#routing-it').waitFor();
  await page.locator('#category-code').fill('electrician');
  await page.locator('#category-name_ru').fill('Electrician RU');
  await page.locator('#category-name_kz').fill('Elektrik KZ');
  await page.locator('#category-create-form button[type="submit"]').click();
  await page.locator('#routing-electrician').waitFor();
  assert.equal(writes.length,1);assert.equal(writes[0].body.manager_id,null);
  const custom=()=>page.locator('#category-managers-list form').filter({has:page.locator('#routing-electrician')});
  await custom().locator(':scope > button').click();
  await page.locator('#archive-category-dialog').waitFor({state:'visible'});
  await page.locator('#cancel-archive-category').click();assert.equal(categories.at(-1).is_active,true);
  await custom().locator(':scope > button').click();await page.locator('#confirm-archive-category').click();
  await page.locator('#routing-electrician').waitFor({state:'detached'});assert.equal(categories.at(-1).is_active,false);
  await page.locator('#show-archived-categories').check();await page.locator('#category-managers-list form').waitFor();
  await custom().locator(':scope > button').click();
  await page.locator('#category-managers-list form').waitFor({state:'detached'});
  await page.locator('#show-archived-categories').uncheck();await page.locator('#routing-electrician').waitFor();
  results.push({check:'contract fixture: create, cancel archive, archive and restore',result:'PASS'});
  for(const size of [320,390,768,1280,1920]) {
    await page.setViewportSize({width:size,height:900});
    for(const mode of ['light','dark']) {
      if(await page.locator('html').getAttribute('data-theme')!==mode)await page.locator('#theme-toggle').click();
      for(const lang of ['ru','kk']) {
        await page.locator(`[data-language="${lang}"]`).click();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        assert.equal(await page.locator('label[for="routing-electrician"]').textContent(),lang==='ru'?'Electrician RU':'Elektrik KZ');
        if(size===390)await shot(`routing-${mode}-${lang}`);
      }
    }
  }
  await page.locator('#logout').click();await page.locator('#submit-login').waitFor({state:'visible'});
  await login('+77000000001');await page.locator('a[href="#/new-ticket"]').click();
  await page.locator('#ticket-category option[value="electrician"]').waitFor({state:'attached'});
  await page.locator('#ticket-category').selectOption('electrician');
  await page.locator('#ticket-title').fill('Draft title');await page.locator('#ticket-description').fill('Draft description preserved');
  await page.locator('[data-language="kk"]').click();assert.equal(await page.locator('#ticket-category').inputValue(),'electrician');
  assert.equal(await page.locator('#ticket-title').inputValue(),'Draft title');
  categories.at(-1).is_active=false;
  await page.locator('#workspace-nav a[href="#/employee"]').click();await page.locator('a[href="#/new-ticket"]').click();
  await page.waitForFunction(()=>!document.querySelector('#ticket-category').disabled);
  assert.equal(await page.locator('#ticket-category option[value="electrician"]').count(),0);
  const now=new Date().toISOString();
  await context.route('**/api/v1/tickets/901',route=>route.fulfill({json:{data:{id:901,type:'problem',title:'Old ticket',description:'Archived direction remains visible',status:'resolved',category:{id:'electrician',name_ru:'Electrician RU',name_kk:'Elektrik KZ'},assigned_to:null,created_at:now,updated_at:now,events:[],attachments:[]}}}));
  await page.goto(`${origin}/#/tickets/901`);await page.locator('#detail-title').filter({hasText:'Old ticket'}).waitFor();
  for(const lang of ['ru','kk']){await page.locator(`[data-language="${lang}"]`).click();assert.equal(await page.locator('#detail-category').textContent(),lang==='ru'?'Electrician RU':'Elektrik KZ');}
  await page.goto(`${origin}/#/new-ticket`);
  await page.waitForFunction(()=>!document.querySelector('#ticket-category').disabled);
  await page.locator('#ticket-type').selectOption('problem');await page.locator('#ticket-category').selectOption('it');
  await page.locator('#ticket-title').fill('Real upload regression');await page.locator('#ticket-description').fill('Actual backend attachment persistence test');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  const pdf=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  await page.locator('#ticket-files').setInputFiles([{name:'test.png',mimeType:'image/png',buffer:png},{name:'test.pdf',mimeType:'application/pdf',buffer:pdf}]);
  assert.equal(await page.locator('#ticket-previews li').count(),2);
  await page.locator('#send-ticket').click();await page.locator('#created-ticket-details').waitFor({state:'visible'});
  assert.equal(db.prepare('SELECT count(*) AS n FROM ticket_attachments').get().n,2);
  await page.locator('#created-ticket-details').click();
  async function verifyDownloads(){
    await page.waitForFunction(()=>{const img=document.querySelector('#attachments-list img');return img?.complete && img.naturalWidth>0;});
    const links=page.locator('#attachments-list a');assert.equal(await links.count(),2);
    for(let i=0;i<2;i++){
      const wait=page.waitForEvent('download');await links.nth(i).click();const download=await wait;
      const bytes=await readFile(await download.path());assert.deepEqual(bytes,download.suggestedFilename().endsWith('.png')?png:pdf);
    }
  }
  await verifyDownloads();await page.locator('#logout').click();await page.waitForURL('**/#/login');
  await login('+77000000003');await page.locator('#admin-ticket-rows a').first().click();await verifyDownloads();
  results.push({check:'actual local backend: create IT ticket with PNG+PDF, protected preview and identical downloads for employee/admin',result:'PASS'});
  assert.deepEqual(errors,[]);
  results.push({check:'RU/KK, both themes, five widths, preserved drafts, archived option excluded and ticket response names retained',result:'PASS'});
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
