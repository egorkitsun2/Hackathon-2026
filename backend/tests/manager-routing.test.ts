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
  const dir = await mkdtemp(join(tmpdir(), 'team-voice-manager-'));
  const db = openDatabase(':memory:');
  migrate(db);
  const hash = await hashPassword(password);
  const insert = db.prepare(`INSERT INTO users (phone, full_name, department, position, password_hash, role, is_active, created_at)
    VALUES (?, ?, 'Office', 'Worker', ?, ?, 1, ?)`);
  const ids = phones.map((phone, i) => Number(insert.run(phone, `User ${i}`, hash, ['admin', 'employee', 'manager', 'manager'][i], new Date().toISOString()).lastInsertRowid));
  const app = await createApp({ db, origin, attachmentsDir: join(dir, 'files') });
  return { db, app, dir, ids };
}
async function cleanup(f: Fixture) {
  f.db.close();
  assert.equal(dirname(resolve(f.dir)), resolve(tmpdir()));
  assert.match(basename(resolve(f.dir)), /^team-voice-manager-[a-zA-Z0-9]+$/);
  await rm(f.dir, { recursive: true, force: true });
}
function req(f: Fixture, path: string, method = 'GET', cookie?: string, body?: unknown) {
  return f.app.request(`/api/v1${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function data(res: Response, status = 200) {
  assert.equal(res.status, status, await res.clone().text());
  return (await res.json() as any).data;
}
async function error(res: Response, status: number, code: string) {
  assert.equal(res.status, status, await res.clone().text());
  assert.equal((await res.json() as any).error.code, code);
}
function cookie(res: Response) { const value = res.headers.get('set-cookie'); assert.ok(value); return value.split(';')[0]; }
async function login(f: Fixture, phone: string, secret = password, required = false) {
  const res = await req(f, '/auth/login', 'POST', undefined, { phone, password: secret });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get('X-Password-Change-Required'), String(required));
  return cookie(res);
}
function form() { const body = new FormData(); body.append('file', new Blob([new Uint8Array(png)]), 'image.png'); return body; }
function upload(f: Fixture, id: number, session: string) {
  return f.app.request(`/api/v1/tickets/${id}/attachments`, { method: 'POST', headers: { Cookie: session, Origin: origin }, body: form() });
}

test('manager account lifecycle, role isolation and session revocation', async () => {
  const f = await fixture();
  try {
    const admin = await login(f, phones[0]);
    const employee = await login(f, phones[1]);
    const profile = { phone: '+77000000005', full_name: 'New Manager', department: 'IT', position: 'Manager' };
    const created = await data(await req(f, '/admin/users', 'POST', admin, { ...profile, role: 'manager' }), 201);
    await error(await req(f, '/admin/users', 'POST', admin, { ...profile, role: null }), 400, 'VALIDATION_ERROR');
    assert.equal(created.user.role, 'manager');
    assert.equal(created.user.is_active, true);
    assert.equal(created.user.must_change_password, true);
    assert.equal(typeof created.temporary_password, 'string');
    const first = await login(f, profile.phone, created.temporary_password, true);
    await error(await req(f, '/manager/tickets', 'GET', first), 403, 'PASSWORD_CHANGE_REQUIRED');
    const newPassword = randomBytes(24).toString('base64url');
    const changed = await req(f, '/auth/change-password', 'POST', first, { current_password: created.temporary_password, new_password: newPassword });
    assert.equal(changed.status, 200, await changed.clone().text());
    const manager = cookie(changed);
    await error(await req(f, '/auth/me', 'GET', first), 401, 'UNAUTHORIZED');
    assert.equal((await req(f, '/manager/tickets', 'GET', manager)).status, 200);
    for (const path of ['/admin/users', '/admin/routing', '/admin/tickets', '/admin/stats']) await error(await req(f, path, 'GET', manager), 403, 'FORBIDDEN');
    await error(await req(f, '/manager/tickets', 'GET', employee), 403, 'FORBIDDEN');
    await error(await req(f, '/admin/users', 'POST', manager, { ...profile, phone: '+77000000006' }), 403, 'FORBIDDEN');
    await error(await req(f, '/admin/routing/it', 'PATCH', manager, { manager_id: created.user.id }), 403, 'FORBIDDEN');
    await error(await req(f, '/admin/tickets/1/assignment', 'PATCH', manager, { assigned_to: created.user.id }), 403, 'FORBIDDEN');
    await error(await req(f, `/admin/users/${f.ids[1]}/reset-password`, 'POST', manager, {}), 403, 'FORBIDDEN');
    const employees = await data(await req(f, '/admin/users', 'GET', admin));
    assert.ok(employees.every((u: any) => u.role === 'employee'));
    const managers = await data(await req(f, '/admin/users?role=manager', 'GET', admin));
    assert.ok(managers.some((u: any) => u.id === created.user.id));
    assert.ok(managers.every((u: any) => u.role === 'manager'));
    await error(await req(f, `/admin/users/${f.ids[0]}/reset-password`, 'POST', admin, {}), 403, 'FORBIDDEN');
    const reset = await data(await req(f, `/admin/users/${created.user.id}/reset-password`, 'POST', admin, {}));
    await error(await req(f, '/auth/me', 'GET', manager), 401, 'UNAUTHORIZED');
    const resetSession = await login(f, profile.phone, reset.temporary_password, true);
    await error(await req(f, '/manager/tickets', 'GET', resetSession), 403, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await req(f, `/admin/users/${created.user.id}`, 'PATCH', admin, { is_active: false })).status, 200);
    await error(await req(f, '/auth/me', 'GET', resetSession), 401, 'UNAUTHORIZED');
    await error(await req(f, '/admin/routing/it', 'PATCH', admin, { manager_id: created.user.id }), 400, 'VALIDATION_ERROR');
    await error(await req(f, '/auth/login', 'POST', undefined, { phone: profile.phone, password: reset.temporary_password }), 403, 'ACCOUNT_DISABLED');
    assert.equal((await req(f, `/admin/users/${created.user.id}`, 'PATCH', admin, { is_active: true })).status, 200);
    await error(await req(f, '/auth/me', 'GET', resetSession), 401, 'UNAUTHORIZED');
  } finally { await cleanup(f); }
});

test('category routing snapshots, assignment ACL, attachments and status transitions', async () => {
  const f = await fixture();
  try {
    const admin = await login(f, phones[0]), employee = await login(f, phones[1]);
    const manager = await login(f, phones[2]), other = await login(f, phones[3]);
    for (const session of [admin, employee, manager]) assert.deepEqual(await data(await req(f, '/categories', 'GET', session)), ['it', 'procurement', 'general']);
    await error(await req(f, '/categories'), 401, 'UNAUTHORIZED');
    const routes = await data(await req(f, '/admin/routing', 'GET', admin));
    assert.deepEqual(routes.sort((a: any, b: any) => a.category.localeCompare(b.category)), [
      { category: 'general', manager_id: null }, { category: 'it', manager_id: null }, { category: 'procurement', manager_id: null },
    ]);
    for (const id of [999999, f.ids[0], f.ids[1], 'bad']) await error(await req(f, '/admin/routing/it', 'PATCH', admin, { manager_id: id }), 400, 'VALIDATION_ERROR');
    await error(await req(f, '/admin/routing/invalid', 'PATCH', admin, { manager_id: f.ids[2] }), 400, 'VALIDATION_ERROR');
    assert.deepEqual(await data(await req(f, '/admin/routing/it', 'PATCH', admin, { manager_id: f.ids[2] })), { category: 'it', manager_id: f.ids[2] });
    await error(await req(f, '/tickets', 'POST', employee, { ...ticket, assigned_to: f.ids[3] }), 400, 'VALIDATION_ERROR');
    await error(await req(f, '/tickets', 'POST', employee, { ...ticket, category: 'invalid' }), 400, 'VALIDATION_ERROR');
    await error(await req(f, '/tickets', 'POST', employee, { ...ticket, category: null }), 400, 'VALIDATION_ERROR');
    const one = await data(await req(f, '/tickets', 'POST', employee, { ...ticket, category: 'it' }), 201);
    assert.equal(one.category, 'it'); assert.equal(one.assigned_to, f.ids[2]);
    assert.equal((await req(f, '/admin/routing/procurement', 'PATCH', admin, { manager_id: f.ids[3] })).status, 200);
    const procurement = await data(await req(f, '/tickets', 'POST', employee, { ...ticket, category: 'procurement' }), 201);
    assert.equal(procurement.category, 'procurement'); assert.equal(procurement.assigned_to, f.ids[3]);
    const general = await data(await req(f, '/tickets', 'POST', employee, ticket), 201);
    assert.equal(general.category, 'general'); assert.equal(general.assigned_to, null);
    const unassigned = await data(await req(f, '/admin/tickets?unassigned=true', 'GET', admin));
    assert.deepEqual(unassigned.map((t: any) => t.id), [general.id]);
    for (const id of [999999, f.ids[0], f.ids[1]]) await error(await req(f, `/admin/tickets/${general.id}/assignment`, 'PATCH', admin, { assigned_to: id }), 400, 'VALIDATION_ERROR');
    const ownList = await data(await req(f, '/tickets', 'GET', employee));
    assert.equal(ownList.find((t: any) => t.id === one.id).assigned_to, f.ids[2]);
    const list = await data(await req(f, '/manager/tickets?status=new&page=1&limit=1', 'GET', manager));
    assert.deepEqual(list.map((t: any) => t.id), [one.id]);
    assert.equal(Object.hasOwn(list[0], 'author'), false);
    const detail = await data(await req(f, `/tickets/${one.id}`, 'GET', manager));
    assert.equal(detail.category, 'it'); assert.equal(detail.assigned_to, f.ids[2]); assert.equal(Object.hasOwn(detail, 'author'), false);
    assert.ok((await data(await req(f, `/tickets/${one.id}`, 'GET', admin))).author);
    await error(await req(f, `/tickets/${one.id}`, 'GET', other), 404, 'NOT_FOUND');
    const attachment = await data(await upload(f, one.id, employee), 201);
    await error(await f.app.request(attachment.url, { headers: { Cookie: other } }), 404, 'NOT_FOUND');
    const downloaded = await f.app.request(attachment.url, { headers: { Cookie: manager } });
    assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
    await error(await upload(f, one.id, manager), 403, 'FORBIDDEN');
    await error(await req(f, `/manager/tickets/${one.id}`, 'PATCH', manager, { status: 'resolved', comment: 'Fixed now' }), 409, 'INVALID_TRANSITION');
    assert.equal((await req(f, `/manager/tickets/${one.id}`, 'PATCH', manager, { status: 'in_review' })).status, 200);
    await error(await req(f, `/manager/tickets/${one.id}`, 'PATCH', manager, { status: 'resolved', comment: 'x' }), 400, 'VALIDATION_ERROR');
    assert.equal((await req(f, '/admin/routing/it', 'PATCH', admin, { manager_id: f.ids[3] })).status, 200);
    assert.equal((await data(await req(f, `/tickets/${one.id}`, 'GET', admin))).assigned_to, f.ids[2]);
    const afterRuleChange = await data(await req(f, '/tickets', 'POST', employee, { ...ticket, category: 'it' }), 201);
    assert.equal(afterRuleChange.assigned_to, f.ids[3]);
    assert.equal((await data(await req(f, `/tickets/${one.id}`, 'GET', admin))).assigned_to, f.ids[2]);
    const payload = new TextEncoder().encode(JSON.stringify({ status: 'resolved', comment: 'Fixed now' }));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let reading!: () => void;
    const reached = new Promise<void>(resolve => { reading = resolve; });
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { reading(); } }, { highWaterMark: 0 });
    const pending = f.app.request(`/api/v1/manager/tickets/${one.id}`, { method: 'PATCH', headers: { Cookie: manager, Origin: origin,
      'Content-Type': 'application/json', 'Content-Length': String(payload.byteLength) }, body, duplex: 'half' } as RequestInit);
    await Promise.race([reached, Promise.resolve(pending).then(() => { throw new Error('Request ended before reading the body'); })]);
    const reassigned = await data(await req(f, `/admin/tickets/${one.id}/assignment`, 'PATCH', admin, { assigned_to: f.ids[3] }));
    controller.enqueue(payload); controller.close();
    await error(await pending, 404, 'NOT_FOUND');
    assert.equal(reassigned.id, one.id); assert.equal(reassigned.category, 'it'); assert.equal(reassigned.assigned_to, f.ids[3]); assert.ok(reassigned.updated_at);
    assert.equal((await data(await req(f, `/tickets/${one.id}`, 'GET', admin))).status, 'in_review');
    assert.deepEqual(await data(await req(f, '/manager/tickets', 'GET', manager)), []);
    await error(await req(f, `/tickets/${one.id}`, 'GET', manager), 404, 'NOT_FOUND');
    await error(await f.app.request(attachment.url, { headers: { Cookie: manager } }), 404, 'NOT_FOUND');
    await error(await req(f, `/manager/tickets/${one.id}`, 'PATCH', manager, { status: 'resolved', comment: 'Fixed now' }), 404, 'NOT_FOUND');
    assert.equal((await f.app.request(attachment.url, { headers: { Cookie: other } })).status, 200);
    assert.equal((await req(f, `/manager/tickets/${procurement.id}`, 'PATCH', other, { status: 'in_review' })).status, 200);
    await error(await req(f, `/manager/tickets/${procurement.id}`, 'PATCH', other, { status: 'rejected' }), 400, 'VALIDATION_ERROR');
    assert.equal((await req(f, `/manager/tickets/${procurement.id}`, 'PATCH', other, { status: 'rejected', comment: 'Cannot implement' })).status, 200);
    assert.equal((await req(f, `/manager/tickets/${one.id}`, 'PATCH', other, { status: 'resolved', comment: 'Fixed now' })).status, 200);
    await error(await req(f, `/manager/tickets/${one.id}`, 'PATCH', other, { status: 'rejected', comment: 'Cannot reopen' }), 409, 'INVALID_TRANSITION');
    assert.equal((await req(f, '/admin/routing/it', 'PATCH', admin, { manager_id: f.ids[3] })).status, 200);
    assert.equal((await data(await req(f, `/tickets/${one.id}`, 'GET', admin))).assigned_to, f.ids[3]);
    assert.equal((await req(f, `/admin/users/${f.ids[3]}`, 'PATCH', admin, { is_active: false })).status, 200);
    await error(await req(f, '/auth/me', 'GET', other), 401, 'UNAUTHORIZED');
    const blockedRoute = await data(await req(f, '/tickets', 'POST', employee, { ...ticket, category: 'it' }), 201);
    assert.equal(blockedRoute.assigned_to, null);
    await error(await req(f, '/admin/routing/it', 'PATCH', admin, { manager_id: f.ids[3] }), 400, 'VALIDATION_ERROR');
    await error(await req(f, `/admin/tickets/${general.id}/assignment`, 'PATCH', admin, { assigned_to: f.ids[3] }), 400, 'VALIDATION_ERROR');
    assert.equal((await data(await req(f, `/tickets/${one.id}`, 'GET', admin))).assigned_to, f.ids[3]);
    assert.equal((await data(await req(f, `/admin/tickets/${one.id}/assignment`, 'PATCH', admin, { assigned_to: null }))).assigned_to, null);
  } finally { await cleanup(f); }
});
