import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { createApp } from '../../backend/src/index.ts';
import { openDatabase, migrate } from '../../backend/src/db.ts';
import { hashPassword } from '../../backend/src/security.ts';

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'qa/runtime/full-audit');
const storage = await mkdtemp(join(tmpdir(), 'team-voice-persistence-'));
const origin = 'http://localhost:18979';
const checks = [];
let db;
try {
  await mkdir(output, { recursive: true });
  const localesSource = await readFile(join(root, 'js/i18n.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(localesSource.split("let language = 'ru';")[0] + '; globalThis.locales = messages;', context);
  const { ru, kk } = context.locales;
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(kk).sort());
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of html.matchAll(/\bfor="([^"]+)"/g)) assert.ok(ids.includes(id), id);
  for (const [, key] of html.matchAll(/data-i18n(?:-label)?="([^"]+)"/g)) assert.ok(ru[key] && kk[key], key);
  for (const file of await readdir(join(root, 'js'))) {
    if (!file.endsWith('.js')) continue;
    const source = await readFile(join(root, 'js', file), 'utf8');
    for (const [, key] of source.matchAll(/\bt\('([^']+)'\)/g)) assert.ok(ru[key] && kk[key], `${file}: ${key}`);
    for (const [, path] of source.matchAll(/from '(\.\/[^'?]+)(?:\?[^']+)?'/g)) await readFile(resolve(root, 'js', path));
  }
  checks.push('RU/KK keys and literal references, HTML unique IDs and labels, JS import paths: PASS');

  const database = join(storage, 'test.sqlite');
  db = openDatabase(database); migrate(db);
  const oldPassword = randomBytes(24).toString('base64url');
  const newPassword = randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO users(phone,full_name,department,position,password_hash,role,is_active,created_at) VALUES (?,?,?,?,?,?,1,?)')
    .run('+77000000001', 'QA persistence', 'QA', 'Test', await hashPassword(oldPassword), 'employee', new Date().toISOString());
  const options = () => ({ db, origin, attachmentsDir: join(storage, 'attachments'), frontendDir: root });
  let app = await createApp(options());
  let cookie = '';
  async function request(path, method = 'GET', body) {
    const response = await app.request(origin + '/api/v1' + path, {
      method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
    });
    const session = response.headers.get('set-cookie');
    if (session) cookie = session.split(';')[0];
    return response;
  }
  assert.equal((await request('/auth/login', 'POST', { phone: '+77000000001', password: oldPassword })).status, 200);
  assert.equal((await request('/auth/change-password', 'POST', { current_password: oldPassword, new_password: newPassword })).status, 200);
  const created = await request('/tickets', 'POST', { type: 'problem', title: 'Persistence audit', description: 'Private temporary database restart check.' });
  assert.equal(created.status, 201);
  const ticketId = (await created.json()).data.id;
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aRsAAAAASUVORK5CYII=', 'base64');
  const form = new FormData(); form.append('file', new Blob([bytes], { type: 'image/png' }), 'restart.png');
  const upload = await request(`/tickets/${ticketId}/attachments`, 'POST', form);
  assert.equal(upload.status, 201);
  const fileId = (await upload.json()).data.id;
  db.close(); db = openDatabase(database); migrate(db); app = await createApp(options());
  assert.equal((await request('/auth/me')).status, 200);
  const detail = await request(`/tickets/${ticketId}`);
  assert.equal((await detail.json()).data.attachments.length, 1);
  const download = await request(`/tickets/${ticketId}/attachments/${fileId}`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal((await request('/auth/logout', 'POST')).status, 204);
  cookie = '';
  assert.equal((await request('/auth/login', 'POST', { phone: '+77000000001', password: oldPassword })).status, 401);
  assert.equal((await request('/auth/login', 'POST', { phone: '+77000000001', password: newPassword })).status, 200);
  checks.push('Disk database close/reopen: new password, session, ticket, metadata and original attachment bytes survive: PASS');
  await writeFile(join(output, 'supplementary-results.json'), JSON.stringify({ checks }, null, 2));
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  db?.close();
  assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
  assert.ok(basename(storage).startsWith('team-voice-persistence-'));
  await rm(storage, { recursive: true, force: true });
}
