import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const validationSource = (await readFile(new URL('../js/attachment-validation.js', import.meta.url), 'utf8')).replaceAll('export ', '');
const source = validationSource + '\n' + (await readFile(new URL('../js/ticket.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const ticket = {
  id: 124, type: 'problem', title: '<script>literal title</script>', description: 'Line one\nLine two', status: 'resolved',
  created_at: '2026-11-10T08:00:00.000Z', events: [
    { id: 3, actor: { full_name: '<b>Admin</b>' }, old_status: 'in_review', new_status: 'resolved', comment: 'Final decision', created_at: '2026-11-10T10:00:00.000Z' },
    { id: 1, actor: { full_name: 'Employee' }, old_status: null, new_status: 'new', comment: null, created_at: '2026-11-10T08:00:00.000Z' },
    { id: 2, actor: { full_name: 'Admin' }, old_status: 'new', new_status: 'in_review', comment: 'Intermediate note', created_at: '2026-11-10T09:00:00.000Z' },
  ],
};

function harness(getTicket = async () => ({ data: ticket }), updateTicketStatus = async () => ({})) {
  const elements = new Map();
  const urls = { created: [], revoked: [] };
  const element = () => ({
    textContent: '', value: '', children: [], events: {}, attributes: {}, dataset: {},
    focus() { this.focused = true; },
    replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); },
    addEventListener(name, callback) { this.events[name] = callback; },
    setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; },
    set innerHTML(value) { throw new Error('Unsafe HTML insertion'); },
  });
  const get = selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  const document = { querySelector: get, createElement: element, documentElement: { lang: 'ru' } };
  const context = vm.createContext({ document, getTicket, updateTicketStatus, getAttachmentPreview: async () => ({}), URL: { createObjectURL() { const url = `blob:test-${urls.created.length}`; urls.created.push(url); return url; }, revokeObjectURL(url) { urls.revoked.push(url); } }, TextEncoder, AbortController, uploadAttachment: async () => ({}), Intl, t: key => `${document.documentElement.lang}:${key}` });
  vm.runInContext(source, context);
  return { context, get, document, urls };
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

test('only new tickets can be taken; duplicates are blocked and details refresh after save', async () => {
  let current = { ...ticket, status: 'new' };
  let calls = 0;
  let resolve;
  const h = harness(async () => ({ data: current }), async (id, values) => {
    calls++;
    assert.equal(id, 124);
    assert.equal(values.status, 'in_review');
    await new Promise(done => { resolve = done; });
    current = { ...current, status: 'in_review' };
  });
  h.context.openTicketDetails('124', true);
  await flush();
  assert.equal(h.get('#take-ticket').hidden, false);
  assert.equal(h.get('#ticket-decision-form').hidden, true);
  const pending = h.get('#take-ticket').events.click();
  assert.equal(h.get('#take-ticket').disabled, true);
  await h.get('#take-ticket').events.click();
  assert.equal(calls, 1);
  resolve();
  await pending;
  assert.equal(h.get('#take-ticket').hidden, true);
  assert.equal(h.get('#ticket-decision-form').hidden, false);
  assert.equal(h.get('#detail-status').textContent, 'ru:in_review');
  assert.equal(h.get('#admin-action-status').textContent, 'ru:decisionSaved');
});

test('terminal decisions require a choice and a trimmed 5–2000 character comment', async () => {
  let calls = 0;
  let current = { ...ticket, status: 'in_review' };
  const h = harness(async () => ({ data: current }), async (id, values) => { calls++; current = { ...current, status: values.status }; });
  h.context.openTicketDetails('124', true);
  await flush();
  const submit = () => h.get('#ticket-decision-form').events.submit({ preventDefault() {} });
  await submit();
  assert.equal(h.get('#ticket-decision').focused, true);
  h.get('#ticket-decision').value = 'rejected';
  for (const comment of ['    ', 'abcd', 'x'.repeat(2001)]) {
    h.get('#ticket-decision-comment').value = comment;
    await submit();
    assert.equal(h.get('#ticket-decision-comment-error').textContent, 'ru:decisionCommentError');
  }
  assert.equal(calls, 0);
  h.get('#ticket-decision-comment').value = ' Valid reason ';
  h.document.documentElement.lang = 'kk';
  h.context.renderTicketDetails();
  assert.equal(h.get('#ticket-decision-comment').value, ' Valid reason ');
  await submit();
  assert.equal(calls, 1);
  assert.equal(h.get('#detail-status').textContent, 'kk:rejected');
  assert.equal(h.get('#ticket-decision-form').hidden, true);
  assert.equal(h.get('#ticket-closed-note').hidden, false);
  await submit();
  assert.equal(calls, 1);
});

test('employees and closed tickets cannot trigger mutations even through handlers', async () => {
  let calls = 0;
  const h = harness(async () => ({ data: ticket }), async () => { calls++; });
  h.context.openTicketDetails('124');
  await flush();
  assert.equal(h.get('#admin-ticket-actions').hidden, true);
  await h.get('#take-ticket').events.click();
  await h.get('#ticket-decision-form').events.submit({ preventDefault() {} });
  h.context.openTicketDetails('124', true);
  await flush();
  await h.get('#take-ticket').events.click();
  assert.equal(calls, 0);
});

test('conflict refreshes current status without replaying a mutation', async () => {
  let current = { ...ticket, status: 'new' };
  let calls = 0;
  const h = harness(async () => ({ data: current }), async () => {
    calls++;
    current = { ...current, status: 'in_review' };
    throw new Error('INVALID_TRANSITION');
  });
  h.context.openTicketDetails('124', true);
  await flush();
  await h.get('#take-ticket').events.click();
  assert.equal(calls, 1);
  assert.equal(h.get('#detail-status').textContent, 'ru:in_review');
  assert.equal(h.get('#admin-action-status').textContent, 'ru:decisionConflict');
});

test('uncertain PATCH refreshes persisted state and does not automatically retry', async () => {
  let current = { ...ticket, status: 'in_review' };
  let calls = 0;
  const h = harness(async () => ({ data: current }), async () => {
    calls++;
    current = { ...current, status: 'resolved' };
    throw new Error('NETWORK_ERROR');
  });
  h.context.openTicketDetails('124', true);
  await flush();
  h.get('#ticket-decision').value = 'resolved';
  h.get('#ticket-decision-comment').value = 'A valid decision';
  await h.get('#ticket-decision-form').events.submit({ preventDefault() {} });
  assert.equal(calls, 1);
  assert.equal(h.get('#detail-status').textContent, 'ru:resolved');
  assert.equal(h.get('#admin-action-status').textContent, 'ru:decisionUncertain');
});

test('logout clears comment and ignores late save responses', async () => {
  let resolve;
  const h = harness(async () => ({ data: { ...ticket, status: 'in_review' } }), () => new Promise(done => { resolve = done; }));
  h.context.openTicketDetails('124', true);
  await flush();
  h.get('#ticket-decision').value = 'resolved';
  h.get('#ticket-decision-comment').value = 'Private comment';
  const pending = h.get('#ticket-decision-form').events.submit({ preventDefault() {} });
  h.context.closeTicketDetails();
  resolve({});
  await pending;
  assert.equal(h.get('#ticket-decision-comment').value, '');
  assert.equal(h.get('#ticket-detail-content').hidden, true);
  assert.equal(h.get('#admin-action-status').textContent, '');
});


test('attachment validation accepts four formats at 5 MiB and rejects empty, oversized and unsafe names', () => {
  const h = harness();
  for (const name of ['photo.JPG', 'photo.jpeg', 'photo.png', 'photo.webp', 'file.pdf']) {
    assert.equal(h.context.validateAttachment({ name, size: 5242880 }), '');
  }
  for (const file of [{ name: 'a.pdf', size: 0 }, { name: 'a.pdf', size: 5242881 }, { name: 'a.exe', size: 1 }, { name: '../a.pdf', size: 1 }, { name: 'a'.repeat(181) + '.pdf', size: 1 }]) {
    assert.ok(h.context.validateAttachment(file));
  }
});

test('attachments render safely, ignore external URLs and limit uploads to author of new ticket', async () => {
  const file = { id: 7, original_name: '<b>photo.jpg</b>', size_bytes: 123, mime_type: 'image/jpeg', url: 'https://untrusted.invalid/' };
  for (const [status, admin, count, hidden] of [['new', false, 1, false], ['new', true, 1, true], ['in_review', false, 1, true], ['resolved', false, 1, true], ['new', false, 3, true]]) {
    const h = harness(async () => ({ data: { ...ticket, status, attachments: Array(count).fill(file) } }));
    h.context.openTicketDetails('124', admin); await flush();
    assert.equal(h.get('#attachment-form').hidden, hidden);
    const row = h.get('#attachments-list').children[0];
    assert.equal(row.children[0].textContent, file.original_name);
    assert.equal(row.children[2].href, '/api/v1/tickets/124/attachments/7');
    h.document.documentElement.lang = 'kk'; h.context.renderTicketDetails();
    assert.equal(h.get('#attachments-list').children[0].children[2].textContent, 'kk:attachmentDownload');
    h.context.closeTicketDetails(); assert.equal(h.get('#attachments-list').children.length, 0);
  }
});

test('upload blocks double submit, refreshes after uncertainty and respects changed ticket status', async () => {
  let reads = 0, writes = 0, rejectUpload;
  const h = harness(async () => ({ data: { ...ticket, status: ++reads === 1 ? 'new' : 'in_review', attachments: [] } }));
  h.context.uploadAttachment = () => { writes++; return new Promise((resolve, reject) => { rejectUpload = reject; }); };
  h.context.openTicketDetails('124'); await flush();
  h.get('#attachment-file').files = [{ name: 'photo.png', size: 50 }];
  const submit = () => h.get('#attachment-form').events.submit({ preventDefault() {} });
  const pending = submit(); await submit(); assert.equal(writes, 1);
  rejectUpload(new Error('NETWORK_ERROR')); await pending;
  assert.equal(reads, 2); assert.equal(writes, 1);
  assert.equal(h.get('#attachment-status').textContent, 'ru:attachmentUncertain');
  assert.equal(h.get('#attachment-form').hidden, true);
});

test('cancel refreshes details; navigation aborts and discards late upload response', async () => {
  let reads = 0;
  const h = harness(async () => { reads++; return { data: { ...ticket, status: 'new', attachments: [] } }; });
  h.context.uploadAttachment = (id, file, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('UPLOAD_ABORTED'))));
  h.context.openTicketDetails('124'); await flush();
  h.get('#attachment-file').files = [{ name: 'a.pdf', size: 20 }];
  const submit = () => h.get('#attachment-form').events.submit({ preventDefault() {} });
  const first = submit(); h.get('#attachment-cancel').events.click(); await first;
  assert.equal(reads, 2);
  const second = submit(); h.context.closeTicketDetails(); await second;
  assert.equal(reads, 2); assert.equal(h.get('#attachments-list').children.length, 0);
  assert.equal(h.get('#attachment-status').textContent, '');
});


test('saved image previews work for employee/admin, reuse URLs across translation and clear on leave', async () => {
  for (const admin of [false,true]) {
    const files = [
      { id:7,original_name:'<photo>.png',mime_type:'image/png',size_bytes:100 },
      { id:8,original_name:'file.pdf',mime_type:'application/pdf',size_bytes:50 },
    ];
    let calls=0;
    const h=harness(async()=>({data:{...ticket,attachments:files}}));
    h.context.getAttachmentPreview=async(id,fileId)=>{calls++;assert.equal(id,124);assert.equal(fileId,7);return {};};
    h.context.openTicketDetails('124',admin);await flush();
    const rows=h.get('#attachments-list').children;
    assert.equal(rows[0].children[0].textContent,'<photo>.png');
    assert.equal(rows[0].children[3].children[0].src,'blob:test-0');
    assert.equal(rows[1].children[3].textContent,'PDF');assert.equal(calls,1);
    h.document.documentElement.lang='kk';h.context.renderTicketDetails();
    assert.equal(calls,1);assert.equal(h.urls.created.length,1);
    h.context.closeTicketDetails();assert.deepEqual(h.urls.revoked,['blob:test-0']);
    assert.equal(h.get('#attachments-list').children.length,0);
  }
});

test('leaving aborts preview read and ignores late blobs without creating an object URL', async () => {
  let finish,signal;
  const h=harness(async()=>({data:{...ticket,attachments:[{id:7,original_name:'a.jpg',mime_type:'image/jpeg',size_bytes:10}]}}));
  h.context.getAttachmentPreview=(id,fileId,value)=>{signal=value;return new Promise(resolve=>{finish=resolve;});};
  h.context.openTicketDetails('124');await flush();h.context.closeTicketDetails();
  assert.equal(signal.aborted,true);finish({});await flush();
  assert.equal(h.urls.created.length,0);assert.equal(h.get('#attachments-list').children.length,0);
});

test('preview failure retains download; explicit retry works and decode failure revokes URL', async () => {
  let calls=0;
  const h=harness(async()=>({data:{...ticket,attachments:[{id:7,original_name:'a.webp',mime_type:'image/webp',size_bytes:10}]}}));
  h.context.getAttachmentPreview=async()=>{if(++calls===1)throw new Error('NETWORK_ERROR');return {};};
  h.context.openTicketDetails('124');await flush();
  let row=h.get('#attachments-list').children[0];
  assert.equal(row.children[2].href,'/api/v1/tickets/124/attachments/7');
  const container=row.children[3];assert.match(container.children[0].textContent,/attachmentPreviewUnavailable/);
  container.children[1].events.click();await flush();
  assert.equal(calls,2);assert.equal(container.children[0].src,'blob:test-0');
  container.children[0].events.error();
  assert.deepEqual(h.urls.revoked,['blob:test-0']);
  assert.match(container.children[0].textContent,/attachmentPreviewUnavailable/);
  h.context.closeTicketDetails();assert.equal(h.urls.revoked.length,1);
});
