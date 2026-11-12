import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../js/api.js', import.meta.url), 'utf8');
const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('password state comes from headers; required change and ended sessions are distinct from wrong credentials', async () => {
  const previous = globalThis.fetch;
  const previousWindow = globalThis.window;
  const events = [];
  globalThis.window = { dispatchEvent(event) { events.push([event.type, event.code]); } };
  try {
    globalThis.fetch = async () => Response.json({ data: { user: { id: 1 } } }, { headers: { 'X-Password-Change-Required': 'true' } });
    const result = await api.getMe();
    assert.equal(result.meta.passwordChangeRequired, true);
    assert.deepEqual(result.data.user, { id: 1 });
    globalThis.fetch = async () => Response.json({ error: { code: 'INVALID_CREDENTIALS' } }, { status: 401 });
    await assert.rejects(api.changePassword({ current_password: 'wrong', new_password: 'long-password' }), /INVALID_CREDENTIALS/);
    assert.equal(events.length, 0);
    for (const code of ['PASSWORD_CHANGE_REQUIRED', 'ACCOUNT_DISABLED', 'PASSWORD_CHANGED']) {
      globalThis.fetch = async () => Response.json({ error: { code } }, { status: 403 });
      await assert.rejects(api.getMe(), new RegExp(code));
    }
    assert.deepEqual(events.map(event => event[0]), ['password-change-required', 'session-ended', 'session-ended']);
    globalThis.fetch = async () => Response.json({ error: { code: 'RATE_LIMITED' } }, { status: 429, headers: { 'Retry-After': '37' } });
    await assert.rejects(api.getUsers(), error => error.retryAfter === 37);
  } finally { globalThis.fetch = previous; globalThis.window = previousWindow; }
});

test('account mutations send only contract fields and leave password bytes unchanged', async () => {
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push([url, options.method, JSON.parse(options.body)]);
    assert.equal(options.credentials, 'same-origin');
    return Response.json({ data: { user: { id: 4 } } });
  };
  try {
    await api.createUser({ phone: '87000000004', full_name: ' Name ', department: ' Team ', position: ' Tester ', password: 'ignored' });
    await api.updateUser(4, false);
    await api.changePassword({ current_password: ' old ', new_password: ' new-password-123 ', repeat_password: 'ignored' });
    assert.deepEqual(requests, [
      ['/api/v1/admin/users', 'POST', { phone: '+77000000004', full_name: 'Name', department: 'Team', position: 'Tester' }],
      ['/api/v1/admin/users/4', 'PATCH', { is_active: false }],
      ['/api/v1/auth/change-password', 'POST', { current_password: ' old ', new_password: ' new-password-123 ' }],
    ]);
  } finally { globalThis.fetch = previous; }
});

test('phone normalization agrees with backend national and international formats', () => {
  for (const value of ['+7 (700) 000-00-01', '87000000001', '7000000001']) {
    assert.equal(api.normalizePhone(value), '+77000000001');
  }
  assert.equal(api.normalizePhone('86000000001'), '+76000000001');
  for (const value of ['+87000000001', '123', 'abc7000000001', '+79000000001']) {
    assert.equal(api.normalizePhone(value), null);
  }
});

test('real login sends only normalized credentials, with same-origin cookies', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/v1/auth/login');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { phone: '+77000000001', password: 'test-only' });
    return Response.json({ data: { user: { id: 1, role: 'employee' } } });
  };
  try { assert.equal((await api.login({ phone: '87000000001', password: 'test-only' })).data.user.role, 'employee'); }
  finally { globalThis.fetch = previous; }
});

test('logout handles 204; API errors never expose raw server messages', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal(await api.logout(), null);
    globalThis.fetch = async () => Response.json({ error: { code: 'INVALID_CREDENTIALS', message: 'private diagnostics' } }, { status: 401 });
    await assert.rejects(api.login({ phone: '87000000001', password: 'test-only' }), /^Error: INVALID_CREDENTIALS$/);
    globalThis.fetch = async () => Response.json({ error: { code: 'RATE_LIMITED' } }, { status: 429 });
    await assert.rejects(api.getMe(), /RATE_LIMITED/);
    globalThis.fetch = async () => new Response('<html>Wrong server</html>');
    await assert.rejects(api.getMe(), /API_UNAVAILABLE/);
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    await assert.rejects(api.getMe(), /NETWORK_ERROR/);
  } finally { globalThis.fetch = previous; }
});

test('list uses the agreed endpoint and pagination; malformed pages are rejected', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/v1/tickets?page=2&limit=20');
    assert.equal(options.credentials, 'same-origin');
    return Response.json({ data: [], pagination: { page: 2, limit: 20, total: 0 } });
  };
  try {
    assert.deepEqual((await api.getMyTickets({ page: 2 })).data, []);
    await assert.rejects(api.getMyTickets({ page: 0 }), /VALIDATION_ERROR/);
  } finally { globalThis.fetch = previous; }
});

test('creation sends exactly the allowed fields and preserves backend validation details', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/v1/tickets');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { type: 'problem', title: 'Title', description: 'Description', category: 'it' });
    return Response.json({ error: { code: 'VALIDATION_ERROR', details: { title: 'TITLE_TOO_SHORT' } } }, { status: 400 });
  };
  try {
    await assert.rejects(api.createTicket({ type: 'problem', category: 'it', title: ' Title ', description: ' Description ', author_id: 99, status: 'resolved' }), error => error.message === 'VALIDATION_ERROR' && error.details.title === 'TITLE_TOO_SHORT');
  } finally { globalThis.fetch = previous; }
});

test('ticket details use cookie-authenticated endpoint and reject invalid IDs before a request', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, '/api/v1/tickets/124');
    assert.equal(options.credentials, 'same-origin');
    return Response.json({ data: { id: 124, events: [] } });
  };
  try {
    assert.equal((await api.getTicket('124')).data.id, 124);
    for (const id of ['0', '-1', '01', 'abc', '1/other', '999999999999999999999']) await assert.rejects(api.getTicket(id), /NOT_FOUND/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test('admin queue omits empty status and forwards only allowed filters and pages', async () => {
  const previous = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, options) => {
    urls.push(url);
    assert.equal(options.credentials, 'same-origin');
    return Response.json({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
  };
  try {
    await api.getAdminTickets();
    await api.getAdminTickets({ status: 'in_review', page: 2 });
    assert.deepEqual(urls, ['/api/v1/admin/tickets?page=1&limit=20', '/api/v1/admin/tickets?page=2&limit=20&status=in_review']);
    await assert.rejects(api.getAdminTickets({ status: 'unknown' }), /VALIDATION_ERROR/);
    await assert.rejects(api.getAdminTickets({ page: 0 }), /VALIDATION_ERROR/);
    assert.equal(urls.length, 2);
  } finally { globalThis.fetch = previous; }
});

test('admin PATCH uses exact contract, omits comment for review, and trims final comments', async () => {
  const previous = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/v1/admin/tickets/124');
    assert.equal(options.method, 'PATCH');
    assert.equal(options.credentials, 'same-origin');
    bodies.push(JSON.parse(options.body));
    return Response.json({ data: { id: 124 } });
  };
  try {
    await api.updateTicketStatus(124, { status: 'in_review', comment: 'omit this' });
    await api.updateTicketStatus(124, { status: 'resolved', comment: ' Valid decision ', role: 'admin' });
    await api.updateTicketStatus(124, { status: 'rejected', comment: 'x'.repeat(2000) });
    assert.deepEqual(bodies.slice(0, 2), [{ status: 'in_review' }, { status: 'resolved', comment: 'Valid decision' }]);
    await assert.rejects(api.updateTicketStatus(124, { status: 'new' }), /VALIDATION_ERROR/);
    for (const comment of ['', '    ', 'abcd', 'x'.repeat(2001)]) {
      await assert.rejects(api.updateTicketStatus(124, { status: 'rejected', comment }), /VALIDATION_ERROR/);
    }
    assert.equal(bodies.length, 3);
  } finally { globalThis.fetch = previous; }
});


test('upload sends one multipart file without forcing JSON or boundary', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/v1/tickets/124/attachments');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['Content-Type'], undefined);
    assert.ok(options.body instanceof FormData);
    assert.deepEqual([...options.body.keys()], ['file']);
    assert.equal(options.body.get('file').name, 'a.pdf');
    return Response.json({ data: { id: 7 } }, { status: 201 });
  };
  try { assert.equal((await api.uploadAttachment(124, new File(['%PDF-1.4'], 'a.pdf'))).data.id, 7); }
  finally { globalThis.fetch = previous; }
});


test('reset sends empty JSON and conflict does not end administrator session', async () => {
  const previous = globalThis.fetch, previousWindow = globalThis.window; let events = 0;
  globalThis.window = { dispatchEvent() { events++; } };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/v1/admin/users/4/reset-password');
    assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['Content-Type'], 'application/json'); assert.equal(options.body, '{}');
    return Response.json({ error: { code: 'PASSWORD_CHANGED' } }, { status: 409 });
  };
  try { await assert.rejects(api.resetUserPassword(4), /PASSWORD_CHANGED/); assert.equal(events, 0); }
  finally { globalThis.fetch = previous; globalThis.window = previousWindow; }
});


test('old authorization errors cannot invalidate a newer session epoch', async () => {
  const previous = globalThis.fetch, previousWindow = globalThis.window;
  let finish, events = 0;
  globalThis.window = { dispatchEvent() { events++; } };
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  try {
    const pending = api.getMyTickets();
    api.invalidateSessionRequests();
    finish(Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }));
    await assert.rejects(pending, /UNAUTHORIZED/);
    assert.equal(events, 0);
    globalThis.fetch = async () => Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
    await assert.rejects(api.getMe(), /UNAUTHORIZED/); assert.equal(events, 1);
  } finally { globalThis.fetch = previous; globalThis.window = previousWindow; }
});


test('preview reads protected image blobs with same-origin credentials and rejects document content', async () => {
  const previous=globalThis.fetch;
  try {
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,'/api/v1/tickets/124/attachments/7');
      assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');
      assert.equal(options.responseType,undefined);
      return new Response('image bytes',{headers:{'Content-Type':'image/png'}});
    };
    assert.equal(await (await api.getAttachmentPreview(124,7)).text(),'image bytes');
    globalThis.fetch=async()=>new Response('%PDF-1.4',{headers:{'Content-Type':'application/pdf'}});
    await assert.rejects(api.getAttachmentPreview(124,7),/UNSUPPORTED_FILE_TYPE/);
    globalThis.fetch=async()=>Response.json({error:{code:'NOT_FOUND'}},{status:404});
    await assert.rejects(api.getAttachmentPreview(124,7),/NOT_FOUND/);
  }finally{globalThis.fetch=previous;}
});


test('v0.5 uses exact manager, rule and assignment endpoints with no arbitrary extra fields', async () => {
  const previous=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,method:options.method??'GET',body:options.body?JSON.parse(options.body):undefined});return Response.json({data:{id:7}});};
  try {
    await api.createUser({phone:'87000000004',full_name:' IT ',department:' QA ',position:' Manager ',role:'manager',is_active:true});
    await api.getUsers(2,'manager'); await api.getManagerTickets({status:'new'});
    await api.getAdminTickets({unassigned:true,status:'new'});
    await api.updateRouting('it',7);await api.updateRouting('procurement',null);
    await api.assignTicket(124,8);await api.assignTicket(124,null);
    await api.updateTicketStatus(124,{status:'resolved',comment:'  Resolved by manager.  '},'manager');
    assert.deepEqual(calls.slice(4,8).map(x=>[x.url,x.body]),[
      ['/api/v1/admin/routing/it',{manager_id:7}],['/api/v1/admin/routing/procurement',{manager_id:null}],
      ['/api/v1/admin/tickets/124/assignment',{assigned_to:8}],['/api/v1/admin/tickets/124/assignment',{assigned_to:null}]
    ]);
    assert.equal(calls[0].body.role,'manager');assert.equal('is_active' in calls[0].body,false);
    assert.match(calls[1].url,/role=manager/);assert.match(calls[2].url,/\/manager\/tickets/);assert.match(calls[3].url,/unassigned=true/);
    assert.deepEqual(calls.at(-1).body,{status:'resolved',comment:'Resolved by manager.'});assert.equal(calls.at(-1).url,'/api/v1/manager/tickets/124');
    const count=calls.length;
    assert.throws(()=>api.createUser({role:'admin'}),/VALIDATION_ERROR/);
    assert.throws(()=>api.createTicket({type:'problem',title:'Title',description:'Description'}),/VALIDATION_ERROR/);
    for(const id of ['7',0,-1,undefined,{}]) assert.throws(()=>api.updateRouting('it',id),/VALIDATION_ERROR/);
    assert.throws(()=>api.updateRouting('unknown',7),/VALIDATION_ERROR/);
    assert.equal(calls.length,count);
  } finally {globalThis.fetch=previous;}
});

test('manager directory fetches every page instead of silently truncating choices at twenty', async () => {
  const previous=globalThis.fetch,urls=[];
  globalThis.fetch=async url=>{urls.push(url);return Response.json({data:urls.length===1?Array.from({length:20},(_,id)=>({id:id+1,role:'manager'})):[{id:21,role:'manager'}],pagination:{page:urls.length,limit:20,total:21}});};
  try {const result=await api.getManagers();assert.equal(result.length,21);assert.equal(urls.length,2);assert.match(urls[1],/page=2.*role=manager/);}finally{globalThis.fetch=previous;}
});


test('manager assignment check uses existing rules then scans ticket pages including later assignments', async () => {
  const previous=globalThis.fetch;let calls=[],mode='rule';
  globalThis.fetch=async url=>{
    calls.push(url);
    if(url.endsWith('/admin/routing'))return Response.json({data:[{category:'it',manager_id:mode==='rule'?7:null}]});
    const page=Number(new URL('http://local'+url).searchParams.get('page'));
    return Response.json({data:page===2?[{id:51,assigned_to:mode==='ticket'?7:8}]:Array.from({length:50},(_,id)=>({id,assigned_to:null})),pagination:{page,limit:50,total:51}});
  };
  try {
    assert.equal(await api.hasManagerAssignments(7),true);assert.equal(calls.length,1);
    mode='ticket';calls=[];assert.equal(await api.hasManagerAssignments(7),true);assert.equal(calls.length,3);assert.match(calls.at(-1),/page=2/);
    mode='none';calls=[];assert.equal(await api.hasManagerAssignments(7),false);
    assert.ok(calls.every(url=>url.includes('/admin/')));
  }finally{globalThis.fetch=previous;}
});


test('reassignment filter sends exact boolean query, combines with current filters and preserves backend flags', async () => {
  const previous=globalThis.fetch,urls=[];
  globalThis.fetch=async url=>{urls.push(url);return Response.json({data:[{id:1,needs_reassignment:true},{id:2,needs_reassignment:false}],pagination:{page:1,limit:20,total:2}});};
  try{
    const result=await api.getAdminTickets({needs_reassignment:true,status:'in_review',unassigned:true,page:2});
    assert.equal(urls[0],'/api/v1/admin/tickets?page=2&limit=20&status=in_review&unassigned=true&needs_reassignment=true');
    assert.deepEqual(result.data.map(x=>x.needs_reassignment),[true,false]);
    await api.getAdminTickets({needs_reassignment:false});assert.equal(urls[1],'/api/v1/admin/tickets?page=1&limit=20');
    for(const value of ['true','false','',1,0,null])await assert.rejects(api.getAdminTickets({needs_reassignment:value}),/VALIDATION_ERROR/);
    assert.equal(urls.length,2);
  }finally{globalThis.fetch=previous;}
});
