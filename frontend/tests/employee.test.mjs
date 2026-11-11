import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../js/employee.js', import.meta.url), 'utf8');
const dataSource = await readFile(new URL('../js/mock-data.js', import.meta.url), 'utf8');
const { demoTickets, demoUser } = await import(`data:text/javascript;base64,${Buffer.from(dataSource).toString('base64')}`);
async function fixtureTickets({ page = 1 } = {}) {
  return { data: demoTickets.slice((page - 1) * 2, page * 2), pagination: { page, limit: 2, total: demoTickets.length } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(getTickets = fixtureTickets) {
  function element() {
    return {
      children: [], events: {}, attributes: {}, dataset: {}, hidden: false,
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; },
      setAttribute(key, value) { this.attributes[key] = value; },
      removeAttribute(key) { delete this.attributes[key]; },
      addEventListener(name, handler) { this.events[name] = handler; },
    };
  }
  const elements = new Map();
  const document = {
    documentElement: { lang: 'ru' },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    createElement: element,
  };
  const context = vm.createContext({
    document, Intl, getMyTickets: getTickets,
    t: key => `${document.documentElement.lang}:${key}`,
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replaceAll('export ', ''), context);
  return { context, document, get: selector => document.querySelector(selector) };
}

test('employee view loads, translates labels, and navigates both pages', async () => {
  const { context, document, get } = harness();
  context.openEmployee(demoUser);
  assert.equal(get('#tickets-status').textContent, 'ru:loadingTickets');
  await flush();
  assert.equal(get('#ticket-list').children.length, 2);
  assert.equal(get('#previous-page').disabled, true);
  assert.equal(get('#next-page').disabled, false);
  document.documentElement.lang = 'kk';
  context.renderEmployee();
  assert.equal(get('#ticket-list').children[0].children[3].textContent, 'kk:new');
  assert.equal(get('#ticket-list').children[0].children[4].href, '#/tickets/124');
  get('#next-page').events.click();
  await flush();
  assert.equal(get('#page-number').textContent, 'kk:page 2');
  assert.equal(get('#next-page').disabled, true);
  get('#previous-page').events.click();
  await flush();
  assert.equal(get('#page-number').textContent, 'kk:page 1');
});

test('failed list can retry into an empty state without stale cards', async () => {
  let fail = true;
  const { context, get } = harness(async () => {
    if (fail) throw new Error('offline');
    return { data: [], pagination: { page: 1, limit: 2, total: 0 } };
  });
  context.openEmployee(demoUser);
  await flush();
  assert.equal(get('#tickets-status').textContent, 'ru:ticketsError');
  assert.equal(get('#retry-tickets').hidden, false);
  fail = false;
  get('#retry-tickets').events.click();
  await flush();
  assert.equal(get('#tickets-status').textContent, 'ru:noTickets');
  assert.equal(get('#retry-tickets').hidden, true);
  assert.equal(get('#ticket-pagination').hidden, true);
  assert.equal(get('#ticket-list').children.length, 0);
});

test('late responses cannot overwrite the currently opened employee view', async () => {
  const pending = [];
  const { context, get } = harness(() => new Promise(resolve => pending.push(resolve)));
  context.openEmployee(demoUser);
  context.openEmployee(demoUser);
  pending[1]({ data: [], pagination: { page: 1, limit: 2, total: 0 } });
  await flush();
  pending[0](await fixtureTickets());
  await flush();
  assert.equal(get('#tickets-status').textContent, 'ru:noTickets');
  assert.equal(get('#ticket-list').children.length, 0);
});


test('return to employee list keeps its page; account change and logout reset it', async () => {
  const h = harness(); h.context.openEmployee(demoUser); await flush();
  h.get('#next-page').events.click(); await flush();
  h.context.closeEmployee(); h.context.openEmployee(demoUser); await flush();
  assert.match(h.get('#page-number').textContent, /2$/);
  h.context.closeEmployee(true); h.context.openEmployee(demoUser); await flush();
  assert.match(h.get('#page-number').textContent, /1$/);
  h.get('#next-page').events.click(); await flush();
  h.context.closeEmployee(); h.context.openEmployee({ ...demoUser, id: 999 }); await flush();
  assert.match(h.get('#page-number').textContent, /1$/);
});
