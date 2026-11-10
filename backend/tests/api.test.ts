import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { openDatabase, migrate } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { createApp } from '../src/index.js';

const origin = 'http://localhost:8787';
const password = randomBytes(24).toString('base64url');
const phones = ['+77000000001', '+77000000002', '+77000000003', '+77000000004'];
const validTicket = { type: 'problem', title: 'Broken scanner', description: 'The scanner stopped working today.' };

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(production = false, trustedOrigin = origin) {
  const db = openDatabase(':memory:');
  migrate(db);
  const passwordHash = await hashPassword(password);
  const insert = db.prepare(`INSERT INTO users (phone, full_name, department, position, password_hash, role, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < phones.length; i++) {
    insert.run(phones[i], `User ${i + 1}`, 'Warehouse', 'Worker', passwordHash,
      i === 2 ? 'admin' : 'employee', i === 3 ? 0 : 1, new Date().toISOString());
  }
  const app = await createApp({ db, origin: trustedOrigin, production });
  return { db, app, trustedOrigin };
}
function request(f: Fixture, path: string, opts: { method?: string; cookie?: string; body?: unknown; origin?: string; contentType?: string } = {}) {
  const headers = new Headers();
  if (opts.cookie) headers.set('Cookie', opts.cookie);
  if (opts.origin !== undefined) headers.set('Origin', opts.origin);
  if (opts.contentType !== undefined) headers.set('Content-Type', opts.contentType);
  else if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
  return f.app.request(`/api/v1${path}`, {
    method: opts.method ?? 'GET', headers,
    ...(opts.body !== undefined ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) } : {}),
  });
}
async function login(f: Fixture, index: number, phone = phones[index]) {
  const res = await request(f, '/auth/login', { method: 'POST', origin: f.trustedOrigin, body: { phone, password } });
  assert.equal(res.status, 200, await res.clone().text());
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  if (setCookie.startsWith('__Host-')) assert.match(setCookie, /Secure/i);
  return setCookie.split(';')[0];
}
async function errorCode(res: Response, status: number, code: string) {
  assert.equal(res.status, status, await res.clone().text());
  const body = await res.json() as any;
  assert.equal(body.error.code, code);
}
async function createTicket(f: Fixture, cookie: string) {
  const res = await request(f, '/tickets', { method: 'POST', cookie, origin, body: validTicket });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json() as any).data;
}

test('sessions, origin, authentication and server-side account changes', async () => {
  const origin = 'https://team.example';
  const f = await fixture(true, origin);
  try {
    await errorCode(await request(f, '/auth/me'), 401, 'UNAUTHORIZED');
    await errorCode(await request(f, '/auth/login', { method: 'POST', body: { phone: phones[0], password } }), 403, 'INVALID_ORIGIN');
    await errorCode(await request(f, '/auth/login', { method: 'POST', origin: 'http://evil.example', body: { phone: phones[0], password } }), 403, 'INVALID_ORIGIN');
    await errorCode(await request(f, '/auth/login', { method: 'POST', origin, body: { phone: phones[3], password } }), 403, 'ACCOUNT_DISABLED');
    const wrong = await request(f, '/auth/login', { method: 'POST', origin, body: { phone: phones[0], password: 'wrong-password' } });
    const unknown = await request(f, '/auth/login', { method: 'POST', origin, body: { phone: '+77000000999', password } });
    await errorCode(wrong, 401, 'INVALID_CREDENTIALS');
    await errorCode(unknown, 401, 'INVALID_CREDENTIALS');
    const cookie = await login(f, 0, '87000000001');
    assert.match(cookie, /^__Host-team_voice_session=/);
    const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
    const session = f.db.prepare('SELECT token_hash, created_at, expires_at FROM sessions').get() as any;
    assert.equal(session.token_hash, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(session.token_hash, token);
    assert.equal(Date.parse(session.expires_at) - Date.parse(session.created_at), 8 * 60 * 60 * 1000);
    const me = await request(f, '/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as any).data.user.phone, phones[0]);
    await errorCode(await request(f, '/tickets', { method: 'POST', cookie, origin: 'http://evil.example', body: validTicket }), 403, 'INVALID_ORIGIN');
    f.db.prepare('UPDATE users SET is_active = 0 WHERE phone = ?').run(phones[0]);
    const disabled = await request(f, '/auth/me', { cookie });
    await errorCode(disabled, 403, 'ACCOUNT_DISABLED');
    f.db.prepare('UPDATE users SET is_active = 1 WHERE phone = ?').run(phones[0]);
    const cookie2 = await login(f, 1);
    const expiredCookie = await login(f, 1);
    const expiredToken = decodeURIComponent(expiredCookie.slice(expiredCookie.indexOf('=') + 1));
    f.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run('2000-01-01T00:00:00.000Z', createHash('sha256').update(expiredToken).digest('hex'));
    await errorCode(await request(f, '/auth/me', { cookie: expiredCookie }), 401, 'UNAUTHORIZED');
    const logout = await request(f, '/auth/logout', { method: 'POST', cookie: cookie2, origin });
    assert.equal(logout.status, 204);
    assert.equal(await logout.text(), '');
    await errorCode(await request(f, '/auth/me', { cookie: cookie2 }), 401, 'UNAUTHORIZED');
  } finally { f.db.close(); }
});

test('validation, ownership, role checks, details and pagination', async () => {
  const f = await fixture();
  try {
    const employee = await login(f, 0);
    const other = await login(f, 1);
    const admin = await login(f, 2);
    await errorCode(await request(f, '/tickets', { method: 'POST', cookie: employee, origin, contentType: 'text/plain', body: '{}' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    await errorCode(await request(f, '/tickets', { method: 'POST', cookie: employee, origin, body: '{' }), 400, 'VALIDATION_ERROR');
    await errorCode(await request(f, '/tickets', { method: 'POST', cookie: employee, origin, body: { ...validTicket, title: ' x ' } }), 400, 'VALIDATION_ERROR');
    const oversized = await request(f, '/tickets', { method: 'POST', cookie: employee, origin, body: { ...validTicket, description: 'x'.repeat(33000) } });
    await errorCode(oversized, 400, 'VALIDATION_ERROR');
    await errorCode(await request(f, '/tickets', { method: 'POST', cookie: admin, origin, body: validTicket }), 403, 'FORBIDDEN');
    await errorCode(await request(f, '/admin/tickets/1', { method: 'PATCH', cookie: employee, origin, body: { status: 'in_review' } }), 403, 'FORBIDDEN');
    const before = (f.db.prepare('SELECT count(*) AS n FROM tickets').get() as any).n;
    for (const field of [{ author_id: 2 }, { role: 'admin' }]) {
      await errorCode(await request(f, '/tickets', { method: 'POST', cookie: employee, origin, body: { ...validTicket, ...field } }), 400, 'VALIDATION_ERROR');
    }
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM tickets').get() as any).n, before);
    await errorCode(await request(f, '/tickets?page=0', { cookie: employee }), 400, 'VALIDATION_ERROR');
    await errorCode(await request(f, '/admin/tickets?status=unknown', { cookie: admin }), 400, 'VALIDATION_ERROR');
    await errorCode(await request(f, '/tickets/not-an-id', { cookie: admin }), 404, 'NOT_FOUND');
    await errorCode(await request(f, '/tickets/999999', { cookie: admin }), 404, 'NOT_FOUND');
    const one = await createTicket(f, employee);
    const two = await createTicket(f, other);
    await errorCode(await request(f, `/tickets/${two.id}`, { cookie: employee }), 404, 'NOT_FOUND');
    await errorCode(await request(f, '/admin/tickets', { cookie: employee }), 403, 'FORBIDDEN');
    const own = (await (await request(f, `/tickets/${one.id}`, { cookie: employee })).json() as any).data;
    assert.equal(Object.hasOwn(own, 'author'), false);
    assert.equal(own.events.length, 1);
    assert.equal(own.events[0].old_status, null);
    assert.equal(own.events[0].new_status, 'new');
    const detail = (await (await request(f, `/tickets/${one.id}`, { cookie: admin })).json() as any).data;
    assert.deepEqual(Object.keys(detail.author).sort(), ['department', 'full_name', 'id', 'position']);
    const list = (await (await request(f, '/tickets?limit=100', { cookie: employee })).json() as any);
    assert.equal(list.pagination.limit, 50);
    assert.equal(list.pagination.total, 1);
    assert.equal(list.data[0].id, one.id);
    assert.equal(Object.hasOwn(list.data[0], 'description'), false);
    assert.equal(Object.hasOwn(list.data[0], 'author'), false);
    const adminList = (await (await request(f, '/admin/tickets?status=new', { cookie: admin })).json() as any);
    assert.equal(adminList.pagination.total, 2);
    assert.ok(adminList.data.every((item: any) => item.status === 'new'));
    assert.deepEqual(Object.keys(adminList.data[0].author).sort(), ['department', 'full_name', 'id', 'position']);
    const empty = (await (await request(f, '/admin/tickets?status=rejected', { cookie: admin })).json() as any);
    assert.deepEqual(empty.data, []);
    f.db.prepare("UPDATE users SET role = 'employee' WHERE phone = ?").run(phones[2]);
    await errorCode(await request(f, '/admin/tickets', { cookie: admin }), 403, 'FORBIDDEN');
  } finally { f.db.close(); }
});

test('atomic create and status updates, concurrent transitions and history', async () => {
  const f = await fixture();
  try {
    const employee = await login(f, 0);
    const admin = await login(f, 2);
    f.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON ticket_events BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const failedCreate = await request(f, '/tickets', { method: 'POST', cookie: employee, origin, body: validTicket });
    assert.equal(failedCreate.status, 500);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM tickets').get() as any).n, 0);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM ticket_events').get() as any).n, 0);
    f.db.exec('DROP TRIGGER fail_event');
    const ticket = await createTicket(f, employee);
    const patch = (body: unknown) => request(f, `/admin/tickets/${ticket.id}`, { method: 'PATCH', cookie: admin, origin, body });
    await errorCode(await patch({ status: 'resolved', comment: 'Fixed now' }), 409, 'INVALID_TRANSITION');
    f.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON ticket_events BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.equal((await patch({ status: 'in_review' })).status, 500);
    assert.equal((f.db.prepare('SELECT status FROM tickets WHERE id = ?').get(ticket.id) as any).status, 'new');
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM ticket_events WHERE ticket_id = ?').get(ticket.id) as any).n, 1);
    f.db.exec('DROP TRIGGER fail_event');
    const race = await Promise.all([patch({ status: 'in_review' }), patch({ status: 'in_review' })]);
    assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
    await errorCode(await patch({ status: 'resolved' }), 400, 'VALIDATION_ERROR');
    await errorCode(await patch({ status: 'resolved', comment: ' x ' }), 400, 'VALIDATION_ERROR');
    const terminal = await patch({ status: 'resolved', comment: '  Fixed now  ' });
    assert.equal(terminal.status, 200);
    assert.equal((await terminal.json() as any).data.event.comment, 'Fixed now');
    await errorCode(await patch({ status: 'rejected', comment: 'Cannot reopen' }), 409, 'INVALID_TRANSITION');
    const detail = (await (await request(f, `/tickets/${ticket.id}`, { cookie: admin })).json() as any).data;
    assert.deepEqual(detail.events.map((e: any) => [e.old_status, e.new_status]), [[null, 'new'], ['new', 'in_review'], ['in_review', 'resolved']]);
    assert.deepEqual(detail.events.map((e: any) => e.id), detail.events.map((e: any) => e.id).sort((a: number, b: number) => a - b));
    const rejected = await createTicket(f, employee);
    const rejectPatch = (body: unknown) => request(f, `/admin/tickets/${rejected.id}`, { method: 'PATCH', cookie: admin, origin, body });
    assert.equal((await rejectPatch({ status: 'in_review' })).status, 200);
    assert.equal((await rejectPatch({ status: 'rejected', comment: 'Cannot implement' })).status, 200);
    await errorCode(await rejectPatch({ status: 'in_review' }), 409, 'INVALID_TRANSITION');
  } finally { f.db.close(); }
});

test('login rate limiting includes successful attempts', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++) {
      const res = await request(f, '/auth/login', { method: 'POST', origin, body: { phone: phones[0], password } });
      assert.equal(res.status, 200);
    }
    await errorCode(await request(f, '/auth/login', { method: 'POST', origin, body: { phone: phones[0], password } }), 429, 'RATE_LIMITED');
  } finally { f.db.close(); }
});
