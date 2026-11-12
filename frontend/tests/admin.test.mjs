import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const routingHelpers = (await readFile(new URL('../js/routing.js', import.meta.url), 'utf8')).split('let active =')[0].replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
const source = (await readFile(new URL('../js/admin.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const ticket = { id: 124, type: 'problem', title: '<b>Literal title</b>', status: 'new', created_at: '2026-11-10T09:00:00.000Z', author: { full_name: 'Author', department: 'Warehouse', position: 'Employee' } };
const statsData = { employees: { total: 3, active: 2 }, tickets: { total: 10, new: 4, in_review: 3, resolved: 2, rejected: 1 } };
const user = { id: 3, full_name: 'Administrator', role: 'admin' };
const response = (page = 1, data = [ticket], total = 21) => ({ data, pagination: { page, limit: 20, total } });

function harness(getAdminTickets = async ({ page }) => response(page)) {
  const elements = new Map();
  const element = () => ({
    value: '', textContent: '', children: [], events: {}, dataset: {},
    append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
    addEventListener(key, callback) { this.events[key] = callback; }, setAttribute() {}, removeAttribute() {},
    set innerHTML(value) { throw new Error('Unsafe HTML'); },
  });
  const get = selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  const document = { querySelector: get, createElement: element, documentElement: { lang: 'ru' } };
  const context = vm.createContext({ document, getAdminTickets, getManagers: async () => [], getManagerTickets: async () => response(), getAdminStats: async () => ({ data: statsData }), Intl, t: key => `${document.documentElement.lang}:${key}` });
  vm.runInContext(routingHelpers + source, context);
  return { context, get, document };
}

test('queue renders real author, safe title, status, and admin detail link; translations preserve filter', async () => {
  const h = harness();
  h.context.openAdminQueue(user);
  assert.equal(h.get('#admin-queue-status').textContent, 'ru:loadingAdminQueue');
  await flush();
  const row = h.get('#admin-ticket-rows').children[0];
  assert.equal(row.children[0].children[1].textContent, '<b>Literal title</b>');
  assert.equal(row.children[1].children[0].textContent, 'Author');
  assert.equal(row.children[4].children[0].href, '#/admin/tickets/124');
  h.get('#admin-status-filter').value = 'new';
  h.document.documentElement.lang = 'kk';
  h.context.renderAdminQueue();
  assert.equal(h.get('#admin-status-filter').value, 'new');
  assert.equal(h.get('#admin-ticket-rows').children[0].children[3].children[0].textContent, 'kk:new');
});

test('pagination and status changes query backend; switching status resets page', async () => {
  const calls = [];
  const h = harness(async options => { calls.push({ ...options }); return response(options.page); });
  h.context.openAdminQueue(user);
  await flush();
  h.get('#admin-next-page').events.click();
  await flush();
  assert.equal(calls.at(-1).page, 2);
  assert.equal(h.get('#admin-next-page').disabled, true);
  h.get('#admin-status-filter').value = 'resolved';
  h.get('#admin-status-filter').events.change();
  await flush();
  assert.equal(calls.at(-1).page, 1);
  assert.equal(calls.at(-1).status, 'resolved');
  h.context.closeAdminQueue();
  h.context.openAdminQueue(user);
  await flush();
  assert.equal(calls.at(-1).status, 'resolved');
  h.context.closeAdminQueue(true);
  assert.equal(h.get('#admin-status-filter').value, '');
});

test('filtered empty results, errors and retry keep stale rows hidden', async () => {
  let fail = true;
  const h = harness(async () => { if (fail) throw new Error('NETWORK_ERROR'); return response(1, [], 0); });
  h.context.openAdminQueue(user);
  await flush();
  assert.equal(h.get('#retry-admin-queue').hidden, false);
  fail = false;
  h.get('#admin-status-filter').value = 'rejected';
  await h.get('#retry-admin-queue').events.click();
  assert.equal(h.get('#admin-queue-status').textContent, 'ru:noFilteredTickets');
  assert.equal(h.get('#admin-ticket-table').hidden, true);
  assert.equal(h.get('#admin-pagination').hidden, true);
  assert.equal(h.get('#admin-ticket-rows').children.length, 0);
});

test('stale filter response cannot overwrite a newer filter or repopulate after logout', async () => {
  const pending = [];
  const h = harness(() => new Promise(resolve => pending.push(resolve)));
  h.context.openAdminQueue(user);
  h.get('#admin-status-filter').value = 'resolved';
  h.get('#admin-status-filter').events.change();
  pending[1](response(1, [], 0));
  await flush();
  pending[0](response());
  await flush();
  assert.equal(h.get('#admin-ticket-rows').children.length, 0);
  h.context.openAdminQueue(user);
  h.context.closeAdminQueue(true);
  pending[2](response());
  await flush();
  assert.equal(h.get('#admin-ticket-rows').children.length, 0);
  assert.equal(h.get('#admin-name').textContent, '');
});


test('stats render seven real counts, preserve zero and translate without refetching', async () => {
  const h = harness();
  h.context.getAdminStats = async () => ({ data: { ...statsData, employees: { total: 3, active: 0 } } });
  h.context.openAdminQueue(user); await flush();
  const cards = h.get('#admin-stats').children;
  assert.equal(cards.length, 7);
  assert.deepEqual(cards.map(card => card.children[1].textContent), ['3', '0', '10', '4', '3', '2', '1']);
  h.document.documentElement.lang = 'kk'; h.context.renderAdminQueue();
  assert.equal(h.get('#admin-stats').children[0].children[0].textContent, 'kk:statsEmployeesTotal');
});

test('stats failure is independent of queue, retry works and reopening refreshes', async () => {
  const h = harness();
  h.context.getAdminStats = async () => { throw new Error('NETWORK_ERROR'); };
  h.context.openAdminQueue(user); await flush();
  assert.equal(h.get('#retry-admin-stats').hidden, false);
  assert.equal(h.get('#admin-ticket-rows').children.length, 1);
  assert.equal(h.get('#admin-stats').children.length, 0);
  let calls = 0;
  h.context.getAdminStats = async () => { calls++; return { data: statsData }; };
  await h.get('#retry-admin-stats').events.click();
  assert.equal(h.get('#admin-stats').children.length, 7);
  h.context.closeAdminQueue(); h.context.openAdminQueue(user); await flush();
  assert.equal(calls, 2);
});

test('late stats cannot overwrite a later panel or reappear after logout', async () => {
  const h = harness(); const pending = [];
  h.context.getAdminStats = () => new Promise(resolve => pending.push(resolve));
  h.context.openAdminQueue(user); h.context.closeAdminQueue(); h.context.openAdminQueue(user);
  pending[1]({ data: statsData }); await flush();
  pending[0]({ data: { ...statsData, employees: { total: 99, active: 99 } } }); await flush();
  assert.equal(h.get('#admin-stats').children[0].children[1].textContent, '3');
  h.context.openAdminQueue(user); h.context.closeAdminQueue(true);
  pending[2]({ data: statsData }); await flush();
  assert.equal(h.get('#admin-stats').children.length, 0);
});


test('queue returns to the last existing page after a status or assignment removes its last row', async () => {
  let total = 21;
  const calls = [];
  const h = harness(async ({ page }) => {
    calls.push(page);
    return response(page, page === 2 && total === 20 ? [] : [ticket], total);
  });
  h.context.openAdminQueue(user); await flush();
  h.get('#admin-next-page').events.click(); await flush();
  assert.equal(calls.at(-1), 2);
  h.context.closeAdminQueue(); total = 20;
  h.context.openAdminQueue(user); await flush(); await flush();
  assert.deepEqual(calls.slice(-2), [2, 1]);
  assert.equal(h.get('#admin-ticket-rows').children.length, 1);
  assert.equal(h.get('#admin-page-number').textContent, 'ru:page 1');
});


test('manager reuses the queue without administrator statistics or administrator requests', async () => {
  let adminReads = 0, managerReads = 0;
  const h = harness(async () => { adminReads++; return response(); });
  h.context.openManagerQueue({id:5,role:'manager',full_name:'QA manager'},async () => { managerReads++; return response(); });
  await flush();
  assert.equal(managerReads,1);
  assert.equal(adminReads,0);
  assert.equal(h.get('#admin-stats-panel').hidden,true);
  assert.equal(h.get('#admin-title').textContent,'ru:managerTitle');
  assert.equal(h.get('#admin-ticket-rows').children[0].children[4].children[0].href,'#/manager/tickets/124');
});

test('manager default reader never falls back to administrator API', async () => {
  let adminReads=0;
  const h=harness(async()=>{adminReads++;return response();});
  h.context.openManagerQueue({id:5,role:'manager',full_name:'QA manager'});
  await flush();
  assert.equal(adminReads,0);
  assert.equal(h.get('#admin-queue-status').textContent,'');
  assert.equal(h.get('#admin-ticket-rows').children.length,1);
});
