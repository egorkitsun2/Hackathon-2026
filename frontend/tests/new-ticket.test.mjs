import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../js/new-ticket.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');

function harness(createTicket = async () => ({ data: { id: 42 } })) {
  const elements = new Map();
  let focused;
  let language = 'ru';
  function get(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', dataset: {}, events: {}, attributes: {},
      addEventListener(key, callback) { this.events[key] = callback; },
      setAttribute(key, value) { this.attributes[key] = value; },
      removeAttribute(key) { delete this.attributes[key]; },
      focus() { focused = selector; },
      reset() { for (const name of ['type', 'title', 'description']) get(`#ticket-${name}`).value = ''; },
    });
    return elements.get(selector);
  }
  const context = vm.createContext({ document: { querySelector: get }, createTicket, t: key => `${language}:${key}` });
  vm.runInContext(source, context);
  function fill(values = {}) {
    for (const [key, value] of Object.entries({ type: 'problem', title: ' Test title ', description: ' A valid description ', ...values })) get(`#ticket-${key}`).value = value;
  }
  return { context, get, fill, focused: () => focused, setLanguage: value => { language = value; }, submit: () => get('#new-ticket-form').events.submit({ preventDefault() {} }) };
}

test('validation trims edges, checks all lengths, and counts Unicode characters like backend', () => {
  const { context } = harness();
  const validate = values => context.validateTicket({ type: 'problem', title: 'valid', description: 'description', ...values });
  assert.equal(Object.keys(validate({})).length, 0);
  assert.equal(validate({ type: '' }).type, 'typeRequired');
  for (const length of [0, 4, 121]) assert.equal(validate({ title: 'x'.repeat(length) }).title, 'titleLengthError');
  for (const length of [5, 120]) assert.equal(validate({ title: 'x'.repeat(length) }).title, undefined);
  for (const length of [9, 4001]) assert.equal(validate({ description: 'x'.repeat(length) }).description, 'descriptionLengthError');
  for (const length of [10, 4000]) assert.equal(validate({ description: 'x'.repeat(length) }).description, undefined);
  assert.equal(validate({ title: '     ' }).title, 'titleLengthError');
  assert.equal(validate({ title: '\u{1F600}'.repeat(120) }).title, undefined);
});

test('invalid form focuses the first invalid field and sends nothing', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; });
  await h.submit();
  assert.equal(h.focused(), '#ticket-type');
  assert.equal(calls, 0);
});

test('pending submission blocks duplicates; success shows server ID and cannot resubmit', async () => {
  let resolve;
  let calls = 0;
  const h = harness(() => { calls++; return new Promise(done => { resolve = done; }); });
  h.fill();
  const pending = h.submit();
  assert.equal(h.get('#ticket-fields').disabled, true);
  await h.submit();
  assert.equal(calls, 1);
  resolve({ data: { id: 124 } });
  await pending;
  assert.equal(h.get('#new-ticket-form').hidden, true);
  assert.equal(h.get('#created-ticket-list').hidden, false);
  assert.match(h.get('#create-ticket-status').textContent, /124/);
  await h.submit();
  assert.equal(calls, 1);
});

test('server field errors retain entered data and translate without reset', async () => {
  const h = harness(async () => { const error = new Error('VALIDATION_ERROR'); error.details = { title: 'TITLE_TOO_SHORT' }; throw error; });
  h.fill();
  await h.submit();
  assert.equal(h.get('#ticket-title').value, ' Test title ');
  assert.equal(h.get('#ticket-title-error').textContent, 'ru:titleLengthError');
  assert.equal(h.focused(), '#ticket-title');
  h.setLanguage('kk');
  h.context.renderNewTicket();
  assert.equal(h.get('#ticket-title-error').textContent, 'kk:titleLengthError');
  assert.equal(h.get('#ticket-description').value, ' A valid description ');
});

test('uncertain network failure retains draft and warns instead of retrying automatically', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; throw new Error('NETWORK_ERROR'); });
  h.fill();
  await h.submit();
  assert.equal(calls, 1);
  assert.equal(h.get('#create-ticket-status').textContent, 'ru:submissionUncertain');
  assert.equal(h.get('#ticket-description').value, ' A valid description ');
  assert.equal(h.get('#ticket-fields').disabled, false);
});

test('logout reset discards late responses from a previous session', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.fill();
  const pending = h.submit();
  h.context.resetNewTicket();
  resolve({ data: { id: 12 } });
  await pending;
  assert.equal(h.get('#create-ticket-status').textContent, '');
  assert.equal(h.get('#ticket-title').value, '');
  assert.equal(h.get('#new-ticket-form').hidden, false);
});
