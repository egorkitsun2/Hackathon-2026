// Real backend integration in isolated memory; does not touch the local demo database.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { createRequire } from 'node:module';
import { createApp } from '../../backend/src/index.ts';
import { openDatabase, migrate } from '../../backend/src/db.ts';
import { hashPassword } from '../../backend/src/security.ts';

const storage = await mkdtemp(join(tmpdir(), 'team-voice-frontend-attachments-'));
const db = openDatabase(':memory:');
const previousFetch = globalThis.fetch;
let httpServer;
try {
  migrate(db);
  const password = randomBytes(24).toString('base64url');
  db.prepare(`INSERT INTO users (phone, full_name, department, position, password_hash, role, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run('+77000000001', 'Integration employee', 'Test', 'Employee', await hashPassword(password), 'employee', new Date().toISOString());
  for (const [phone, role] of [['+77000000002', 'employee'], ['+77000000003', 'admin']]) {
    db.prepare(`INSERT INTO users (phone, full_name, department, position, password_hash, role, is_active, created_at)
      SELECT ?, ?, department, position, password_hash, ?, is_active, created_at FROM users WHERE id = 1`).run(phone, `Integration ${role}`, role);
  }
  let origin = 'http://localhost:8787';
  let app;
  if (process.env.TEST_HTTP === '1') {
    const { serve } = createRequire(new URL('../../backend/package.json', import.meta.url))('@hono/node-server');
    httpServer = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
    await new Promise((resolve, reject) => { httpServer.once('listening', resolve); httpServer.once('error', reject); });
    origin = `http://127.0.0.1:${httpServer.address().port}`;
  }
  app = await createApp({ db, origin, attachmentsDir: storage });
  let cookie = '';
  globalThis.fetch = async (url, options = {}) => {
    const headers = { ...options.headers, ...(httpServer ? { Connection: 'close' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(['POST', 'PATCH'].includes(options.method) ? { Origin: origin } : {}) };
    const response = httpServer
      ? await previousFetch(new URL(url, origin), { ...options, headers })
      : await app.request(new URL(url, origin), { ...options, headers });
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
  const attachment = await api.uploadAttachment(created.data.id, new File(['%PDF-1.4\nfrontend isolated test\n%%EOF'], 'фото.pdf', { type: 'application/pdf' }));
  assert.equal(attachment.data.original_name, 'фото.pdf');
  assert.equal((await api.getTicket(created.data.id)).data.attachments.length, 1);
  const downloaded = await fetch(attachment.data.url);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /^attachment/);
  assert.match(await downloaded.text(), /^%PDF-/);

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
  assert.equal(adminDetail.attachments.length, 1);
  assert.equal(adminDetail.attachments[0].id, attachment.data.id);
  assert.equal((await fetch(attachment.data.url)).status, 200);
  console.log('PASS: employee and admin both receive attachment metadata and protected download; ' + (httpServer ? 'real HTTP multipart transport.' : 'in-process transport.'));
  assert.equal(adminDetail.author.full_name, 'Integration employee');
  await assert.rejects(api.updateTicketStatus(created.data.id, { status: 'resolved', comment: 'Forbidden direct transition' }), /INVALID_TRANSITION/);
  await api.updateTicketStatus(created.data.id, { status: 'in_review' });
  await assert.rejects(api.updateTicketStatus(created.data.id, { status: 'in_review' }), /INVALID_TRANSITION/);
  await api.updateTicketStatus(created.data.id, { status: 'resolved', comment: ' Integration decision completed. ' });
  await assert.rejects(api.updateTicketStatus(created.data.id, { status: 'rejected', comment: 'Cannot edit terminal state' }), /INVALID_TRANSITION/);
  assert.equal((await api.getAdminTickets({ status: 'new' })).pagination.total, 0);
  assert.equal((await api.getAdminTickets({ status: 'resolved' })).pagination.total, 1);
  await api.login({ phone: '+77000000001', password });
  await assert.rejects(api.uploadAttachment(created.data.id, new File(['%PDF-1.4'], 'locked.pdf', { type: 'application/pdf' })), /ATTACHMENTS_LOCKED/);
  const resolved = (await api.getTicket(created.data.id)).data;
  assert.equal(resolved.status, 'resolved');
  assert.deepEqual(resolved.events.map(event => event.new_status), ['new', 'in_review', 'resolved']);
  assert.equal(resolved.events.at(-1).comment, 'Integration decision completed.');
  await assert.rejects(api.updateTicketStatus(created.data.id, { status: 'in_review' }), /FORBIDDEN/);
  const rejectTicket = await api.createTicket({ type: 'complaint', title: 'Rejected test ticket', description: 'Only for isolated integration coverage.' });
  await api.login({ phone: '+77000000003', password });
  await api.updateTicketStatus(rejectTicket.data.id, { status: 'in_review' });
  await assert.rejects(api.request(`/admin/tickets/${rejectTicket.data.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'rejected' }) }), error => error.message === 'VALIDATION_ERROR' && Boolean(error.details.comment));
  await api.updateTicketStatus(rejectTicket.data.id, { status: 'rejected', comment: ' Integration rejection reason. ' });
  await api.login({ phone: '+77000000001', password });
  const rejected = (await api.getTicket(rejectTicket.data.id)).data;
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(rejected.events.map(event => event.new_status), ['new', 'in_review', 'rejected']);
  assert.equal(rejected.events.at(-1).comment, 'Integration rejection reason.');
  await api.login({ phone: '+77000000002', password });
  await assert.rejects(api.getTicket(created.data.id), /NOT_FOUND/);
  await api.logout();
  await assert.rejects(api.getTicket(created.data.id), /UNAUTHORIZED/);
  await assert.rejects(api.createTicket({ type: 'problem', title: 'Valid title', description: 'Valid description' }), /UNAUTHORIZED/);
  await api.login({ phone: '+77000000003', password });
  const statsBefore = (await api.getAdminStats()).data;
  const account = await api.createUser({ phone: '+77000000004', full_name: ' Account test ', department: ' QA ', position: ' Tester ' });
  assert.equal((await api.getAdminStats()).data.employees.total, statsBefore.employees.total + 1);
  assert.equal(account.data.user.must_change_password, true);
  assert.equal(account.data.user.full_name, 'Account test');
  assert.equal((await api.getUsers()).data.some(user => 'temporary_password' in user), false);
  await assert.rejects(api.createUser({ phone: '+77000000004', full_name: 'Duplicate', department: 'QA', position: 'Tester' }), /PHONE_EXISTS/);
  const first = await api.login({ phone: account.data.user.phone, password: account.data.temporary_password });
  assert.equal(first.meta.passwordChangeRequired, true);
  assert.equal((await api.getMe()).meta.passwordChangeRequired, true);
  await assert.rejects(api.getMyTickets(), /PASSWORD_CHANGE_REQUIRED/);
  await assert.rejects(api.getUsers(), /FORBIDDEN|PASSWORD_CHANGE_REQUIRED/);
  const oldCookie = cookie;
  await assert.rejects(api.changePassword({ current_password: 'wrong-test-password', new_password: 'new-test-password-123' }), /INVALID_CREDENTIALS/);
  assert.equal((await api.getMe()).meta.passwordChangeRequired, true);
  const newPassword = randomBytes(24).toString('base64url');
  assert.equal((await api.changePassword({ current_password: account.data.temporary_password, new_password: newPassword })).meta.passwordChangeRequired, false);
  const employeeCookie = cookie;
  cookie = oldCookie;
  await assert.rejects(api.getMe(), /UNAUTHORIZED/);
  cookie = employeeCookie;
  await api.createTicket({ type: 'problem', title: 'Account lifecycle test', description: 'Isolated employee can submit after password change.' });
  await assert.rejects(api.getUsers(), /FORBIDDEN/);
  await api.login({ phone: '+77000000003', password });
  const adminCookie = cookie;
  const statsAfter = (await api.getAdminStats()).data;
  assert.equal(statsAfter.tickets.total, statsBefore.tickets.total + 1);
  assert.equal(statsAfter.tickets.new, statsBefore.tickets.new + 1);
  assert.equal(statsAfter.tickets.resolved, 1);
  assert.equal(statsAfter.tickets.rejected, 1);
  assert.equal(statsAfter.tickets.in_review, 0);
  assert.equal((await api.updateUser(account.data.user.id, false)).data.user.is_active, false);
  assert.equal((await api.getAdminStats()).data.employees.active, statsAfter.employees.active - 1);
  cookie = employeeCookie;
  await assert.rejects(api.getMe(), /UNAUTHORIZED/);
  await assert.rejects(api.login({ phone: account.data.user.phone, password: newPassword }), /ACCOUNT_DISABLED/);
  cookie = adminCookie;
  assert.equal((await api.updateUser(account.data.user.id, true)).data.user.is_active, true);
  cookie = employeeCookie;
  await assert.rejects(api.getMe(), /UNAUTHORIZED/);
  assert.equal((await api.login({ phone: account.data.user.phone, password: newPassword })).meta.passwordChangeRequired, false);
  assert.equal((await api.getMyTickets()).pagination.total, 1);
  await api.logout();
  console.log('PASS: isolated account create/list/duplicate, mandatory password gate, password change and cookie rotation, block/revoke/activate/new login.');
  console.log('PASS: real cookie login, create/list/details, full decision history, final comment, foreign ticket denied, validation and logout; isolated database.');
} finally {
  globalThis.fetch = previousFetch;
  if (httpServer) {
    httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
  }
  db.close();
  assert.equal(dirname(resolve(storage)), resolve(tmpdir()));
  assert.ok(basename(storage).startsWith('team-voice-frontend-attachments-'));
  await rm(storage, { recursive: true, force: true });
}
