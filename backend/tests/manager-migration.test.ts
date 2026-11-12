import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { migrate, openDatabase } from '../src/db.js'
const migrations = fileURLToPath(new URL('../migrations/', import.meta.url))
function oldSchema(db: DatabaseSync) {
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY)')
  for (const name of readdirSync(migrations).filter(n => /^000[1-4]_.*\.sql$/.test(n)).sort()) {
    db.exec(readFileSync(join(migrations, name), 'utf8'))
    db.prepare('INSERT INTO schema_migrations VALUES (?)').run(name)
  }
}
function populate(db: DatabaseSync) {
  db.exec(`INSERT INTO users(id,phone,full_name,department,position,password_hash,role,created_at,must_change_password)
    VALUES (1,'1','Name','Dept','Role','secret-hash','admin','now',1), (99,'99','Deleted','Dept','Role','x','employee','now',0);
    DELETE FROM users WHERE id=99;
    INSERT INTO sessions VALUES ('${'a'.repeat(64)}',1,'now','later');
    INSERT INTO tickets(id,author_id,type,title,description,created_at,updated_at) VALUES (1,1,'problem','Title','Description','now','now');
    INSERT INTO ticket_events(ticket_id,actor_id,new_status,created_at) VALUES (1,1,'new','now');
    INSERT INTO ticket_attachments(ticket_id,storage_key,original_name,mime_type,size_bytes,created_at) VALUES (1,'${'b'.repeat(64)}','image.png','image/png',1,'now');`)
}
function removeTemp(path: string) {
  assert.equal(dirname(resolve(path)), resolve(tmpdir()))
  assert.match(basename(path), /^team-voice-migration-/)
  rmSync(path, { recursive: true, force: true })
}
test('file migration preserves data and creates a WAL-consistent backup once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-voice-migration-'))
  const db = openDatabase(join(dir, 'fixture.sqlite'))
  try {
    oldSchema(db); populate(db)
    const attachment = join(dir, 'attachment.bin'); writeFileSync(attachment, 'unchanged')
    const tables = ['users', 'sessions', 'tickets', 'ticket_events', 'ticket_attachments']
    const before = Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT * FROM ${t}`).all()]))
    migrate(db)
    for (const t of tables.filter(t => t !== 'tickets')) assert.deepEqual(db.prepare(`SELECT * FROM ${t}`).all(), before[t])
    const ticket = db.prepare('SELECT * FROM tickets').get()!
    assert.deepEqual({ ...ticket, category: undefined, assigned_to: undefined }, { ...before.tickets[0], category: undefined, assigned_to: undefined })
    assert.equal(ticket.category, 'general'); assert.equal(ticket.assigned_to, null)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(readFileSync(attachment, 'utf8'), 'unchanged')
    assert.equal(db.prepare('SELECT count(*) AS n FROM category_routing WHERE manager_id IS NULL').get()!.n, 3)
    const manager = db.prepare("INSERT INTO users(phone,full_name,department,position,password_hash,role,created_at) VALUES ('2','Manager','D','P','h','manager','now')").run()
    assert.equal(Number(manager.lastInsertRowid), 100)
    assert.throws(() => db.exec("UPDATE tickets SET category='bad'"), /FOREIGN KEY constraint/)
    assert.throws(() => db.exec('UPDATE tickets SET assigned_to=999'), /FOREIGN KEY constraint/)
    const backups = readdirSync(dir).filter(n => n.startsWith('.team-voice-backup-'))
    assert.equal(backups.length, 2)
    const backupDir = backups.find(n => readdirSync(join(dir, n)).includes('before-0005.sqlite'))!
    const backup = new DatabaseSync(join(dir, backupDir, 'before-0005.sqlite'), { readOnly: true })
    try {
      assert.deepEqual(backup.prepare('SELECT * FROM users').all(), before.users)
      assert.deepEqual(backup.prepare('SELECT * FROM tickets').all(), before.tickets)
      assert.equal(backup.prepare("SELECT count(*) AS n FROM schema_migrations WHERE name LIKE '0005%'").get()!.n, 0)
    } finally { backup.close() }
    migrate(db)
    assert.equal(readdirSync(dir).filter(n => n.startsWith('.team-voice-backup-')).length, 2)
  } finally { db.close(); removeTemp(dir) }
})
test('foreign-key violations roll back the rebuild and restore enforcement', () => {
  const db = openDatabase(':memory:')
  try {
    oldSchema(db); populate(db)
    db.exec("PRAGMA foreign_keys=OFF; INSERT INTO sessions VALUES ('" + 'c'.repeat(64) + "',999,'now','later'); PRAGMA foreign_keys=ON;")
    assert.throws(() => migrate(db), /Migration foreign key check failed/)
    assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE name LIKE '0005%'").get()!.n, 0)
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1)
    assert.equal(db.prepare("SELECT count(*) AS n FROM pragma_table_info('tickets') WHERE name='category'").get()!.n, 0)
    assert.throws(() => db.exec("INSERT INTO users(phone,full_name,department,position,password_hash,role,created_at) VALUES ('3','M','D','P','h','manager','now')"), /CHECK constraint/)
  } finally { db.close() }
})

test('backup failure aborts before migration changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-voice-migration-'))
  const db = openDatabase(join(dir, 'fixture.sqlite'))
  try {
    oldSchema(db); populate(db)
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      if (sql.startsWith('VACUUM main INTO')) throw new Error('simulated backup failure')
      return prepare(sql)
    }) as typeof db.prepare
    assert.throws(() => migrate(db), /simulated backup failure/)
    assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE name LIKE '0005%'").get()!.n, 0)
    assert.equal(db.prepare("SELECT count(*) AS n FROM pragma_table_info('tickets') WHERE name='category'").get()!.n, 0)
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1)
  } finally { db.close(); removeTemp(dir) }
})

test('concurrent migration scripts succeed against the same old file', async () => {
  const { spawn } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'team-voice-migration-'))
  const filename = join(dir, 'fixture.sqlite')
  const db = openDatabase(filename)
  try {
    oldSchema(db); populate(db)
    const cwd = fileURLToPath(new URL('../', import.meta.url))
    const run = () => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
        cwd, env: { ...process.env, DATABASE_PATH: filename }, windowsHide: true,
      })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('close', code => resolve({ code, stderr }))
    })
    const results = await Promise.all([run(), run()])
    for (const result of results) assert.equal(result.code, 0, result.stderr)
    assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE name LIKE '0005%'").get()!.n, 1)
    assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE name LIKE '0006%'").get()!.n, 1)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(db.prepare('SELECT password_hash FROM users WHERE id=1').get()!.password_hash, 'secret-hash')
  } finally { db.close(); removeTemp(dir) }
})

test('database paths in a configured public directory are rejected before opening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-voice-migration-'))
  const previous = process.env.FRONTEND_DIR
  try {
    const filename = join(dir, 'existing.sqlite')
    writeFileSync(filename, 'original file')
    process.env.FRONTEND_DIR = dir
    assert.throws(() => openDatabase(filename), /outside the public frontend/)
    assert.equal(readFileSync(filename, 'utf8'), 'original file')
    assert.deepEqual(readdirSync(dir), ['existing.sqlite'])
    assert.throws(() => openDatabase(join(dir, 'nested', 'new.sqlite')), /outside the public frontend/)
    assert.deepEqual(readdirSync(dir), ['existing.sqlite'])
  } finally {
    if (previous === undefined) delete process.env.FRONTEND_DIR
    else process.env.FRONTEND_DIR = previous
    removeTemp(dir)
  }
})

test('migration inside a caller transaction fails without deleting dependent rows', () => {
  const db = openDatabase(':memory:')
  try {
    oldSchema(db); populate(db)
    db.exec('BEGIN')
    assert.throws(() => migrate(db), /transaction/i)
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1)
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()!.n, 1)
    assert.equal(db.prepare('SELECT count(*) AS n FROM tickets').get()!.n, 1)
    db.exec('ROLLBACK')
  } finally { db.close() }
})
