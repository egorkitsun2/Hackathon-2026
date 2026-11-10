// Real backend integration in isolated memory; does not touch the local demo database.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApp } from '../../backend/src/index.ts';
import { openDatabase, migrate } from '../../backend/src/db.ts';
import { hashPassword } from '../../backend/src/security.ts';

const db = openDatabase(':memory:');
const previousFetch = globalThis.fetch;
try {
  migrate(db);
  const password = randomBytes(24).toString('base64url');
  db.prepare(`INSERT INTO users (phone, full_name, department, position, password_hash, role, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run('+77000000001', 'Integration employee', 'Test', 'Employee', await hashPassword(password), 'employee', new Date().toISOString());
  for (const [phone, role] of [['+77000000002', 'employee'], ['+77000000003', 'admin']]) {
    db.prepare(`INSERT INTO users (phone, full_name, department, position, password_hash, role, is_active, created_at)
      SELECT ?, ?, department, position, password_hash, ?, is_active, created_at FROM users WHERE id = 1`).run(phone, `Integration ${role}`, role);
  }
  const origin = 'http://localhost:8787';
  const app = await createApp({ db, origin });
  let cookie = '';
  globalThis.fetch = async (url, options = {}) => {
    const headers = { ...options.headers, ...(cookie ? { Cookie: cookie } : {}), ...(['POST', 'PATCH'].includes(options.method) ? { Origin: origin } : {}) };
    const response = await app.request(new URL(url, origin), { ...options, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  const source = await readFile(new URL('../js/api.js', import.meta.url), 'utf8');
  const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  await api.login({ phone: '+77000000001', password });
  assert.equal((await api.getMyTickets()).pagination.total, 0);
  const created = await api.createTicket({ type: 'suggestion', title: ' Integration ticket ', description: ' Created only in an isolated test database. ' });
  assert.ok(Number.isSafeInteger(created.data.id));
  assert.equal(created.data.status, 'new');
  assert.equal(created.data.title, 'Integration ticket');
  const list = await api.getMyTickets();
  assert.equal(list.pagination.total, 1);
  assert.equal(list.data[0].id, created.data.id);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM ticket_events').get().n), 1);
  const initialDetail = (await api.getTicket(created.data.id)).data;
  assert.equal(initialDetail.description, 'Created only in an isolated test database.');
  assert.equal(initialDetail.events.length, 1);
  assert.equal(initialDetail.events[0].old_status, null);
  assert.equal(initialDetail.events[0].new_status, 'new');
  assert.equal('author' in initialDetail, false);
  await assert.rejects(api.createTicket({ type: 'problem', title: 'bad', description: 'too short' }), error => error.message === 'VALIDATION_ERROR' && Boolean(error.details.title));
  assert.equal((await api.getMyTickets()).pagination.total, 1);
  await assert.rejects(api.getAdminTickets(), /FORBIDDEN/);
  await api.login({ phone: '+77000000003', password });
  const queue = await api.getAdminTickets();
  assert.equal(queue.pagination.total, 1);
  assert.equal(queue.data[0].author.full_name, 'Integration employee');
  assert.equal(queue.data[0].author.department, 'Test');
  assert.equal((await api.getAdminTickets({ status: 'new' })).pagination.total, 1);
  assert.equal((await api.getAdminTickets({ status: 'resolved' })).pagination.total, 0);
  assert.equal((await api.getAdminTickets({ page: 2, limit: 1 })).data.length, 0);
  const adminDetail = (await api.getTicket(created.data.id)).data;
  assert.equal(adminDetail.author.full_name, 'Integration employee');
  await api.request(`/admin/tickets/${created.data.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'in_review' }) });
  await api.request(`/admin/tickets/${created.data.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved', comment: 'Integration decision completed.' }) });
  assert.equal((await api.getAdminTickets({ status: 'new' })).pagination.total, 0);
  assert.equal((await api.getAdminTickets({ status: 'resolved' })).pagination.total, 1);
  await api.login({ phone: '+77000000001', password });
  const resolved = (await api.getTicket(created.data.id)).data;
  assert.equal(resolved.status, 'resolved');
  assert.deepEqual(resolved.events.map(event => event.new_status), ['new', 'in_review', 'resolved']);
  assert.equal(resolved.events.at(-1).comment, 'Integration decision completed.');
  await api.login({ phone: '+77000000002', password });
  await assert.rejects(api.getTicket(created.data.id), /NOT_FOUND/);
  await api.logout();
  await assert.rejects(api.getTicket(created.data.id), /UNAUTHORIZED/);
  await assert.rejects(api.createTicket({ type: 'problem', title: 'Valid title', description: 'Valid description' }), /UNAUTHORIZED/);
  console.log('PASS: real cookie login, create/list/details, full decision history, final comment, foreign ticket denied, validation and logout; isolated database.');
} finally {
  globalThis.fetch = previousFetch;
  db.close();
}
