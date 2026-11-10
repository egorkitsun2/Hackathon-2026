import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../js/accounts.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const employee = { id: 4, phone: '+77000000004', full_name: '<script>name</script>', department: 'Test', position: 'Tester', is_active: true, must_change_password: true };
function harness(api = {}) {
  const elements = new Map();
  const node = () => ({ value: '', textContent: '', hidden: true, children: [], events: {},
    addEventListener(event, callback) { this.events[event] = callback; }, setAttribute() {}, focus() {},
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    reset() { for (const element of elements.values()) element.value = ''; },
  });
  const document = { createElement: node, querySelector(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); } };
  const context = vm.createContext({ document, TextEncoder, t: key => key,
    normalizePhone: phone => /^\+77\d{9}$/.test(phone) ? phone : null,
    getUsers: async () => ({ data: [employee], pagination: { page: 1, limit: 20, total: 1 } }),
    changePassword: async () => ({ data: { user: employee }, meta: { passwordChangeRequired: false } }),
    createUser: async () => ({ data: { user: employee, temporary_password: 'test-only-secret' } }),
    updateUser: async () => ({ data: { user: { ...employee, is_active: false } } }), ...api,
  });
  vm.runInContext(source, context);
  return { context, get: id => document.querySelector(`#${id}`), submit: id => document.querySelector(`#${id}`).events.submit({ preventDefault() {} }) };
}
function fillEmployee(h) { for (const key of ['phone', 'full_name', 'department', 'position']) h.get(`user-${key}`).value = employee[key]; }
function fillPassword(h) {
  h.get('current-password').value = 'temporary-secret';
  h.get('new-password').value = '  new-secret-123  ';
  h.get('repeat-password').value = '  new-secret-123  ';
}

test('password rules count Unicode, preserve whitespace, reject NUL, same password and mismatches', () => {
  const { context: c } = harness();
  assert.equal(Object.keys(c.validatePassword('old', '🔒'.repeat(12), '🔒'.repeat(12))).length, 0);
  for (const value of ['short', ' '.repeat(12), 'x'.repeat(129), '12345678901\0', 'old-password']) {
    assert.equal(c.validatePassword('old-password', value, value)['new-password'], 'newPasswordInvalid');
  }
  assert.equal(c.validatePassword('old', 'long-new-password', 'other')['repeat-password'], 'passwordMismatch');
  assert.equal(c.validatePassword('é'.repeat(513), 'long-new-password', 'long-new-password')['current-password'], 'currentPasswordInvalid');
  assert.equal(c.validateEmployee({ ...employee, full_name: ' '.repeat(3) })['user-full_name'], 'employeeFieldInvalid');
});

test('create guards double submission; secret erased on close and navigation; late response ignored', async () => {
  const d = deferred(); let calls = 0;
  const h = harness({ createUser: () => { calls++; return d.promise; } });
  h.context.openAccounts('users'); await flush(); fillEmployee(h);
  const work = h.submit('create-user-form'); await h.submit('create-user-form');
  assert.equal(calls, 1);
  d.resolve({ data: { user: employee, temporary_password: 'test-only-secret' } }); await work;
  assert.equal(h.get('temporary-password').textContent, 'test-only-secret');
  h.get('close-user-created').events.click();
  assert.equal(h.get('temporary-password').textContent, '');
  assert.equal(h.get('user-created').hidden, true);
  const late = deferred();
  h.context.createUser = () => late.promise; fillEmployee(h);
  const second = h.submit('create-user-form'); h.context.closeAccounts();
  late.resolve({ data: { user: employee, temporary_password: 'late-secret' } }); await second;
  assert.equal(h.get('temporary-password').textContent, '');
  assert.equal(h.get('users-list').children.length, 0);
});

test('uncertain creation refreshes without repeating POST; duplicate phone gets field error', async () => {
  let reads = 0, writes = 0;
  const h = harness({ getUsers: async () => { reads++; return { data: [], pagination: { page: 1, limit: 20, total: 0 } }; },
    createUser: async () => { writes++; throw new Error('NETWORK_ERROR'); } });
  h.context.openAccounts('users'); await flush(); fillEmployee(h); await h.submit('create-user-form');
  assert.equal(writes, 1); assert.equal(reads, 2);
  assert.equal(h.get('create-user-status').textContent, 'createEmployeeUncertain');
  h.context.createUser = async () => { throw new Error('PHONE_EXISTS'); };
  await h.submit('create-user-form');
  assert.equal(h.get('user-phone-error').textContent, 'phoneExists');
});

test('password success clears inputs; wrong current password stays on form; no double request', async () => {
  const d = deferred(); let calls = 0, completed = 0, sent;
  const h = harness({ changePassword: values => { calls++; sent = values; return d.promise; } });
  h.context.openAccounts('password', () => completed++); fillPassword(h);
  const work = h.submit('change-password-form'); await h.submit('change-password-form');
  assert.equal(calls, 1); assert.equal(sent.new_password, '  new-secret-123  ');
  assert.equal('repeat_password' in sent, false);
  d.reject(new Error('INVALID_CREDENTIALS')); await work;
  assert.equal(completed, 0); assert.equal(h.get('change-password-status').textContent, 'currentPasswordWrong');
  h.context.changePassword = async () => ({ data: { user: employee } });
  await h.submit('change-password-form');
  assert.equal(completed, 1); assert.equal(h.get('new-password').value, '');
});

test('toggle uses server response; uncertain PATCH reloads; stale list cannot repopulate after logout', async () => {
  const h = harness(); h.context.openAccounts('users'); await flush();
  await h.get('users-list').children[0].children.at(-1).events.click();
  assert.equal(h.get('users-list').children[0].children.at(-1).textContent, 'activateEmployee');
  h.context.updateUser = async () => { throw new Error('NETWORK_ERROR'); };
  await h.get('users-list').children[0].children.at(-1).events.click();
  assert.equal(h.get('users-action-status').textContent, 'accountUpdateUncertain');
  assert.equal(h.get('users-list').children[0].children.at(-1).textContent, 'blockEmployee');
  const d = deferred(); h.context.getUsers = () => d.promise;
  h.context.closeAccounts(); h.context.openAccounts('users'); h.context.closeAccounts();
  d.resolve({ data: [employee], pagination: { page: 1, limit: 20, total: 1 } }); await flush();
  assert.equal(h.get('users-list').children.length, 0);
});

test('employee list paginates, retries failures and preserves inputs while translating', async () => {
  const pages = [];
  const h = harness({ getUsers: async page => {
    pages.push(page);
    return { data: page === 1 ? [employee] : [], pagination: { page, limit: 20, total: 21 } };
  } });
  h.context.openAccounts('users'); await flush(); fillEmployee(h);
  h.context.t = key => `kk:${key}`; h.context.renderAccounts();
  assert.equal(h.get('user-full_name').value, employee.full_name);
  assert.equal(h.get('users-list').children[0].children.at(-1).textContent, 'kk:blockEmployee');
  h.get('users-next').events.click(); await flush();
  assert.deepEqual(pages, [1, 2]);
  assert.equal(h.get('users-status').textContent, 'kk:noEmployees');
  h.context.getUsers = async () => { throw new Error('NETWORK_ERROR'); };
  h.get('users-previous').events.click(); await flush();
  assert.equal(h.get('retry-users').hidden, false);
  h.context.getUsers = async () => ({ data: [employee], pagination: { page: 1, limit: 20, total: 1 } });
  h.get('retry-users').events.click(); await flush();
  assert.equal(h.get('users-list').children.length, 1);
});

test('new interface labels exist in both locales', async () => {
  const i18n = (await readFile(new URL('../js/i18n.js', import.meta.url), 'utf8')).replaceAll('export ', '');
  const context = vm.createContext({ document: { documentElement: {}, querySelectorAll: () => [] } });
  vm.runInContext(i18n, context);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-label)?="([^"]+)"/g)].map(match => match[1]);
  keys.push('createEmployeeUncertain', 'passwordChangeUncertain', 'accountUpdateUncertain', 'passwordPending', 'currentPasswordWrong');
  for (const locale of ['ru', 'kk']) {
    context.setLanguage(locale);
    for (const key of keys) assert.ok(context.t(key), `${locale}:${key}`);
  }
});
