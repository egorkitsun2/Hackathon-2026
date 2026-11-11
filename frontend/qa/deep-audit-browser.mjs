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
const output = resolve(root, 'qa/runtime/full-audit', https ? 'https' : '.');
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
    const key = join(storage, 'key.pem'), cert = join(storage, 'cert.pem');
    const generated = spawnSync('C:/Program Files/Git/usr/bin/openssl.exe', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'], { windowsHide:true, stdio:'ignore' });
    assert.equal(generated.status,0,'Temporary local TLS certificate generation');
    tls = { createServer:createHttpsServer, serverOptions:{key:await readFile(key),cert:await readFile(cert)} };
  }
  server = serve({ ...tls, hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const origin = `${https ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
  app = await createApp({ db, origin, production:https, attachmentsDir: storage, frontendDir: root });
  app.get('*', serveStatic({ root }));
  browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors:https, acceptDownloads: true, viewport: { width, height: 1000 } });
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

  const findings = [];
  const adminContext = await browser.newContext({ ignoreHTTPSErrors:https, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await adminContext.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const adminPage = await adminContext.newPage();
  adminPage.on('pageerror', error => errors.push(error.message));
  async function loginOn(tab, phone) {
    await tab.goto(`${origin}/#/login`);
    await tab.waitForFunction(() => !document.querySelector('#submit-login').disabled);
    await tab.locator('#phone').fill(phone); await tab.locator('#password').fill(secret);
    await tab.locator('#submit-login').click();
    await tab.waitForURL(phone.endsWith('3') ? '**/#/admin' : '**/#/employee');
  }
  await login('+77000000001');
  await loginOn(adminPage, '+77000000003');
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width=640; canvas.height=360;
    const ctx=canvas.getContext('2d'); ctx.fillStyle='#405cf5'; ctx.fillRect(0,0,640,360);
    ctx.fillStyle='#ffd65a'; ctx.fillRect(40,40,220,280); ctx.fillStyle='#ffffff';
    ctx.font='bold 30px sans-serif'; ctx.fillText('QA IMAGE',300,180);
    return { png:canvas.toDataURL('image/png').split(',')[1], jpeg:canvas.toDataURL('image/jpeg').split(',')[1] };
  });
  const png=Buffer.from(imageData.png,'base64'), jpeg=Buffer.from(imageData.jpeg,'base64');
  const webp=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==','base64');
  const pdf=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  const fileData = { 'colored.png':png, 'colored.jpg':jpeg, 'tiny.webp':webp, 'document.pdf':pdf };
  for (const [name,bytes] of Object.entries(fileData)) await writeFile(join(storage,name),bytes);
  async function previews(tab,count,label) {
    await tab.waitForFunction(n => {
      const images=[...document.querySelectorAll('#attachments-list .attachment-image-preview')];
      return images.length===n && images.every(img=>img.complete && img.naturalWidth>0 && img.getBoundingClientRect().width>0 && img.getBoundingClientRect().height>0);
    },count,{timeout:6000});
    assert.equal(await tab.locator('#attachments-empty').isVisible(),false);
    results.push({check:label,result:'PASS',images:count});
  }
  let firstId;
  for (const [label,names,count] of [ ['png-only',['colored.png'],1], ['png-pdf',['colored.png','document.pdf'],1], ['all-images',['colored.png','colored.jpg','tiny.webp'],3] ]) {
    await page.goto(`${origin}/#/new-ticket`);
    await page.locator('#ticket-type').selectOption('problem');
    await page.locator('#ticket-title').fill(`Audit ${label}`);
    await page.locator('#ticket-description').fill('Synthetic colored image and attachment audit.');
    await page.locator('#ticket-files').setInputFiles(names.map(name=>join(storage,name)));
    const postsBefore=traffic.filter(row=>row.method==='POST' && row.path.endsWith('/attachments')).length;
    await page.waitForFunction(n => [...document.querySelectorAll('#ticket-previews img')].filter(img=>img.naturalWidth>0).length===n,count);
    assert.equal(traffic.filter(row=>row.method==='POST' && row.path.endsWith('/attachments')).length,postsBefore);
    await page.locator('#send-ticket').click(); await page.locator('#created-ticket-details').waitFor({state:'visible'});
    await page.locator('#created-ticket-details').click();
    await previews(page,count,`${label}: employee after submit`);
    const id=Number(page.url().split('/').pop()); firstId ??= id;
    for (const mode of ['light','dark']) {
      if(await page.locator('html').getAttribute('data-theme')!==mode) await page.locator('#theme-toggle').click();
      for(const lang of ['kk','ru']) {
        await page.locator(`[data-language="${lang}"]`).click();
        await previews(page,count,`${label}: employee ${mode}/${lang}`);
      }
    }
    for(const w of [320,390,768,1280,1920]) {
      await page.setViewportSize({width:w,height:900});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} overflow ${w}`);
    }
    await page.reload(); await previews(page,count,`${label}: employee reload`);
    await page.locator('#detail-back').click(); await page.locator(`#ticket-list a[href="#/tickets/${id}"]`).click();
    await previews(page,count,`${label}: employee via list`);
    await page.screenshot({path:join(output,`deep-${label}-employee.png`),fullPage:true});
    await adminPage.goto(`${origin}/#/admin/tickets/${id}`);
    await previews(adminPage,count,`${label}: administrator`);
    await adminPage.reload(); await previews(adminPage,count,`${label}: administrator reload`);
    for(const tab of [page,adminPage]) {
      for(const name of names) {
        if(label==='all-images') {
          const href=await tab.locator('#attachments-list li').filter({hasText:name}).locator('a').getAttribute('href');
          const response=await tab.request.get(origin+href);
          assert.equal(response.status(),200); assert.deepEqual(await response.body(),fileData[name]);
        } else {
          const [download]=await Promise.all([tab.waitForEvent('download'),tab.locator('#attachments-list li').filter({hasText:name}).locator('a').click()]);
          assert.equal(download.suggestedFilename(),name);
          assert.deepEqual(await readFile(await download.path()),fileData[name]);
        }
      }
    }
    if(label==='png-pdf') {
      await adminPage.setViewportSize({width:390,height:900});
      await adminPage.screenshot({path:join(output,'deep-png-pdf-admin-mobile.png'),fullPage:true});
    }
  }
  // Restore a known PNG-only ticket and test failures without changing stored files.
  const pattern=`**/api/v1/tickets/${firstId}/attachments/*`;
  let failRead=true;
  await page.route(pattern,route=>failRead ? route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SERVICE_UNAVAILABLE'}})}) : route.continue());
  await page.goto(`${origin}/#/tickets/${firstId}`);
  await page.locator('#attachments-list button').waitFor();
  assert.equal(await page.locator('#attachments-list a').isVisible(),true);
  failRead=false; await page.locator('#attachments-list button').click();
  await previews(page,1,'503 preview failure retains download; retry recovers');
  await page.unroute(pattern);
  let release,seen;
  const ready=new Promise(resolve=>{seen=resolve;});
  await page.route(pattern,async route=>{seen();await new Promise(resolve=>{release=resolve;});await route.continue().catch(()=>{});});
  await page.reload(); await ready;
  await page.clock.install(); await page.clock.fastForward(120000);
  const pending=await page.locator('#attachments-list').innerText();
  if(!(await page.locator('#attachments-list button').count())) findings.push({id:'PREVIEW-TIMEOUT',severity:'medium',issue:'A stalled image GET remains loading for 120 seconds with no retry control.',evidence:pending});
  await page.screenshot({path:join(output,'deep-stalled-preview.png'),fullPage:true});
  release(); await previews(page,1,'delayed preview recovers when server eventually responds');
  await page.unroute(pattern);
  await page.clock.resume();
  // Admin filtered last page shrinks when its sole ticket is taken into review.
  const now=new Date().toISOString();
  const current=db.prepare("SELECT count(*) n FROM tickets WHERE status='new'").get().n;
  for(let n=current;n<21;n++) db.prepare("INSERT INTO tickets(author_id,type,title,description,status,created_at,updated_at) VALUES(1,'problem',?,'Pagination audit description','new',?,?)").run(`Pagination ${n}`,now,now);
  await adminPage.goto(`${origin}/#/admin`); await adminPage.locator('#admin-ticket-rows a').first().waitFor();
  await adminPage.locator('#admin-status-filter').selectOption('new');
  await adminPage.locator('#admin-next-page').click();
  await adminPage.waitForFunction(()=>document.querySelector('#admin-page-number').textContent.includes('2'));
  await adminPage.locator('#admin-ticket-rows a').first().click();
  await adminPage.locator('#take-ticket').click(); await adminPage.locator('#ticket-decision-form').waitFor({state:'visible'});
  await adminPage.locator('#detail-back').click();
  await adminPage.waitForFunction(()=>!document.querySelector('#admin-screen').hasAttribute('aria-busy'));
  const rows=await adminPage.locator('#admin-ticket-rows tr').count();
  if(rows===0 && !(await adminPage.locator('#admin-pagination').isVisible())) findings.push({id:'ADMIN-PAGE-CLAMP',severity:'medium',issue:'After processing the only ticket on page 2 of new filter, queue is empty and pagination disappears although 20 matching tickets remain.',remaining:db.prepare("SELECT count(*) n FROM tickets WHERE status='new'").get().n});
  await adminPage.screenshot({path:join(output,'deep-admin-empty-last-page.png'),fullPage:true});

  await page.goto(`${origin}/#/new-ticket`);
  await page.locator('#ticket-type').selectOption('problem');
  await page.locator('#ticket-title').fill('Valid retained files');
  await page.locator('#ticket-description').fill('All three selected files remain valid after rejecting a fourth.');
  await page.locator('#ticket-files').setInputFiles(['colored.png','colored.jpg','tiny.webp'].map(name=>join(storage,name)));
  await page.locator('#ticket-files').setInputFiles(join(storage,'document.pdf'));
  assert.equal(await page.locator('#ticket-previews li').count(),3);
  const ticketCount=db.prepare('SELECT count(*) n FROM tickets').get().n;
  await page.locator('#send-ticket').click();
  assert.equal(db.prepare('SELECT count(*) n FROM tickets').get().n,ticketCount);
  assert.equal(await page.locator('#ticket-files-error').isVisible(),true);
  findings.push({id:'REJECTED-FILE-BLOCKS-VALID-SELECTION',severity:'low',issue:'Rejecting a fourth file leaves three valid files selected, but stale selection error also blocks sending those three until a file is removed or selection cleared.'});
  await page.screenshot({path:join(output,'deep-valid-files-blocked.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  results.push({result:'COMPLETE',findings,scope:'Three attachment combinations, both roles, original downloads, reload/navigation, RU/KK, light/dark, five widths, 503 recovery, stalled read, filtered admin page shrink'});
  await adminContext.close();
} catch (error) {
  results.push({ step: 'failure', error: error.stack });
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, `deep-audit-results.json`), JSON.stringify({ results, traffic, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  db.close();
  assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
  assert.ok(basename(storage).startsWith('team-voice-browser-'));
  await rm(storage, { recursive: true, force: true });
}
