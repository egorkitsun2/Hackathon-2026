import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { openDatabase, migrate } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { createApp } from '../src/index.js';

const origin = 'http://localhost:8787';
const password = randomBytes(24).toString('base64url');
const phones = ['+77000000001', '+77000000002', '+77000000003', '+77000000004'];
const ticket = { type: 'problem', title: 'Broken scanner', description: 'The scanner stopped working today.' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aRsAAAAASUVORK5CYII=', 'base64');
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'team-voice-categories-'));
  const db = openDatabase(':memory:'); migrate(db);
  const hash = await hashPassword(password);
  const insert = db.prepare(`INSERT INTO users (phone, full_name, department, position, password_hash, role, is_active, created_at) VALUES (?, ?, 'Office', 'Worker', ?, ?, 1, ?)`);
  const ids = phones.map((phone, i) => Number(insert.run(phone, `User ${i}`, hash, ['admin', 'employee', 'manager', 'manager'][i], new Date().toISOString()).lastInsertRowid));
  const app = await createApp({ db, origin, attachmentsDir: join(dir, 'files') });
  return { db, app, dir, ids };
}
async function cleanup(f: Fixture) {
  f.db.close();
  assert.equal(dirname(resolve(f.dir)), resolve(tmpdir()));
  assert.match(basename(resolve(f.dir)), /^team-voice-categories-[a-zA-Z0-9]+$/);
  await rm(f.dir, { recursive: true, force: true });
}
function req(f: Fixture, path: string, method = 'GET', cookie?: string, body?: unknown, requestOrigin = origin) {
  return f.app.request(`/api/v1${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: requestOrigin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function data(res: Response, status = 200) { assert.equal(res.status, status, await res.clone().text()); return (await res.json() as any).data; }
async function error(res: Response, status: number, code: string) { assert.equal(res.status, status, await res.clone().text()); const body = await res.json() as any; assert.equal(body.error.code, code); return body.error; }
async function login(f: Fixture, phone: string) {
  const res = await req(f, '/auth/login', 'POST', undefined, { phone, password });
  assert.equal(res.status, 200, await res.clone().text());
  const value = res.headers.get('set-cookie'); assert.ok(value); return value.split(';')[0];
}
const category = { code: 'facilities', name_ru: '  Помещения  ', name_kz: '  Ғимараттар  ' };

test('category lifecycle, validation, authorization and atomic creation', async () => {
  const f = await fixture();
  try {
    const admin = await login(f, phones[0]), employee = await login(f, phones[1]), manager = await login(f, phones[2]);
    assert.deepEqual(await data(await req(f, '/categories', 'GET', employee)), ['it', 'procurement', 'general']);
    await error(await req(f, '/admin/categories'), 401, 'UNAUTHORIZED');
    for (const user of [employee, manager]) {
      await error(await req(f, '/admin/categories', 'GET', user), 403, 'FORBIDDEN');
      await error(await req(f, '/admin/categories', 'POST', user, category), 403, 'FORBIDDEN');
    }
    assert.equal((await req(f, '/admin/categories', 'POST', admin, category, 'https://evil.example')).status, 403);
    f.db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(f.ids[0]);
    await error(await req(f, '/admin/categories', 'GET', admin), 403, 'PASSWORD_CHANGE_REQUIRED');
    await error(await req(f, '/admin/categories', 'POST', admin, category), 403, 'PASSWORD_CHANGE_REQUIRED');
    f.db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(f.ids[0]);
    for (const code of ['X', 'Aaa', ' a', 'a', 'a-b', 'a'.repeat(33)]) await error(await req(f, '/admin/categories', 'POST', admin, { ...category, code }), 400, 'VALIDATION_ERROR');
    for (const name of ['', '   ', 'а'.repeat(121)]) await error(await req(f, '/admin/categories', 'POST', admin, { ...category, name_ru: name }), 400, 'VALIDATION_ERROR');
    for (const id of [0, -1, '1', f.ids[0], f.ids[1], 999999]) await error(await req(f, '/admin/categories', 'POST', admin, { ...category, manager_id: id }), 400, 'VALIDATION_ERROR');
    const created = await data(await req(f, '/admin/categories', 'POST', admin, { ...category, manager_id: f.ids[2] }), 201);
    assert.deepEqual(created, { code: 'facilities', name_ru: 'Помещения', name_kz: 'Ғимараттар', is_active: true, manager_id: f.ids[2] });
    assert.deepEqual(await data(await req(f, '/categories', 'GET', employee)), ['it', 'procurement', 'general', 'facilities']);
    assert.deepEqual((await data(await req(f, '/categories?details=true', 'GET', employee))).find((c: any) => c.code === 'facilities'), { code: 'facilities', name_ru: 'Помещения', name_kz: 'Ғимараттар', is_active: true });
    await error(await req(f, '/admin/categories', 'POST', admin, category), 409, 'CATEGORY_EXISTS');
    await error(await req(f, '/admin/categories/general', 'PATCH', admin, { is_active: false }), 409, 'CATEGORY_REQUIRED_ACTIVE');
    await error(await req(f, '/admin/categories/missing', 'PATCH', admin, { is_active: false }), 404, 'NOT_FOUND');
    await error(await req(f, '/admin/categories/facilities', 'PATCH', admin, { is_active: false, code: 'renamed' }), 400, 'VALIDATION_ERROR');
    for (let i = 0; i < 2; i++) assert.equal((await data(await req(f, '/admin/categories/facilities', 'PATCH', admin, { is_active: false }))).is_active, false);
    assert.equal((await data(await req(f, '/admin/categories', 'GET', admin))).find((c: any) => c.code === 'facilities').manager_id, f.ids[2]);
    assert.ok(!(await data(await req(f, '/categories', 'GET', employee))).includes('facilities'));
    assert.ok(!(await data(await req(f, '/categories?details=true', 'GET', employee))).some((c: any) => c.code === 'facilities'));
    await error(await req(f, '/admin/categories', 'POST', admin, category), 409, 'CATEGORY_EXISTS');
    const archived = await data(await req(f, '/categories?details=true&include_archived=true', 'GET', employee));
    assert.equal(archived.find((c: any) => c.code === 'facilities').is_active, false);
    assert.equal(Object.hasOwn(archived.find((c: any) => c.code === 'facilities'), 'manager_id'), false);
    await error(await req(f, '/categories?include_archived=yes', 'GET', employee), 400, 'VALIDATION_ERROR');
    for (let i = 0; i < 2; i++) assert.equal((await data(await req(f, '/admin/categories/facilities', 'PATCH', admin, { is_active: true }))).is_active, true);
    f.db.exec("CREATE TRIGGER fail_category_routing BEFORE INSERT ON category_routing BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.ok((await req(f, '/admin/categories', 'POST', admin, { ...category, code: 'rollback' })).status >= 500);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM categories WHERE code = 'rollback'").get() as any).n, 0);
  } finally { await cleanup(f); }
});

test('archived category preserves tickets, files, assignment and routing; creation rechecks activity', async () => {
  const f = await fixture();
  try {
    const admin = await login(f, phones[0]), employee = await login(f, phones[1]), manager = await login(f, phones[2]), other = await login(f, phones[3]);
    await data(await req(f, '/admin/categories', 'POST', admin, category), 201);
    const unassigned = await data(await req(f, '/tickets', 'POST', employee, { ...ticket, category: 'facilities' }), 201);
    assert.equal(unassigned.assigned_to, null);
    assert.equal((await data(await req(f, '/admin/tickets?needs_reassignment=true', 'GET', admin))).find((t: any) => t.id === unassigned.id).needs_reassignment, true);
    assert.deepEqual(await data(await req(f, '/admin/routing/facilities', 'PATCH', admin, { manager_id: f.ids[2] })), { category: 'facilities', manager_id: f.ids[2] });
    const created = await data(await req(f, '/tickets', 'POST', employee, { ...ticket, category: 'facilities' }), 201);
    assert.equal(created.assigned_to, f.ids[2]);
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(png)]), 'image.png');
    const attachment = await data(await f.app.request(`/api/v1/tickets/${created.id}/attachments`, { method: 'POST', headers: { Cookie: employee, Origin: origin }, body: form }), 201);
    const before = f.db.prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(created.id);
    const payload = new TextEncoder().encode(JSON.stringify({ ...ticket, category: 'facilities' }));
    let controller!: ReadableStreamDefaultController<Uint8Array>; let reading!: () => void;
    const reached = new Promise<void>(resolve => { reading = resolve; });
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { reading(); } }, { highWaterMark: 0 });
    const pending = f.app.request('/api/v1/tickets', { method: 'POST', headers: { Cookie: employee, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': String(payload.byteLength) }, body, duplex: 'half' } as RequestInit);
    await Promise.race([reached, Promise.resolve(pending).then(() => { throw new Error('Request ended before reading the body'); })]);
    await data(await req(f, '/admin/categories/facilities', 'PATCH', admin, { is_active: false }));
    controller.enqueue(payload); controller.close();
    await error(await pending, 409, 'CATEGORY_ARCHIVED');
    await error(await req(f, '/tickets', 'POST', employee, { ...ticket, category: 'facilities' }), 409, 'CATEGORY_ARCHIVED');
    const invalid = await error(await req(f, '/tickets', 'POST', employee, { ...ticket, category: 'missing' }), 400, 'VALIDATION_ERROR');
    assert.equal(invalid.details.category, 'INVALID_CATEGORY');
    await error(await req(f, '/admin/routing/facilities', 'PATCH', admin, { manager_id: f.ids[3] }), 409, 'CATEGORY_ARCHIVED');
    const invalidRoute = await error(await req(f, '/admin/routing/missing', 'PATCH', admin, { manager_id: f.ids[3] }), 400, 'VALIDATION_ERROR');
    assert.equal(invalidRoute.details.category, 'INVALID_CATEGORY');
    assert.ok((await data(await req(f, '/admin/routing', 'GET', admin))).some((r: any) => r.category === 'facilities' && r.manager_id === f.ids[2]));
    assert.equal((await data(await req(f, `/tickets/${created.id}`, 'GET', employee))).assigned_to, f.ids[2]);
    assert.equal((await data(await req(f, `/tickets/${created.id}`, 'GET', manager))).assigned_to, f.ids[2]);
    await error(await req(f, `/tickets/${created.id}`, 'GET', other), 404, 'NOT_FOUND');
    for (const user of [employee, manager]) { const download = await f.app.request(attachment.url, { headers: { Cookie: user } }); assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), png); }
    assert.deepEqual(f.db.prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(created.id), before);
    assert.equal((await req(f, `/manager/tickets/${created.id}`, 'PATCH', manager, { status: 'in_review' })).status, 200);
    assert.equal((await data(await req(f, `/admin/tickets/${created.id}/assignment`, 'PATCH', admin, { assigned_to: f.ids[3] }))).assigned_to, f.ids[3]);
    await error(await req(f, `/tickets/${created.id}`, 'GET', manager), 404, 'NOT_FOUND');
    assert.equal((await f.app.request(attachment.url, { headers: { Cookie: other } })).status, 200);
    assert.equal((await data(await req(f, '/tickets', 'POST', employee, ticket), 201)).category, 'general');
  } finally { await cleanup(f); }
});
