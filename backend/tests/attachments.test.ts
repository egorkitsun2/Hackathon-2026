import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { openDatabase, migrate } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { createApp } from '../src/index.js';

const origin = 'http://localhost:8787';
const password = randomBytes(24).toString('base64url');
const phones = ['+77000000001', '+77000000002', '+77000000003'];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aRsAAAAASUVORK5CYII=', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCZgA//2Q==', 'base64');
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==', 'base64');
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const ticket = { type: 'problem', title: 'Broken scanner', description: 'The scanner stopped working today.' };
const metadataKeys = ['created_at', 'id', 'mime_type', 'original_name', 'size_bytes', 'url'].sort();

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'team-voice-attachments-'));
  const db = openDatabase(':memory:');
  migrate(db);
  const hash = await hashPassword(password);
  const insert = db.prepare(`INSERT INTO users (phone, full_name, department, position, password_hash, role, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)`);
  for (let i = 0; i < phones.length; i++) insert.run(phones[i], `User ${i}`, 'Warehouse', 'Worker', hash, i === 2 ? 'admin' : 'employee', new Date().toISOString());
  const app = await createApp({ db, origin, attachmentsDir: join(dir, 'files') });
  return { dir, db, app };
}
async function cleanup(f: Fixture) {
  f.db.close();
  assert.equal(dirname(resolve(f.dir)), resolve(tmpdir()));
  assert.match(basename(resolve(f.dir)), /^team-voice-attachments-/);
  await rm(f.dir, { recursive: true, force: true });
}
function json(f: Fixture, path: string, method = 'GET', cookie?: string, body?: unknown) {
  return f.app.request(`/api/v1${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function login(f: Fixture, index: number) {
  const res = await json(f, '/auth/login', 'POST', undefined, { phone: phones[index], password });
  assert.equal(res.status, 200, await res.clone().text());
  const cookie = res.headers.get('set-cookie'); assert.ok(cookie); return cookie.split(';')[0];
}
async function createTicket(f: Fixture, cookie: string) {
  const res = await json(f, '/tickets', 'POST', cookie, ticket);
  assert.equal(res.status, 201, await res.clone().text()); return (await res.json() as any).data.id as number;
}
function form(bytes: Buffer, filename: string, type = 'application/octet-stream') {
  const data = new FormData(); data.append('file', new Blob([new Uint8Array(bytes)], { type }), filename); return data;
}
function upload(f: Fixture, id: number, cookie: string | undefined, body: BodyInit, contentType?: string, requestOrigin = origin) {
  return f.app.request(`/api/v1/tickets/${id}/attachments`, { method: 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: requestOrigin, ...(contentType ? { 'Content-Type': contentType } : {}) }, body });
}
async function error(res: Response, status: number, code: string) {
  assert.equal(res.status, status, await res.clone().text()); assert.equal((await res.json() as any).error.code, code);
}
async function storedFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return (await Promise.all(entries.map(async e => e.isDirectory() ? storedFiles(join(dir, e.name)) : [join(dir, e.name)]))).flat();
  } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
}

test('attachment formats, protected downloads, metadata and ownership', async () => {
  const f = await fixture();
  try {
    const author = await login(f, 0), other = await login(f, 1), admin = await login(f, 2);
    const first = await createTicket(f, author), second = await createTicket(f, author), foreign = await createTicket(f, other);
    const old = (await (await json(f, `/tickets/${first}`, 'GET', author)).json() as any).data;
    assert.deepEqual(old.attachments, []);
    const cases = [['photo.jpg', jpeg, 'image/jpeg'], ['image.PNG', png, 'image/png'], ['image.webp', webp, 'image/webp'], ['document.pdf', pdf, 'application/pdf']] as const;
    const saved: any[] = [];
    for (let i = 0; i < cases.length; i++) {
      const [name, bytes, mime] = cases[i]; const id = i === 3 ? second : first;
      const res = await upload(f, id, author, form(bytes, name));
      assert.equal(res.status, 201, await res.clone().text());
      const item = (await res.json() as any).data; saved.push(item);
      assert.deepEqual(Object.keys(item).sort(), metadataKeys);
      assert.equal(item.original_name, name); assert.equal(item.mime_type, mime); assert.equal(item.size_bytes, bytes.length);
      assert.equal(item.url, `/api/v1/tickets/${id}/attachments/${item.id}`);
      for (const cookie of [author, admin]) {
        const download = await f.app.request(item.url, { headers: { Cookie: cookie } });
        assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), mime);
        assert.match(download.headers.get('content-disposition') ?? '', /^attachment(?:;|$)/i);
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
      }
    }
    const detail = (await (await json(f, `/tickets/${first}`, 'GET', author)).json() as any).data;
    assert.deepEqual(detail.attachments, saved.slice(0, 3));
    const { attachments: _beforeAttachments, ...beforeFields } = old;
    const { attachments: _afterAttachments, ...afterFields } = detail;
    assert.deepEqual(afterFields, beforeFields);
    assert.deepEqual((await (await json(f, `/tickets/${first}`, 'GET', admin)).json() as any).data.attachments, saved.slice(0, 3));
    assert.equal(JSON.stringify(detail).includes('storage_key'), false);
    await error(await f.app.request(saved[0].url), 401, 'UNAUTHORIZED');
    await error(await f.app.request(saved[0].url, { headers: { Cookie: other } }), 404, 'NOT_FOUND');
    await error(await f.app.request(`/api/v1/tickets/${foreign}/attachments/${saved[0].id}`, { headers: { Cookie: admin } }), 404, 'NOT_FOUND');
    await error(await f.app.request(`/api/v1/tickets/${first}/attachments/999999`, { headers: { Cookie: author } }), 404, 'NOT_FOUND');
    await error(await upload(f, second, undefined, form(png, 'x.png')), 401, 'UNAUTHORIZED');
    await error(await upload(f, second, other, form(png, 'x.png')), 404, 'NOT_FOUND');
    await error(await upload(f, second, admin, form(png, 'x.png')), 403, 'FORBIDDEN');
    await error(await upload(f, second, author, form(png, 'x.png'), undefined, 'http://evil.example'), 403, 'INVALID_ORIGIN');
    f.db.prepare("UPDATE tickets SET status = 'in_review' WHERE id = ?").run(second);
    await error(await upload(f, second, author, form(png, 'x.png')), 409, 'ATTACHMENTS_LOCKED');
  } finally { await cleanup(f); }
});

test('invalid multipart, filenames, types and upload limits leave no files', async () => {
  const f = await fixture();
  try {
    const author = await login(f, 0), id = await createTicket(f, author);
    await error(await upload(f, id, author, 'bad', 'text/plain'), 415, 'UNSUPPORTED_MEDIA_TYPE');
    await error(await upload(f, id, author, 'bad', 'multipart/form-data; boundary=test'), 400, 'VALIDATION_ERROR');
    await error(await upload(f, id, author, new FormData()), 400, 'VALIDATION_ERROR');
    const extra = form(png, 'x.png'); extra.append('extra', 'x');
    await error(await upload(f, id, author, extra), 400, 'VALIDATION_ERROR');
    const multiple = form(png, 'x.png'); multiple.append('file', new Blob([new Uint8Array(png)]), 'y.png');
    await error(await upload(f, id, author, multiple), 400, 'VALIDATION_ERROR');
    await error(await upload(f, id, author, form(Buffer.alloc(0), 'empty.png')), 400, 'VALIDATION_ERROR');
    await error(await upload(f, id, author, form(png, 'wrong.pdf')), 415, 'UNSUPPORTED_FILE_TYPE');
    await error(await upload(f, id, author, form(Buffer.from('not an image'), 'fake.png')), 415, 'UNSUPPORTED_FILE_TYPE');
    await error(await upload(f, id, author, form(png, 'photo.gif')), 415, 'UNSUPPORTED_FILE_TYPE');
    const raw = '--test\r\nContent-Disposition: form-data; name="file"; filename="../evil.png"\r\nContent-Type: image/png\r\n\r\n';
    await error(await upload(f, id, author, Buffer.concat([Buffer.from(raw), png, Buffer.from('\r\n--test--\r\n')]), 'multipart/form-data; boundary=test'), 400, 'VALIDATION_ERROR');
    const big = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]);
    await error(await upload(f, id, author, form(big, 'large.png')), 413, 'FILE_TOO_LARGE');
    const limit = 5 * 1024 * 1024 + 64 * 1024;
    const declared = await f.app.request(`/api/v1/tickets/${id}/attachments`, { method: 'POST', headers: { Cookie: author, Origin: origin, 'Content-Type': 'multipart/form-data; boundary=test', 'Content-Length': String(limit + 1) }, body: 'x' });
    await error(declared, 413, 'UPLOAD_TOO_LARGE');
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (sent <= limit) { controller.enqueue(Buffer.alloc(65536, 120)); sent += 65536; }
      else controller.close();
    } });
    const chunked = new Request(`http://localhost:8787/api/v1/tickets/${id}/attachments`, { method: 'POST', headers: { Cookie: author, Origin: origin, 'Content-Type': 'multipart/form-data; boundary=test' }, body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' });
    await error(await f.app.fetch(chunked), 413, 'UPLOAD_TOO_LARGE');
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM ticket_attachments').get() as any).n, 0);
    assert.deepEqual(await storedFiles(join(f.dir, 'files')), []);
  } finally { await cleanup(f); }
});

test('concurrent uploads enforce quota without orphan files', async () => {
  const f = await fixture();
  try {
    const author = await login(f, 0), id = await createTicket(f, author);
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => upload(f, id, author, form(png, `${i}.png`))));
    assert.deepEqual(results.map(r => r.status).sort((a, b) => a - b), [201, 201, 201, 409]);
    for (const res of results.filter(r => r.status === 409)) await error(res, 409, 'ATTACHMENT_LIMIT_REACHED');
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM ticket_attachments WHERE ticket_id = ?').get(id) as any).n, 3);
    assert.equal((await storedFiles(join(f.dir, 'files'))).length, 3);
  } finally { await cleanup(f); }
});

test('status and session are rechecked after an upload pauses', async () => {
  const f = await fixture();
  try {
    const author = await login(f, 0);
    for (const change of ['status', 'session'] as const) {
      const id = await createTicket(f, author);
      let resume!: () => void;
      let paused!: () => void;
      const gate = new Promise<void>(resolve => { resume = resolve; });
      const reached = new Promise<void>(resolve => { paused = resolve; });
      let part = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (part++ === 0) {
            controller.enqueue(Buffer.concat([Buffer.from('--pause\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n'), png]));
          } else {
            paused(); await gate;
            controller.enqueue(Buffer.from('\r\n--pause--\r\n')); controller.close();
          }
        },
      });
      const req = new Request(`http://localhost:8787/api/v1/tickets/${id}/attachments`, {
        method: 'POST', headers: { Cookie: author, Origin: origin, 'Content-Type': 'multipart/form-data; boundary=pause' },
        body: stream, duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      const pending = f.app.fetch(req);
      await reached;
      if (change === 'status') f.db.prepare("UPDATE tickets SET status = 'in_review' WHERE id = ?").run(id);
      else {
        const token = decodeURIComponent(author.slice(author.indexOf('=') + 1));
        f.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(createHash('sha256').update(token).digest('hex'));
      }
      resume();
      await error(await pending, change === 'status' ? 409 : 401, change === 'status' ? 'ATTACHMENTS_LOCKED' : 'UNAUTHORIZED');
      assert.equal((f.db.prepare('SELECT count(*) AS n FROM ticket_attachments WHERE ticket_id = ?').get(id) as any).n, 0);
    }
    assert.deepEqual(await storedFiles(join(f.dir, 'files')), []);
  } finally { await cleanup(f); }
});




test('a file exactly five MiB is accepted and downloaded intact', async () => {
  const f = await fixture();
  try {
    const author = await login(f, 0), id = await createTicket(f, author);
    const bytes = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024 - png.length)]);
    const res = await upload(f, id, author, form(bytes, 'boundary.png'));
    assert.equal(res.status, 201, await res.clone().text());
    const item = (await res.json() as any).data;
    assert.equal(item.size_bytes, 5 * 1024 * 1024);
    const download = await f.app.request(item.url, { headers: { Cookie: author } });
    assert.equal(download.status, 200);
    const downloaded = Buffer.from(await download.arrayBuffer());
    assert.equal(downloaded.length, 5 * 1024 * 1024);
    assert.deepEqual(downloaded, bytes);
  } finally { await cleanup(f); }
});

test('a failed attachment insert rolls back file publication and preserves the ticket', async () => {
  const f = await fixture();
  try {
    const author = await login(f, 0), id = await createTicket(f, author);
    const before = await (await json(f, `/tickets/${id}`, 'GET', author)).json();
    f.db.exec("CREATE TRIGGER fail_attachment BEFORE INSERT ON ticket_attachments BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const res = await upload(f, id, author, form(png, 'image.png'));
    assert.equal(res.status, 500, await res.clone().text());
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM ticket_attachments').get() as any).n, 0);
    assert.deepEqual(await storedFiles(join(f.dir, 'files')), []);
    const after = await (await json(f, `/tickets/${id}`, 'GET', author)).json();
    assert.deepEqual(after, before);
  } finally { await cleanup(f); }
});

test('a reported commit error does not delete a file whose metadata was committed', async () => {
  const f = await fixture();
  try {
    const author = await login(f, 0), id = await createTicket(f, author);
    const originalExec = f.db.exec.bind(f.db);
    let injected = false;
    f.db.exec = (sql: string) => {
      originalExec(sql);
      if (!injected && sql.trim().toUpperCase() === 'COMMIT' &&
          (f.db.prepare('SELECT count(*) AS n FROM ticket_attachments WHERE ticket_id = ?').get(id) as any).n === 1) {
        injected = true;
        throw new Error('simulated error after successful commit');
      }
    };
    const res = await upload(f, id, author, form(png, 'image.png'));
    assert.equal(res.status, 500, await res.clone().text());
    assert.equal(injected, true);
    const detail = (await (await json(f, `/tickets/${id}`, 'GET', author)).json() as any).data;
    assert.equal(detail.attachments.length, 1);
    const download = await f.app.request(detail.attachments[0].url, { headers: { Cookie: author } });
    assert.equal(download.status, 200, await download.clone().text());
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  } finally { await cleanup(f); }
});
