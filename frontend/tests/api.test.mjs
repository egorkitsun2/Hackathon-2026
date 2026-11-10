import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../js/api.js', import.meta.url), 'utf8');
const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('phone normalization agrees with backend national and international formats', () => {
  for (const value of ['+7 (700) 000-00-01', '87000000001', '7000000001']) {
    assert.equal(api.normalizePhone(value), '+77000000001');
  }
  assert.equal(api.normalizePhone('86000000001'), '+76000000001');
  for (const value of ['+87000000001', '123', 'abc7000000001', '+79000000001']) {
    assert.equal(api.normalizePhone(value), null);
  }
});

test('real login sends only normalized credentials, with same-origin cookies', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/v1/auth/login');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { phone: '+77000000001', password: 'test-only' });
    return Response.json({ data: { user: { id: 1, role: 'employee' } } });
  };
  try { assert.equal((await api.login({ phone: '87000000001', password: 'test-only' })).data.user.role, 'employee'); }
  finally { globalThis.fetch = previous; }
});

test('logout handles 204; API errors never expose raw server messages', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal(await api.logout(), null);
    globalThis.fetch = async () => Response.json({ error: { code: 'INVALID_CREDENTIALS', message: 'private diagnostics' } }, { status: 401 });
    await assert.rejects(api.login({ phone: '87000000001', password: 'test-only' }), /^Error: INVALID_CREDENTIALS$/);
    globalThis.fetch = async () => Response.json({ error: { code: 'RATE_LIMITED' } }, { status: 429 });
    await assert.rejects(api.getMe(), /RATE_LIMITED/);
    globalThis.fetch = async () => new Response('<html>Wrong server</html>');
    await assert.rejects(api.getMe(), /API_UNAVAILABLE/);
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    await assert.rejects(api.getMe(), /NETWORK_ERROR/);
  } finally { globalThis.fetch = previous; }
});

test('list uses the agreed endpoint and pagination; malformed pages are rejected', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/v1/tickets?page=2&limit=20');
    assert.equal(options.credentials, 'same-origin');
    return Response.json({ data: [], pagination: { page: 2, limit: 20, total: 0 } });
  };
  try {
    assert.deepEqual((await api.getMyTickets({ page: 2 })).data, []);
    await assert.rejects(api.getMyTickets({ page: 0 }), /VALIDATION_ERROR/);
  } finally { globalThis.fetch = previous; }
});

test('creation sends exactly the allowed fields and preserves backend validation details', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/v1/tickets');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { type: 'problem', title: 'Title', description: 'Description' });
    return Response.json({ error: { code: 'VALIDATION_ERROR', details: { title: 'TITLE_TOO_SHORT' } } }, { status: 400 });
  };
  try {
    await assert.rejects(api.createTicket({ type: 'problem', title: ' Title ', description: ' Description ', author_id: 99, status: 'resolved' }), error => error.message === 'VALIDATION_ERROR' && error.details.title === 'TITLE_TOO_SHORT');
  } finally { globalThis.fetch = previous; }
});

test('ticket details use cookie-authenticated endpoint and reject invalid IDs before a request', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, '/api/v1/tickets/124');
    assert.equal(options.credentials, 'same-origin');
    return Response.json({ data: { id: 124, events: [] } });
  };
  try {
    assert.equal((await api.getTicket('124')).data.id, 124);
    for (const id of ['0', '-1', '01', 'abc', '1/other', '999999999999999999999']) await assert.rejects(api.getTicket(id), /NOT_FOUND/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test('admin queue omits empty status and forwards only allowed filters and pages', async () => {
  const previous = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, options) => {
    urls.push(url);
    assert.equal(options.credentials, 'same-origin');
    return Response.json({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
  };
  try {
    await api.getAdminTickets();
    await api.getAdminTickets({ status: 'in_review', page: 2 });
    assert.deepEqual(urls, ['/api/v1/admin/tickets?page=1&limit=20', '/api/v1/admin/tickets?page=2&limit=20&status=in_review']);
    await assert.rejects(api.getAdminTickets({ status: 'unknown' }), /VALIDATION_ERROR/);
    await assert.rejects(api.getAdminTickets({ page: 0 }), /VALIDATION_ERROR/);
    assert.equal(urls.length, 2);
  } finally { globalThis.fetch = previous; }
});
