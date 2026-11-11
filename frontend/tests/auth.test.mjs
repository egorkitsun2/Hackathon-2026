import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../js/app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ restoredUser = null, loginError = null, hash = '#/employee', required = false } = {}) {
  const elements = new Map();
  const handlers = {};
  const clock = { now: Date.now(), tick: null };
  const document = {
    body: { classList: { toggle() {} } },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, {
        name: selector.slice(1), value: '', type: 'password', dataset: {}, events: {},
        addEventListener(key, value) { this.events[key] = value; },
        setAttribute() {}, removeAttribute() {}, focus() {},
      });
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
  };
  const user = { id: 1, role: 'employee', full_name: 'Test employee' };
  const opened = [];
  const detailsOpened = [];
  const adminsOpened = [];
  const location = { hash };
  const context = vm.createContext({
    document, location,
    Date: class extends Date { static now() { return clock.now; } },
    setInterval(callback) { clock.tick = callback; return 1; }, clearInterval() { clock.tick = null; },
    history: { replaceState(a, b, hash) { location.hash = hash; } },
    window: { addEventListener(name, callback) { handlers[name] = callback; } },
    normalizePhone: value => value === '87000000001' ? '+77000000001' : null,
    login: async () => { if (loginError) throw typeof loginError === 'string' ? new Error(loginError) : loginError; return { data: { user }, meta: { passwordChangeRequired: required } }; },
    getMe: async () => { if (!restoredUser) throw new Error('UNAUTHORIZED'); return { data: { user: restoredUser }, meta: { passwordChangeRequired: required } }; },
    logout: async () => null, invalidateSessionRequests() {},
    openEmployee: profile => opened.push(profile), closeEmployee() {}, renderEmployee() {},
    openNewTicket() {}, resetNewTicket() {}, renderNewTicket() {},
    openTicketDetails: id => detailsOpened.push(id), closeTicketDetails() {}, renderTicketDetails() {},
    openAdminQueue: user => adminsOpened.push(user), closeAdminQueue() {}, renderAdminQueue() {},
    openAccounts() {}, closeAccounts() {}, renderAccounts() {},
    setLanguage() {}, t: key => key,
  });
  vm.runInContext(source, context);
  return { get: selector => document.querySelector(selector), location, opened, detailsOpened, adminsOpened, handlers, clock };
}

test('anonymous users must log in; successful login opens real employee and clears password', async () => {
  const h = harness();
  await flush();
  assert.equal(h.location.hash, '#/login');
  assert.equal(h.get('#employee-screen').hidden, true);
  h.get('#phone').value = '87000000001';
  h.get('#password').value = 'test-only';
  await h.get('#login-form').events.submit({ preventDefault() {} });
  assert.equal(h.location.hash, '#/employee');
  assert.equal(h.opened[0].role, 'employee');
  assert.equal(h.get('#password').value, '');
  await h.get('#logout').events.click();
  assert.equal(h.location.hash, '#/login');
  assert.equal(h.get('#employee-screen').hidden, true);
});

test('session restore preserves direct creation route for employees and rejects it for admins', async () => {
  const employee = harness({ restoredUser: { id: 1, role: 'employee' }, hash: '#/new-ticket' });
  await flush();
  assert.equal(employee.location.hash, '#/new-ticket');
  assert.equal(employee.get('#new-ticket-screen').hidden, false);
  assert.equal(employee.get('#employee-screen').hidden, true);
  const admin = harness({ restoredUser: { id: 3, role: 'admin' }, hash: '#/new-ticket' });
  await flush();
  assert.equal(admin.location.hash, '#/admin');
  assert.equal(admin.get('#new-ticket-screen').hidden, true);
});

test('server session restores admin role without showing employee data', async () => {
  const h = harness({ restoredUser: { id: 3, role: 'admin' } });
  await flush();
  assert.equal(h.location.hash, '#/admin');
  assert.equal(h.get('#admin-screen').hidden, false);
  assert.equal(h.opened.length, 0);
  assert.equal(h.adminsOpened[0].role, 'admin');
  h.handlers['session-ended']();
  assert.equal(h.location.hash, '#/login');
  assert.equal(h.get('#login-status').textContent, 'sessionExpired');
});

test('admin detail links survive session restore; employees cannot open admin queue', async () => {
  const admin = harness({ restoredUser: { id: 3, role: 'admin' }, hash: '#/admin/tickets/124' });
  await flush();
  assert.equal(admin.location.hash, '#/admin/tickets/124');
  assert.equal(admin.get('#ticket-detail-screen').hidden, false);
  assert.equal(admin.get('#admin-screen').hidden, true);
  assert.deepEqual(admin.detailsOpened, ['124']);
  admin.location.hash = '#/admin';
  admin.handlers.hashchange();
  assert.equal(admin.get('#admin-screen').hidden, false);
  const employee = harness({ restoredUser: { id: 1, role: 'employee' }, hash: '#/admin' });
  await flush();
  assert.equal(employee.location.hash, '#/employee');
  assert.equal(employee.adminsOpened.length, 0);
});

test('wrong credentials display neutral translated error and never open a cabinet', async () => {
  const h = harness({ loginError: 'INVALID_CREDENTIALS' });
  await flush();
  h.get('#phone').value = '87000000001';
  h.get('#password').value = 'test-only';
  await h.get('#login-form').events.submit({ preventDefault() {} });
  assert.equal(h.get('#login-status').textContent, 'invalidCredentials');
  assert.equal(h.opened.length, 0);
  assert.equal(h.get('#submit-login').disabled, false);
});

test('direct ticket link survives session restore; hash navigation switches details and list', async () => {
  const h = harness({ restoredUser: { id: 1, role: 'employee' }, hash: '#/tickets/124' });
  await flush();
  assert.equal(h.location.hash, '#/tickets/124');
  assert.equal(h.get('#ticket-detail-screen').hidden, false);
  assert.deepEqual(h.detailsOpened, ['124']);
  assert.equal(h.get('#employee-screen').hidden, true);
  h.location.hash = '#/employee';
  h.handlers.hashchange();
  assert.equal(h.get('#ticket-detail-screen').hidden, true);
  assert.equal(h.get('#employee-screen').hidden, false);
  h.location.hash = '#/tickets/124';
  h.handlers.hashchange();
  assert.equal(h.get('#ticket-detail-screen').hidden, false);
  h.handlers['session-ended']();
  assert.equal(h.location.hash, '#/login');
  assert.equal(h.get('#ticket-detail-screen').hidden, true);
});


test('mandatory change guards restored deep links, navigation and login before ticket requests', async () => {
  for (const hash of ['#/tickets/1', '#/new-ticket', '#/admin/users']) {
    const h = harness({ restoredUser: { id: 1, role: 'employee' }, required: true, hash });
    await flush();
    assert.equal(h.location.hash, '#/change-password');
    assert.equal(h.get('#change-password-screen').hidden, false);
    assert.equal(h.opened.length + h.detailsOpened.length + h.adminsOpened.length, 0);
    h.location.hash = '#/employee'; h.handlers.hashchange();
    assert.equal(h.location.hash, '#/change-password');
  }
  const h = harness({ required: true }); await flush();
  h.get('#phone').value = '87000000001'; h.get('#password').value = 'temporary';
  await h.get('#login-form').events.submit({ preventDefault() {} });
  assert.equal(h.location.hash, '#/change-password');
  assert.equal(h.opened.length, 0);
});

test('server-required change event guards an existing session; employee cannot open users', async () => {
  const h = harness({ restoredUser: { id: 1, role: 'employee' }, hash: '#/admin/users' });
  await flush();
  assert.equal(h.get('#users-screen').hidden, true);
  h.handlers['password-change-required']();
  assert.equal(h.location.hash, '#/change-password');
  h.handlers['session-ended']({ code: 'ACCOUNT_DISABLED' });
  assert.equal(h.location.hash, '#/login');
  assert.equal(h.get('#login-status').textContent, 'accountDisabled');
});


test('login countdown follows Retry-After and enables retry after expiry', async () => {
  const error = new Error('RATE_LIMITED'); error.retryAfter = 3;
  const h = harness({ loginError: error }); await flush();
  h.get('#phone').value = '87000000001'; h.get('#password').value = 'test-only';
  await h.get('#login-form').events.submit({ preventDefault() {} });
  assert.match(h.get('#login-status').textContent, /00:03/);
  assert.equal(h.get('#submit-login').disabled, true);
  h.clock.now += 2000; h.clock.tick();
  assert.match(h.get('#login-status').textContent, /00:01/);
  h.clock.now += 1000; h.clock.tick();
  assert.equal(h.get('#submit-login').disabled, false);
  assert.equal(h.get('#login-status').textContent, 'loginRetryReady');
});
