import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { openDatabase, migrate } from '../src/db.js'
import { AttachmentStorage } from '../src/attachments.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'attachment-storage-test-'))
  const db = openDatabase(':memory:')
  migrate(db)
  return { root, db }
}
async function clean(f: Awaited<ReturnType<typeof fixture>>) {
  f.db.close()
  assert.equal(dirname(resolve(f.root)), resolve(tmpdir()))
  assert.match(basename(resolve(f.root)), /^attachment-storage-test-/)
  await rm(f.root, { recursive: true, force: true })
}
const key = (c: string) => c.repeat(64)

test('startup sweep removes only old unreferenced recognized files', async () => {
  const f = await fixture()
  try {
    const dir = join(f.root, 'store'), temp = join(dir, 'tmp'), files = join(dir, 'files')
    await mkdir(temp, { recursive: true }); await mkdir(files, { recursive: true })
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    const entries = [join(temp, `${key('a')}.part`), join(files, `${key('b')}.bin`), join(files, `${key('c')}.bin`), join(files, 'not-an-attachment.bin')]
    for (const path of entries) { await writeFile(path, 'x'); await utimes(path, old, old) }
    await writeFile(join(temp, `${key('d')}.part`), 'fresh')
    await writeFile(join(files, `${key('e')}.bin`), 'fresh')
    await mkdir(join(files, `${key('f')}.bin`))
    f.db.exec(`INSERT INTO users (id, phone, full_name, department, position, password_hash, role, created_at) VALUES (1, '1', 'User', 'Dept', 'Worker', 'hash', 'employee', 'now');
      INSERT INTO tickets (id, author_id, type, title, description, created_at, updated_at) VALUES (1, 1, 'problem', 'Title', 'Description', 'now', 'now');`)
    f.db.prepare("INSERT INTO ticket_attachments (ticket_id, storage_key, original_name, mime_type, size_bytes, created_at) VALUES (1, ?, 'a.png', 'image/png', 1, 'now')").run(key('c'))
    await new AttachmentStorage(dir, f.db).initialize()
    assert.deepEqual((await readdir(temp)).sort(), [`${key('d')}.part`])
    assert.deepEqual((await readdir(files)).sort(), [`${key('c')}.bin`, `${key('e')}.bin`, `${key('f')}.bin`, 'not-an-attachment.bin'].sort())
  } finally { await clean(f) }
})

test('storage and frontend cannot overlap in either direction', async () => {
  const f = await fixture()
  try {
    const frontend = join(f.root, 'frontend')
    await mkdir(frontend)
    await assert.rejects(new AttachmentStorage(join(frontend, 'private'), f.db, frontend).initialize(), /overlap/)
    await assert.rejects(new AttachmentStorage(f.root, f.db, frontend).initialize(), /overlap/)
  } finally { await clean(f) }
})

test('aborted streaming upload removes its temporary file', async () => {
  const f = await fixture()
  try {
    const dir = join(f.root, 'store'), storage = new AttachmentStorage(dir, f.db)
    await storage.initialize()
    const aborter = new AbortController()
    let paused!: () => void
    const ready = new Promise<void>(resolve => { paused = resolve })
    let step = 0
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (step++ === 0) controller.enqueue(Buffer.from('--test\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\nabc'))
      else paused()
    } })
    const request = new Request('http://localhost/upload', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test' }, body: stream, signal: aborter.signal, duplex: 'half' } as RequestInit & { duplex: 'half' })
    const pending = storage.receive(request)
    await ready
    let created = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readdir(join(dir, 'tmp'))).length) { created = true; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(created, true, 'upload must create a temporary file before abort')
    aborter.abort()
    await assert.rejects(pending)
    assert.deepEqual(await readdir(join(dir, 'tmp')), [])
    assert.deepEqual(await readdir(join(dir, 'files')), [])
  } finally { await clean(f) }
})


test('stalled upload times out and leaves no files', async t => {
  const f = await fixture()
  try {
    const dir = join(f.root, 'store'), storage = new AttachmentStorage(dir, f.db)
    await storage.initialize()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let requested!: () => void
    const ready = new Promise<void>(resolve => { requested = resolve })
    const stream = new ReadableStream<Uint8Array>({ pull() { requested() } }, { highWaterMark: 0 })
    const request = new Request('http://localhost/upload', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test' }, body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' })
    const pending = storage.receive(request)
    await ready
    t.mock.timers.tick(120000)
    await assert.rejects(pending, (error: any) => error.status === 408 && error.code === 'UPLOAD_TIMEOUT')
    assert.deepEqual(await readdir(join(dir, 'tmp')), [])
    assert.deepEqual(await readdir(join(dir, 'files')), [])
  } finally { t.mock.timers.reset(); await clean(f) }
})
