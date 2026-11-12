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
    addEventListener(key, fn) { this.events[key] = fn; }, setAttribute(key, value) { this.attributes[key] = value; }, focus() {}, reset() {}, close() { this.events.close?.(); }, showModal() {},
    set innerHTML(value) { throw new Error('Unsafe HTML'); },
  }; }
  const get = selector => { if (!elements.has(selector)) elements.set(selector, node()); return elements.get(selector); };
  const context = vm.createContext({ document: { querySelector: get, createElement: node, documentElement: { lang: 'ru' } }, t: key => `ru:${key}`,
    window: { addEventListener(name, fn) { events[name] = fn; } },
    getRouting: async () => ({ data: [{ category: 'it', manager_id: 7 }, { category: 'procurement', manager_id: 8 }] }),
    getManagers: async () => users, updateRouting: async (category, manager_id) => ({ data: { category, manager_id } }), ...api,
  });
  context.getAdminCategories = async () => { const result = await context.getRouting(); return { data: result.data.map(item => ({ ...item, code: item.category, name_ru: item.category, name_kz: item.category, is_active: true })) }; };
  vm.runInContext(source, context);
  return { context, get, events, forms: () => get('#category-managers-list').children };
}

test('ticket category names come from response objects in either locale, including archived custom categories', () => {
  const h = harness();
  const category = { id: 'electrician', name_ru: 'Электрик', name_kk: 'Электр маманы' };
  assert.equal(h.context.categoryLabel(category), 'Электрик');
  h.context.document.documentElement.lang = 'kk';
  assert.equal(h.context.categoryLabel(category), 'Электр маманы');
  assert.equal(h.context.categoryLabel('unknown_code'), 'unknown_code');
});

test('create custom category, archive with confirmation and restore preserve the manager assignment', async () => {
  const h = harness();
  const categories = [{ code: 'general', name_ru: 'Admin', name_kz: 'Admin', is_active: true, manager_id: null }];
  h.context.getAdminCategories = async () => ({ data: categories.map(item => ({ ...item })) });
  const calls = [];
  h.context.createCategory = async values => { calls.push({ ...values }); categories.push({ ...values, is_active: true }); };
  h.context.setCategoryActive = async (code, is_active) => { calls.push({ code, is_active }); categories.find(item => item.code === code).is_active = is_active; };
  h.context.openRouting(); await flush();
  for (const [field, value] of Object.entries({ code: 'electrician', name_ru: 'Electrician', name_kz: 'Elektrik' })) h.get(`#category-${field}`).value = value;
  h.get('#category-create-manager').value = '7';
  await h.get('#category-create-form').events.submit({ preventDefault() {} });
  assert.equal(calls[0].manager_id, 7); assert.equal(h.forms().length, 2);
  assert.equal(h.forms()[0].children[6].disabled, true);
  h.forms()[1].children[6].events.click(); assert.equal(calls.length, 1);
  await h.get('#confirm-archive-category').events.click();
  assert.equal(categories[1].is_active, false); assert.equal(categories[1].manager_id, 7); assert.equal(h.forms().length, 1);
  h.get('#show-archived-categories').events.change({ target: { checked: true } });
  assert.equal(h.forms().length, 1); assert.equal(h.forms()[0].children[2].disabled, true);
  await h.forms()[0].children[6].events.click();
  assert.equal(categories[1].is_active, true); assert.equal(categories[1].manager_id, 7); assert.equal(h.forms().length, 0);
});

test('duplicate code retains the create draft and a lost create response is never replayed', async () => {
  const h = harness(); h.context.openRouting(); await flush();
  h.get('#category-code').value = 'electrician'; h.get('#category-name_ru').value = 'Electrician'; h.get('#category-name_kz').value = 'Elektrik';
  let calls = 0;
  h.context.createCategory = async () => { calls++; throw new Error('CATEGORY_EXISTS'); };
  await h.get('#category-create-form').events.submit({ preventDefault() {} });
  assert.equal(h.get('#category-create-error').textContent, 'ru:categoryExists'); assert.equal(h.get('#category-code').value, 'electrician');
  h.context.createCategory = async () => { calls++; throw new Error('NETWORK_ERROR'); };
  await h.get('#category-create-form').events.submit({ preventDefault() {} });
  assert.equal(calls, 2); assert.equal(h.get('#category-managers-status').textContent, 'ru:categoryMutationUncertain');
});

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


test('explicit removal sends one null PATCH and disables removal only after the acknowledged clear', async () => {
  let calls=0,finish;
  const h=harness({updateRouting:(category,id)=>{calls++;assert.equal(category,'it');assert.equal(id,null);return new Promise(resolve=>{finish=resolve;});}});
  h.context.openRouting();await flush();
  const remove=h.forms()[0].children[4].children[1];assert.equal(remove.disabled,false);
  const work=remove.events.click();await remove.events.click();assert.equal(calls,1);
  assert.notEqual(h.get('#category-managers-status').textContent,'ru:assignmentSaved');
  finish({data:{category:'it',manager_id:null}});await work;
  assert.equal(h.forms()[0].children[2].value,'');assert.equal(h.forms()[0].children[4].children[1].disabled,true);
  assert.equal(h.forms()[0].children[5].textContent,'ru:unassignedRoutingHint');
});

test('blocked assignment is displayed and removable without offering a blocked manager as a new target', async () => {
  const h=harness();h.context.openRouting();await flush();
  const form=h.forms()[1];assert.equal(form.children[1].dataset.blocked,'true');
  assert.equal(form.children[2].children.find(option=>option.value==='8').disabled,true);
  assert.equal(form.children[5].textContent,'ru:blockedRoutingHint');assert.equal(form.children[4].children[1].disabled,false);
});
