import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../js/ticket.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const ticket = {
  id: 124, type: 'problem', title: '<script>literal title</script>', description: 'Line one\nLine two', status: 'resolved',
  created_at: '2026-11-10T08:00:00.000Z', events: [
    { id: 3, actor: { full_name: '<b>Admin</b>' }, old_status: 'in_review', new_status: 'resolved', comment: 'Final decision', created_at: '2026-11-10T10:00:00.000Z' },
    { id: 1, actor: { full_name: 'Employee' }, old_status: null, new_status: 'new', comment: null, created_at: '2026-11-10T08:00:00.000Z' },
    { id: 2, actor: { full_name: 'Admin' }, old_status: 'new', new_status: 'in_review', comment: 'Intermediate note', created_at: '2026-11-10T09:00:00.000Z' },
  ],
};

function harness(getTicket = async () => ({ data: ticket })) {
  const elements = new Map();
  const element = () => ({
    textContent: '', children: [], events: {}, attributes: {},
    replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); },
    addEventListener(name, callback) { this.events[name] = callback; },
    setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; },
    set innerHTML(value) { throw new Error('Unsafe HTML insertion'); },
  });
  const get = selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  const document = { querySelector: get, createElement: element, documentElement: { lang: 'ru' } };
  const context = vm.createContext({ document, getTicket, Intl, t: key => `${document.documentElement.lang}:${key}` });
  vm.runInContext(source, context);
  return { context, get, document };
}

test('details render safe text, chronological history, and final matching event comment', async () => {
  const h = harness();
  h.context.openTicketDetails('124');
  assert.equal(h.get('#ticket-detail-status').textContent, 'ru:loadingTicket');
  await flush();
  assert.equal(h.get('#ticket-detail-content').hidden, false);
  assert.equal(h.get('#detail-title').textContent, ticket.title);
  assert.equal(h.get('#detail-description').textContent, 'Line one\nLine two');
  assert.equal(h.get('#detail-response').textContent, 'Final decision');
  const history = h.get('#detail-history').children;
  assert.equal(history.length, 3);
  assert.equal(history[0].children[2].textContent, 'ru:ticketCreatedEvent: ru:new');
  assert.equal(history[2].children[1].textContent, '<b>Admin</b>');
  h.document.documentElement.lang = 'kk';
  h.context.renderTicketDetails();
  assert.equal(h.get('#detail-status').textContent, 'kk:resolved');
  assert.equal(h.get('#detail-response').textContent, 'Final decision');
});

test('unfinished ticket shows waiting; terminal ticket without final comment does not use an intermediate note', async () => {
  for (const data of [{ ...ticket, status: 'in_review' }, { ...ticket, events: ticket.events.filter(event => event.id !== 3) }]) {
    const h = harness(async () => ({ data }));
    h.context.openTicketDetails('124');
    await flush();
    assert.equal(h.get('#detail-response').textContent, 'ru:awaitingDecision');
  }
});

test('not-found hides content; network failures can retry successfully', async () => {
  let code = 'NOT_FOUND';
  const h = harness(async () => { if (code) throw new Error(code); return { data: ticket }; });
  h.context.openTicketDetails('124');
  await flush();
  assert.equal(h.get('#ticket-detail-status').textContent, 'ru:ticketNotFound');
  assert.equal(h.get('#retry-ticket-detail').hidden, true);
  assert.equal(h.get('#ticket-detail-content').hidden, true);
  code = 'NETWORK_ERROR';
  h.context.openTicketDetails('124');
  await flush();
  assert.equal(h.get('#retry-ticket-detail').hidden, false);
  code = '';
  await h.get('#retry-ticket-detail').events.click();
  assert.equal(h.get('#ticket-detail-content').hidden, false);
});

test('leaving clears private content and ignores late responses', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.context.openTicketDetails('124');
  h.context.closeTicketDetails();
  resolve({ data: ticket });
  await flush();
  assert.equal(h.get('#ticket-detail-content').hidden, true);
  assert.equal(h.get('#detail-title').textContent, '');
  assert.equal(h.get('#detail-history').children.length, 0);
});

test('admin sees only server-provided author and returns to queue; employee does not see author', async () => {
  const author = { full_name: 'Author', department: 'Warehouse', position: 'Employee' };
  const h = harness(async () => ({ data: { ...ticket, author } }));
  h.context.openTicketDetails('124', true);
  await flush();
  assert.equal(h.get('#detail-author-block').hidden, false);
  assert.equal(h.get('#detail-author-name').textContent, 'Author');
  assert.equal(h.get('#detail-back').href, '#/admin');
  h.context.closeTicketDetails();
  assert.equal(h.get('#detail-author-name').textContent, '');
  h.context.openTicketDetails('124');
  await flush();
  assert.equal(h.get('#detail-author-block').hidden, true);
  assert.equal(h.get('#detail-back').href, '#/employee');
});
