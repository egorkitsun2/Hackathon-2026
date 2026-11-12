import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../js/routing.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const users = [{ id: 7, role: 'manager', full_name: '<IT manager>', is_active: true }, { id: 8, role: 'manager', full_name: 'Blocked manager', is_active: false }, { id: 9, role: 'employee', full_name: 'Employee', is_active: true }];
function harness(api = {}) {
  const elements = new Map(), events = {};
  function node() { return { value: '', dataset: {}, attributes: {}, children: [], events: {},
    append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
    addEventListener(key, fn) { this.events[key] = fn; }, setAttribute(key, value) { this.attributes[key] = value; }, focus() {},
    set innerHTML(value) { throw new Error('Unsafe HTML'); },
  }; }
  const get = selector => { if (!elements.has(selector)) elements.set(selector, node()); return elements.get(selector); };
  const context = vm.createContext({ document: { querySelector: get, createElement: node }, t: key => `ru:${key}`,
    window: { addEventListener(name, fn) { events[name] = fn; } },
    getRouting: async () => ({ data: [{ category: 'it', manager_id: 7 }, { category: 'procurement', manager_id: 8 }] }),
    getManagers: async () => users, updateRouting: async (category, manager_id) => ({ data: { category, manager_id } }), ...api,
  });
  vm.runInContext(source, context);
  return { context, get, events, forms: () => get('#category-managers-list').children };
}

test('manager options allow active managers and explicit null, retain a disabled current assignment', () => {
  const h = harness(), select = h.get('#select');
  h.context.fillManagerSelect(select, users, '8');
  assert.deepEqual(select.children.map(option => option.value), ['', '7', '8']);
  assert.equal(select.children[2].disabled, true);
  assert.match(select.children[1].textContent, /<IT manager>/);
  assert.equal(h.context.selectedManager('', users), null);
  assert.equal(h.context.selectedManager('7', users), 7);
  for (const value of ['8', '9', '999', '-1', 'admin']) assert.throws(() => h.context.selectedManager(value, users), /INVALID_MANAGER/);
});

test('rules confirm only after response and never repeat a lost PATCH', async () => {
  let resolve, calls = 0, reads = 0;
  const h = harness({ getRouting: async () => { reads++; return { data: [{ category: 'it', manager_id: 7 }] }; }, updateRouting: () => { calls++; return new Promise(done => { resolve = done; }); } });
  h.context.openRouting(); await flush();
  const work = h.forms()[0].events.submit({ preventDefault() {} });
  assert.equal(h.get('#category-managers-status').textContent, '');
  await h.forms()[0].events.submit({ preventDefault() {} }); assert.equal(calls, 1);
  resolve({ data: { category: 'it', manager_id: 7 } }); await work;
  assert.equal(h.get('#category-managers-status').textContent, 'ru:assignmentSaved');
  h.context.updateRouting = async () => { calls++; throw new Error('NETWORK_ERROR'); };
  await h.forms()[0].events.submit({ preventDefault() {} });
  assert.equal(calls, 2); assert.equal(reads, 2);
  assert.equal(h.get('#category-managers-status').textContent, 'ru:assignmentUncertain');
});

test('invalid selection never writes; language render preserves draft; late responses cannot reopen private data', async () => {
  let writes = 0, resolve;
  const h = harness({ updateRouting: async () => { writes++; } });
  h.context.openRouting(); await flush();
  let form = h.forms()[0], select = form.children[2];
  select.value = '999'; await form.events.submit({ preventDefault() {} }); assert.equal(writes, 0);
  form = h.forms()[0]; select = form.children[2]; select.value = ''; select.events.change();
  h.context.renderRouting(); assert.equal(h.forms()[0].children[2].value, '');
  h.context.getRouting = () => new Promise(done => { resolve = done; });
  h.context.closeRouting(); h.context.openRouting(); h.context.closeRouting();
  resolve({ data: [{ category: 'it', manager_id: 7 }] }); await flush();
  assert.equal(h.forms().length, 0); assert.equal(h.get('#category-managers-panel').hidden, true);
});
