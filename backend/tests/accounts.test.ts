import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { openDatabase, migrate } from '../src/db.js';
import { createApp } from '../src/index.js';
import { bootstrapAdmin } from '../src/accounts.js';

const origin = 'http://localhost:8787';
const profile = { phone: '+77001110001', full_name: 'Admin One', department: 'Office', position: 'Manager' };
const employee = { phone: '+77001110002', full_name: 'Employee One', department: 'Warehouse', position: 'Worker' };
const newPassword = 'A long new password!';
const ticket = { type: 'problem', title: 'Broken scanner', description: 'The scanner stopped working today.' };
const publicKeys = ['department', 'full_name', 'id', 'phone', 'position', 'role'].sort();
const userKeys = ['created_at', 'department', 'full_name', 'id', 'is_active', 'must_change_password', 'phone', 'position', 'role'].sort();

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'team-voice-accounts-'));
  const db = openDatabase(':memory:');
  migrate(db);
  const credentials = join(dir, 'admin.json');
  await bootstrapAdmin(db, profile, credentials);
  const secret = JSON.parse(await readFile(credentials, 'utf8')) as { user: { id: number }; password: string };
  const app = await createApp({ db, origin });
  return { dir, db, app, secret };
}
async function removeTemp(dir: string) {
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.match(basename(resolve(dir)), /^team-voice-/);
  await rm(dir, { recursive: true, force: true });
}
async function cleanup(f: Fixture) { f.db.close(); await removeTemp(f.dir); }
function request(f: Fixture, path: string, opts: { method?: string; cookie?: string; body?: unknown; origin?: string } = {}) {
  const headers = new Headers();
  if (opts.cookie) headers.set('Cookie', opts.cookie);
  if (opts.origin !== undefined) headers.set('Origin', opts.origin);
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
  return f.app.request(`/api/v1${path}`, { method: opts.method ?? 'GET', headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
}
async function expectError(res: Response, status: number, code: string) {
  assert.equal(res.status, status, await res.clone().text());
  assert.equal((await res.json() as any).error.code, code);
}
function cookie(res: Response) {
  const value = res.headers.get('set-cookie');
  assert.ok(value);
  return value.split(';')[0];
}
async function login(f: Fixture, phone: string, password: string, required: boolean) {
  const res = await request(f, '/auth/login', { method: 'POST', origin, body: { phone, password } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get('X-Password-Change-Required'), String(required));
  const body = await res.clone().json() as any;
  assert.deepEqual(Object.keys(body).sort(), ['data']);
  assert.deepEqual(Object.keys(body.data).sort(), ['user']);
  assert.deepEqual(Object.keys(body.data.user).sort(), publicKeys);
  return cookie(res);
}
async function createEmployee(f: Fixture, admin: string, data = employee) {
  const res = await request(f, '/admin/users', { method: 'POST', cookie: admin, origin, body: data });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json() as any;
  assert.deepEqual(Object.keys(body.data.user).sort(), userKeys);
  assert.equal(body.data.user.role, 'employee');
  assert.equal(body.data.user.is_active, true);
  assert.equal(body.data.user.must_change_password, true);
  assert.equal(typeof body.data.temporary_password, 'string');
  return body.data as { user: { id: number }; temporary_password: string };
}

test('bootstrap through first password change, session rotation and ticket ownership', async () => {
  const f = await fixture();
  try {
    const admin = await login(f, profile.phone, f.secret.password, false);
    const created = await createEmployee(f, admin);
    const first = await login(f, employee.phone, created.temporary_password, true);
    const second = await login(f, employee.phone, created.temporary_password, true);
    const me = await request(f, '/auth/me', { cookie: first });
    assert.equal(me.status, 200);
    assert.equal(me.headers.get('X-Password-Change-Required'), 'true');
    const meBody = await me.json() as any;
    assert.deepEqual(Object.keys(meBody), ['data']);
    assert.deepEqual(Object.keys(meBody.data), ['user']);
    assert.deepEqual(Object.keys(meBody.data.user).sort(), publicKeys);
    await expectError(await request(f, '/auth/change-password', { method: 'POST', cookie: first, origin, body: { current_password: created.temporary_password, new_password: 'short' } }), 400, 'VALIDATION_ERROR');
    await expectError(await request(f, '/tickets', { cookie: first }), 403, 'PASSWORD_CHANGE_REQUIRED');
    await expectError(await request(f, '/tickets', { method: 'POST', cookie: first, origin, body: ticket }), 403, 'PASSWORD_CHANGE_REQUIRED');
    await expectError(await request(f, '/auth/change-password', { method: 'POST', cookie: first, origin: 'http://evil.example', body: { current_password: created.temporary_password, new_password: newPassword } }), 403, 'INVALID_ORIGIN');
    await expectError(await request(f, '/auth/change-password', { method: 'POST', cookie: first, origin, body: { current_password: 'wrong password', new_password: newPassword } }), 401, 'INVALID_CREDENTIALS');
    await expectError(await request(f, '/auth/change-password', { method: 'POST', cookie: first, origin, body: { current_password: created.temporary_password, new_password: created.temporary_password } }), 400, 'VALIDATION_ERROR');
    const changed = await request(f, '/auth/change-password', { method: 'POST', cookie: first, origin, body: { current_password: created.temporary_password, new_password: newPassword } });
    assert.equal(changed.status, 200, await changed.clone().text());
    assert.equal(changed.headers.get('X-Password-Change-Required'), 'false');
    const rotated = cookie(changed);
    assert.notEqual(rotated, first);
    await expectError(await request(f, '/auth/me', { cookie: first }), 401, 'UNAUTHORIZED');
    await expectError(await request(f, '/auth/me', { cookie: second }), 401, 'UNAUTHORIZED');
    await expectError(await request(f, '/auth/login', { method: 'POST', origin, body: { phone: employee.phone, password: created.temporary_password } }), 401, 'INVALID_CREDENTIALS');
    const newSession = await login(f, employee.phone, newPassword, false);
    const createdTicket = await request(f, '/tickets', { method: 'POST', cookie: rotated, origin, body: ticket });
    assert.equal(createdTicket.status, 201, await createdTicket.clone().text());
    const ticketId = (await createdTicket.json() as any).data.id;
    const other = await createEmployee(f, admin, { ...employee, phone: '+77001110003' });
    assert.notEqual(other.temporary_password, created.temporary_password);
    for (const id of [created.user.id, other.user.id]) {
      const row = f.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as any;
      assert.match(row.password_hash, /^\$argon2id\$/);
    }
    const otherSession = await login(f, '+77001110003', other.temporary_password, true);
    const otherChange = await request(f, '/auth/change-password', { method: 'POST', cookie: otherSession, origin, body: { current_password: other.temporary_password, new_password: newPassword } });
    assert.equal(otherChange.status, 200);
    await expectError(await request(f, `/tickets/${ticketId}`, { cookie: cookie(otherChange) }), 404, 'NOT_FOUND');
    await expectError(await request(f, '/admin/users', { cookie: newSession }), 403, 'FORBIDDEN');
    await expectError(await request(f, '/admin/users', { method: 'POST', cookie: newSession, origin, body: employee }), 403, 'FORBIDDEN');
    await expectError(await request(f, `/admin/users/${other.user.id}`, { method: 'PATCH', cookie: newSession, origin, body: { is_active: false } }), 403, 'FORBIDDEN');
    await expectError(await request(f, '/admin/users'), 401, 'UNAUTHORIZED');
    await expectError(await request(f, '/admin/users', { method: 'POST', origin, body: employee }), 401, 'UNAUTHORIZED');
    await expectError(await request(f, `/admin/users/${other.user.id}`, { method: 'PATCH', origin, body: { is_active: false } }), 401, 'UNAUTHORIZED');
  } finally { await cleanup(f); }
});

test('admin management validates input, protects secrets, blocks and reactivates employees', async () => {
  const f = await fixture();
  try {
    const admin = await login(f, profile.phone, f.secret.password, false);
    for (const extra of [{ role: 'admin' }, { password: 'injected password' }, { must_change_password: false }]) {
      await expectError(await request(f, '/admin/users', { method: 'POST', cookie: admin, origin, body: { ...employee, ...extra } }), 400, 'VALIDATION_ERROR');
    }
    await expectError(await request(f, '/admin/users', { method: 'POST', cookie: admin, origin: 'http://evil.example', body: employee }), 403, 'INVALID_ORIGIN');
    const one = await createEmployee(f, admin);
    await expectError(await request(f, '/admin/users', { method: 'POST', cookie: admin, origin, body: employee }), 409, 'PHONE_EXISTS');
    const two = await createEmployee(f, admin, { ...employee, phone: '+77001110004' });
    const list = await request(f, '/admin/users?limit=1', { cookie: admin });
    assert.equal(list.status, 200);
    const listBody = await list.json() as any;
    assert.equal(listBody.pagination.total, 2);
    assert.equal(listBody.data.length, 1);
    assert.equal(listBody.data[0].id, two.user.id);
    assert.deepEqual(Object.keys(listBody.data[0]).sort(), userKeys);
    assert.doesNotMatch(JSON.stringify(listBody), /temporary_password|password_hash|token_hash/);
    await expectError(await request(f, `/admin/users/${f.secret.user.id}`, { method: 'PATCH', cookie: admin, origin, body: { is_active: false } }), 404, 'NOT_FOUND');
    await expectError(await request(f, `/admin/users/${one.user.id}`, { method: 'PATCH', cookie: admin, origin, body: { is_active: false, role: 'admin' } }), 400, 'VALIDATION_ERROR');
    const session = await login(f, employee.phone, one.temporary_password, true);
    const blocked = await request(f, `/admin/users/${one.user.id}`, { method: 'PATCH', cookie: admin, origin, body: { is_active: false } });
    assert.equal(blocked.status, 200, await blocked.clone().text());
    assert.equal((await blocked.json() as any).data.user.is_active, false);
    await expectError(await request(f, '/auth/me', { cookie: session }), 401, 'UNAUTHORIZED');
    await expectError(await request(f, '/auth/login', { method: 'POST', origin, body: { phone: employee.phone, password: one.temporary_password } }), 403, 'ACCOUNT_DISABLED');
    const unblocked = await request(f, `/admin/users/${one.user.id}`, { method: 'PATCH', cookie: admin, origin, body: { is_active: true } });
    assert.equal(unblocked.status, 200);
    await expectError(await request(f, '/auth/me', { cookie: session }), 401, 'UNAUTHORIZED');
    await login(f, employee.phone, one.temporary_password, true);
  } finally { await cleanup(f); }
});

test('bootstrap refuses existing administrator and existing credential files', async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, 'existing.json');
    await writeFile(path, 'do not overwrite');
    await assert.rejects(bootstrapAdmin(f.db, { ...profile, phone: '+77001110009' }, path));
    assert.equal(await readFile(path, 'utf8'), 'do not overwrite');
    f.db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(f.secret.user.id);
    await assert.rejects(bootstrapAdmin(f.db, { ...profile, phone: '+77001110010' }, join(f.dir, 'second.json')));
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin'").get() as any).n, 1);
  } finally { await cleanup(f); }
});

test('migration preserves v0.2 users, tickets, events and sessions', async () => {
  const db = openDatabase(':memory:');
  try {
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY)');
    for (const name of ['0001_initial.sql', '0002_login_attempts.sql']) {
      db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
    }
    db.exec(`INSERT INTO users (id,phone,full_name,department,position,password_hash,role,is_active,created_at)
      VALUES (1,'+77001111111','Existing','Office','Worker','old-hash','employee',1,'2026-01-01');
      INSERT INTO tickets (id,author_id,type,title,description,status,created_at,updated_at)
      VALUES (1,1,'problem','Old ticket','Existing description','new','2026-01-01','2026-01-01');
      INSERT INTO ticket_events (id,ticket_id,actor_id,old_status,new_status,created_at)
      VALUES (1,1,1,NULL,'new','2026-01-01');
      INSERT INTO sessions (token_hash,user_id,created_at,expires_at)
      VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,'2026-01-01','2027-01-01');
      INSERT INTO login_attempts (bucket,window_start,attempts) VALUES ('bucket',123,2)`);
    const snapshot = (table: string) => db.prepare(`SELECT * FROM ${table}`).all();
    const before = Object.fromEntries(['tickets', 'ticket_events', 'sessions', 'login_attempts'].map(table => [table, snapshot(table)]));
    migrate(db);
    migrate(db);
    for (const [table, rows] of Object.entries(before)) assert.deepEqual(snapshot(table), rows);
    const user = db.prepare('SELECT phone,password_hash,role,is_active,must_change_password FROM users WHERE id = 1').get() as any;
    assert.deepEqual({ ...user }, { phone: '+77001111111', password_hash: 'old-hash', role: 'employee', is_active: 1, must_change_password: 0 });
  } finally { db.close(); }
});

test('concurrent bootstrap creates exactly one administrator', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'team-voice-bootstrap-'));
  const db = openDatabase(':memory:');
  migrate(db);
  try {
    const results = await Promise.allSettled([
      bootstrapAdmin(db, profile, join(dir, 'first.json')),
      bootstrapAdmin(db, { ...profile, phone: '+77001110009' }, join(dir, 'second.json')),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin'").get() as any).n, 1);
  } finally { db.close(); await removeTemp(dir); }
});


test('existing credentials file refuses bootstrap in an empty database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'team-voice-existing-'));
  const db = openDatabase(':memory:');
  migrate(db);
  try {
    const path = join(dir, 'admin.json');
    await writeFile(path, 'preserve this file');
    await assert.rejects(bootstrapAdmin(db, profile, path));
    assert.equal(await readFile(path, 'utf8'), 'preserve this file');
    assert.equal((db.prepare('SELECT count(*) AS n FROM users').get() as any).n, 0);
  } finally { db.close(); await removeTemp(dir); }
});

test('password change rolls back when the replacement session cannot be stored', async () => {
  const f = await fixture();
  try {
    const admin = await login(f, profile.phone, f.secret.password, false);
    const created = await createEmployee(f, admin);
    const session = await login(f, employee.phone, created.temporary_password, true);
    f.db.exec("CREATE TRIGGER fail_replacement BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    const result = await request(f, '/auth/change-password', { method: 'POST', cookie: session, origin, body: { current_password: created.temporary_password, new_password: newPassword } });
    assert.equal(result.status, 500);
    f.db.exec('DROP TRIGGER fail_replacement');
    const row = f.db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(created.user.id) as any;
    assert.equal(row.must_change_password, 1);
    const me = await request(f, '/auth/me', { cookie: session });
    assert.equal(me.status, 200);
    assert.equal(me.headers.get('X-Password-Change-Required'), 'true');
    await login(f, employee.phone, created.temporary_password, true);
    await expectError(await request(f, '/auth/login', { method: 'POST', origin, body: { phone: employee.phone, password: newPassword } }), 401, 'INVALID_CREDENTIALS');
  } finally { await cleanup(f); }
});

test('blocking during password verification prevents session replacement', async () => {
  const f = await fixture();
  try {
    const admin = await login(f, profile.phone, f.secret.password, false);
    const created = await createEmployee(f, admin);
    const session = await login(f, employee.phone, created.temporary_password, true);
    const bucket = createHash('sha256').update(`phone:password-change:${created.user.id}`).digest('hex');
    let notifyAttempt!: () => void;
    const attemptStarted = new Promise<void>(resolve => { notifyAttempt = resolve; });
    f.db.function('password_attempt_started', () => { notifyAttempt(); return 0; });
    f.db.exec(`CREATE TRIGGER observe_password_attempt AFTER INSERT ON login_attempts
      WHEN NEW.bucket = '${bucket}' BEGIN SELECT password_attempt_started(); END`);
    const changing = Promise.resolve(request(f, '/auth/change-password', { method: 'POST', cookie: session, origin, body: { current_password: created.temporary_password, new_password: newPassword } }));
    // The trigger resolves before Argon2 starts. Block in microtasks before the native completion callback.
    await Promise.race([attemptStarted, changing.then(() => { throw new Error('Password operation ended before its attempt was observed'); })]);
    const blocked = await request(f, `/admin/users/${created.user.id}`, { method: 'PATCH', cookie: admin, origin, body: { is_active: false } });
    assert.equal(blocked.status, 200);
    const result = await changing;
    assert.ok([401, 403].includes(result.status), await result.clone().text());
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?').get(created.user.id) as any).n, 0);
  } finally { await cleanup(f); }
});



test('blocking a session while a ticket body is pending prevents its write', async () => {
  const f = await fixture();
  try {
    const admin = await login(f, profile.phone, f.secret.password, false);
    const created = await createEmployee(f, admin);
    const temporarySession = await login(f, employee.phone, created.temporary_password, true);
    const changed = await request(f, '/auth/change-password', { method: 'POST', cookie: temporarySession, origin,
      body: { current_password: created.temporary_password, new_password: newPassword } });
    assert.equal(changed.status, 200);
    const payload = new TextEncoder().encode(JSON.stringify(ticket));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let notifyReading!: () => void;
    const readingBody = new Promise<void>(resolve => { notifyReading = resolve; });
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { notifyReading(); } }, { highWaterMark: 0 });
    const pending = f.app.request('/api/v1/tickets', { method: 'POST', headers: { Cookie: cookie(changed), Origin: origin,
      'Content-Type': 'application/json', 'Content-Length': String(payload.byteLength) }, body: stream, duplex: 'half' } as RequestInit);
    await Promise.race([readingBody, Promise.resolve(pending).then(() => { throw new Error('Ticket request ended before reading the body'); })]);
    assert.equal((await request(f, `/admin/users/${created.user.id}`, { method: 'PATCH', cookie: admin, origin, body: { is_active: false } })).status, 200);
    controller.enqueue(payload);
    controller.close();
    await expectError(await pending, 401, 'UNAUTHORIZED');
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM tickets').get() as any).n, 0);
  } finally { await cleanup(f); }
});
