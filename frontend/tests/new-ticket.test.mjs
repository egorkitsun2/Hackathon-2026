import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const validationSource = (await readFile(new URL('../js/attachment-validation.js', import.meta.url), 'utf8')).replaceAll('export ', '');
const source = validationSource + '\n' + (await readFile(new URL('../js/new-ticket.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');

function harness(createTicket = async () => ({ data: { id: 42 } })) {
  const elements = new Map();
  let focused;
  let language = 'ru';
  const urls = { created: [], revoked: [] };
  function node() { return {
    value: '', dataset: {}, events: {}, attributes: {}, children: [],
    append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; },
    addEventListener(key, callback) { this.events[key] = callback; },
    setAttribute(key, value) { this.attributes[key] = value; }, focus() {},
    set innerHTML(value) { throw new Error('Unsafe HTML'); },
  }; }
  function get(selector) {
    if (!elements.has(selector)) elements.set(selector, { ...node(),
      value: '', dataset: {}, events: {}, attributes: {},
      addEventListener(key, callback) { this.events[key] = callback; },
      setAttribute(key, value) { this.attributes[key] = value; },
      removeAttribute(key) { delete this.attributes[key]; },
      focus() { focused = selector; },
      reset() { for (const name of ['type', 'category', 'title', 'description']) get(`#ticket-${name}`).value = ''; },
    });
    return elements.get(selector);
  }
  const context = vm.createContext({ document: { querySelector: get, createElement: node }, createTicket, URL: { createObjectURL(file) { const url = `blob:qa-${urls.created.length}`; urls.created.push({ file, url }); return url; }, revokeObjectURL(url) { urls.revoked.push(url); } }, TextEncoder, AbortController, uploadAttachment: async () => ({}), getTicket: async () => ({ data: { attachments: [] } }), t: key => `${language}:${key}` });
  vm.runInContext(source, context);
  function fill(values = {}) {
    for (const [key, value] of Object.entries({ type: 'problem', category: 'it', title: ' Test title ', description: ' A valid description ', ...values })) get(`#ticket-${key}`).value = value;
  }
  context.openNewTicket();
  return { context, get, fill, urls, focused: () => focused, setLanguage: value => { language = value; }, submit: () => get('#new-ticket-form').events.submit({ preventDefault() {} }) };
}

test('validation trims edges, checks all lengths, and counts Unicode characters like backend', () => {
  const { context } = harness();
  const validate = values => context.validateTicket({ type: 'problem', category: 'it', title: 'valid', description: 'description', ...values });
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


test('selected attachments validate before creation and upload sequentially after one create', async () => {
  let creates = 0; const calls = [];
  const h = harness(async () => { creates++; return { data: { id: 42 } }; });
  h.fill(); h.get('#ticket-files').files = [{ name: 'bad.exe', size: 1 }]; h.get('#ticket-files').events.change();
  await h.submit(); assert.equal(creates, 0);
  h.get('#ticket-files').files = [{ name: 'a.pdf', size: 10 }, { name: 'b.png', size: 10 }]; h.get('#ticket-files').events.change();
  h.context.uploadAttachment = async (id, file) => { calls.push(file.name); assert.equal(id, 42); };
  await h.submit();
  assert.equal(creates, 1); assert.deepEqual(calls, ['a.pdf', 'b.png']);
  assert.match(h.get('#create-ticket-status').textContent, /2\/2/);
  await h.submit(); assert.equal(creates, 1);
});

test('partial file failure stops the batch, refreshes actual attachments, never recreates ticket', async () => {
  let creates = 0, uploads = 0, reads = 0;
  const h = harness(async () => { creates++; return { data: { id: 42 } }; });
  h.fill(); h.get('#ticket-files').files = ['a.pdf','b.pdf','c.pdf'].map(name => ({ name, size: 10 })); h.get('#ticket-files').events.change();
  h.context.uploadAttachment = async () => { if (++uploads === 2) throw new Error('NETWORK_ERROR'); };
  h.context.getTicket = async () => { reads++; return { data: { attachments: [{ id: 1 }] } }; };
  await h.submit();
  assert.equal(uploads, 2); assert.equal(reads, 2);
  assert.match(h.get('#create-ticket-status').textContent, /newTicketFilesPartial/);
  assert.equal(h.get('#created-ticket-details').hidden, false);
  await h.submit(); assert.equal(creates, 1);
});

test('reset during upload aborts and stops subsequent files without restoring private results', async () => {
  const h = harness(); let calls = 0;
  h.fill(); h.get('#ticket-files').files = ['a.pdf','b.pdf'].map(name => ({ name, size: 10 })); h.get('#ticket-files').events.change();
  h.context.uploadAttachment = (id, file, signal) => { calls++; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('UPLOAD_ABORTED')))); };
  const work = h.submit(); await new Promise(resolve => setImmediate(resolve));
  h.context.resetNewTicket(); await work;
  assert.equal(calls, 1); assert.equal(h.get('#created-ticket-details').hidden, true);
  assert.equal(h.get('#create-ticket-status').textContent, '');
});


test('rejected file shows the specific reason while preserving the created ticket', async () => {
  const h = harness(); h.fill();
  h.get('#ticket-files').files = [{ name: 'photo.pdf', size: 20 }]; h.get('#ticket-files').events.change();
  h.context.uploadAttachment = async () => { const error = new Error('UNSUPPORTED_FILE_TYPE'); error.status = 415; throw error; };
  await h.submit();
  assert.match(h.get('#create-ticket-status').textContent, /attachmentUnsupported/);
  assert.match(h.get('#create-ticket-status').textContent, /UNSUPPORTED_FILE_TYPE \(HTTP 415\)/);
  assert.match(h.get('#create-ticket-status').textContent, /0\/1/);
  assert.equal(h.get('#created-ticket-details').hidden, false);
});


test('counters use trimmed Unicode code points and preserve input through locale change', () => {
  const h = harness();
  const title = '  ' + '\u{1F600}'.repeat(120) + '  ';
  const description = '  ' + '\u049B'.repeat(4000) + '  ';
  h.fill({ title, description });
  h.get('#ticket-title').events.input(); h.get('#ticket-description').events.input();
  assert.equal(h.get('#ticket-title-counter').textContent, '120 / 120');
  assert.equal(h.get('#ticket-description-counter').textContent, '4000 / 4000');
  assert.equal(h.get('#ticket-title-counter').dataset.exceeded, 'false');
  assert.equal(h.context.validateTicket({ type: 'problem', title, description }).title, undefined);
  h.setLanguage('kk'); h.context.renderNewTicket();
  assert.equal(h.get('#ticket-title').value, title);
  assert.equal(h.get('#ticket-description').value, description);
  assert.match(h.get('#ticket-title-counter').attributes['aria-label'], /^kk:characterCount/);
  assert.equal(h.get('#ticket-description-counter').textContent, '4000 / 4000');
});

test('over-limit counter styling agrees with validation and resets on clearing and form reset', () => {
  const h = harness();
  h.fill({ title: '\u{1F600}'.repeat(121), description: 'x'.repeat(4001) });
  h.context.renderNewTicket();
  assert.equal(h.get('#ticket-title-counter').dataset.exceeded, 'true');
  assert.equal(h.get('#ticket-description-counter').dataset.exceeded, 'true');
  assert.equal(h.get('#ticket-title-counter').textContent, '121 / 120');
  assert.ok(h.context.validateTicket({ type: 'problem', category: 'it', title: h.get('#ticket-title').value, description: h.get('#ticket-description').value }).title);
  h.get('#ticket-title').value = '   '; h.get('#ticket-title').events.input();
  assert.equal(h.get('#ticket-title-counter').textContent, '0 / 120');
  assert.equal(h.get('#ticket-title-counter').dataset.exceeded, 'false');
  h.context.resetNewTicket();
  assert.equal(h.get('#ticket-description-counter').textContent, '0 / 4000');
  assert.equal(h.get('#ticket-description-counter').dataset.exceeded, 'false');
});


function choose(h, files) { h.get('#ticket-files').files = files; h.get('#ticket-files').events.change(); }
function previews(h) { return h.get('#ticket-previews').children; }
function removePreview(h, index) { previews(h)[index].children.at(-1).events.click(); }

test('preview reuses object URLs, appends selections, removes only one file and uploads remaining files', async () => {
  let creates = 0; const sent = [];
  const h = harness(async () => { creates++; return { data: { id: 42 } }; }); h.fill();
  choose(h, [{ name: '<photo>.png', size: 100 }, { name: 'document.pdf', size: 200 }]);
  assert.equal(creates, 0); assert.equal(previews(h).length, 2);
  assert.equal(previews(h)[0].children[1].children[0].textContent, '<photo>.png');
  assert.equal(h.urls.created.length, 1);
  h.get('#ticket-title').events.input(); h.context.renderNewTicket();
  assert.equal(h.urls.created.length, 1);
  h.setLanguage('kk'); h.context.renderNewTicket();
  assert.equal(previews(h)[0].children.at(-1).textContent, 'kk:removeSelectedFile');
  assert.equal(h.urls.created.length, 1);
  choose(h, [{ name: 'other.webp', size: 300 }]);
  assert.equal(previews(h).length, 3); assert.equal(h.urls.created.length, 2);
  removePreview(h, 0);
  assert.equal(previews(h).length, 2); assert.equal(h.urls.revoked.length, 1);
  h.context.uploadAttachment = async (id, file) => { sent.push(file.name); };
  await h.submit();
  assert.deepEqual(sent, ['document.pdf', 'other.webp']);
  assert.equal(h.urls.revoked.length, 2); assert.equal(previews(h).length, 0);
});

test('preview rejects fourth, oversized or unsupported files without losing valid selection', async () => {
  const h = harness(); h.fill();
  choose(h, ['a.pdf', 'b.png', 'c.jpg'].map(name => ({ name, size: 100 })));
  choose(h, [{ name: 'd.webp', size: 100 }]);
  assert.equal(previews(h).length, 3);
  assert.equal(h.get('#ticket-files-error').textContent, 'ru:newTicketFilesLimit');
  h.get('#clear-ticket-files').events.click();
  assert.equal(previews(h).length, 0); assert.equal(h.urls.revoked.length, 2);
  choose(h, [{ name: 'good.pdf', size: 100 }]);
  choose(h, [{ name: 'big.png', size: 5242881 }]);
  assert.equal(previews(h).length, 1); assert.equal(h.get('#ticket-files-error').textContent, 'ru:attachmentTooLarge');
  choose(h, [{ name: 'script.svg', size: 100 }]);
  assert.equal(previews(h).length, 1); assert.equal(h.get('#ticket-files-error').textContent, 'ru:attachmentUnsupported');
});

test('leaving form releases URLs, reopening recreates them, reset drops files and stale image errors are ignored', () => {
  const h = harness();
  choose(h, [{ name: 'picture.jpeg', size: 100 }]);
  const oldImage = previews(h)[0].children[0];
  h.context.closeNewTicket();
  assert.equal(previews(h).length, 0); assert.equal(h.urls.revoked.length, 1);
  h.context.renderNewTicket(); assert.equal(h.urls.created.length, 1);
  h.context.openNewTicket(); assert.equal(h.urls.created.length, 2);
  oldImage.events.error(); assert.equal(h.urls.revoked.length, 1);
  const image = previews(h)[0].children[0]; image.events.error();
  assert.equal(h.urls.revoked.length, 2);
  assert.equal(previews(h)[0].children[0].textContent, 'ru:attachmentPreviewUnavailable');
  h.context.resetNewTicket(); assert.equal(previews(h).length, 0);
  assert.equal(h.get('#ticket-files').value, '');
});


test('writing prompts match existing types, change language and never overwrite or submit draft content', async () => {
  let sent;
  const h = harness(async values => { sent = values; return { data: { id: 42 } }; });
  h.context.renderNewTicket();
  assert.equal(h.get('#ticket-help-choose').hidden, false);
  const title = '  Draft title  ', description = '  My own description, not a template.  ';
  h.fill({ title, description });
  h.get('#ticket-writing-help').open = true;
  for (const [type, count, first] of [
    ['problem', 4, 'helpWhatHappened'], ['suggestion', 3, 'helpSuggestionChange'],
    ['complaint', 4, 'helpComplaintAbout'], ['gratitude', 3, 'helpGratitudeWho'],
  ]) {
    h.get('#ticket-type').value = type; h.get('#ticket-type').events.change();
    assert.equal(h.get('#ticket-help-prompts').children.length, count);
    assert.equal(h.get('#ticket-help-prompts').children[0].textContent, `ru:${first}`);
    assert.equal(h.get('#ticket-help-choose').hidden, true);
    assert.equal(h.get('#ticket-title').value, title);
    assert.equal(h.get('#ticket-description').value, description);
    assert.equal(h.get('#ticket-writing-help').open, true);
  }
  h.setLanguage('kk'); h.context.renderNewTicket();
  assert.equal(h.get('#ticket-help-prompts').children[0].textContent, 'kk:helpGratitudeWho');
  await h.submit();
  assert.deepEqual({ ...sent }, { type: 'gratitude', category: 'it', title, description });
  h.context.resetNewTicket(); assert.equal(h.get('#ticket-writing-help').open, false);
  assert.equal(h.get('#ticket-help-prompts').hidden, true);
});


test('direction is required and unsupported or arbitrary assignment inputs are never submitted', async () => {
  let sent;
  const h=harness(async values=>{sent=values;return {data:{id:42}};});
  h.fill({category:''});await h.submit();assert.equal(sent,undefined);assert.equal(h.focused(),'#ticket-category');
  h.fill({category:'unknown'});await h.submit();assert.equal(sent,undefined);
  h.fill({category:'procurement'});h.setLanguage('kk');h.context.renderNewTicket();
  assert.equal(h.get('#ticket-category').value,'procurement');await h.submit();assert.equal(sent.category,'procurement');
  assert.equal('assigned_to' in sent,false);assert.equal('manager_id' in sent,false);
});
