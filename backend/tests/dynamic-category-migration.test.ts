import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { migrate, openDatabase } from '../src/db.js'
const migrations = fileURLToPath(new URL('../migrations/', import.meta.url))
function fixture(db: DatabaseSync) {
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY)')
  for (const name of readdirSync(migrations).filter(n => /^000[1-5]_.*\.sql$/.test(n)).sort()) {
    db.exec(readFileSync(join(migrations, name), 'utf8'))
    db.prepare('INSERT INTO schema_migrations VALUES (?)').run(name)
  }
  db.exec(`INSERT INTO users(id,phone,full_name,department,position,password_hash,role,created_at,must_change_password)
    VALUES (1,'1','Name','Dept','Role','hash','admin','now',1), (2,'2','Manager','Dept','Role','hash','manager','now',0);
    INSERT INTO sessions VALUES ('${'a'.repeat(64)}',1,'now','later');
    INSERT INTO tickets(id,author_id,type,title,description,status,created_at,updated_at,category,assigned_to)
    VALUES (1,1,'problem','Title','Description','in_review','now','later','it',2), (90,1,'problem','Title','Description','new','now','now','general',NULL);
    DELETE FROM tickets WHERE id=90;
    INSERT INTO ticket_events(ticket_id,actor_id,new_status,created_at) VALUES (1,2,'in_review','now');
    INSERT INTO ticket_attachments(ticket_id,storage_key,original_name,mime_type,size_bytes,created_at) VALUES (1,'${'b'.repeat(64)}','image.png','image/png',1,'now');
    UPDATE category_routing SET manager_id=2 WHERE category='it';`)
}
const tables = ['users', 'sessions', 'tickets', 'ticket_events', 'ticket_attachments', 'category_routing']
const contents = (db: DatabaseSync) => Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT * FROM ${t}`).all()]))
function removeTemp(directory: string) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
  assert.match(basename(resolve(directory)), /^team-voice-006-[a-zA-Z0-9]+$/)
  rmSync(directory, { recursive: true, force: true })
}
test('006 preserves populated data, WAL snapshot, child references and sequence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-voice-006-'))
  const db = openDatabase(join(dir, 'fixture.sqlite'))
  try {
    fixture(db)
    const attachment = join(dir, 'attachment.bin'); writeFileSync(attachment, 'unchanged')
    const before = contents(db)
    migrate(db)
    assert.deepEqual(contents(db), before)
    assert.equal(readFileSync(attachment, 'utf8'), 'unchanged')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.deepEqual(db.prepare('SELECT code,name_ru,name_kz FROM categories ORDER BY id').all().map(r => ({...r})), [
      {code:'it',name_ru:'IT',name_kz:'IT'}, {code:'procurement',name_ru:'Закупки',name_kz:'Сатып алу'}, {code:'general',name_ru:'Администрация',name_kz:'Әкімшілік'},
    ])
    const backups = readdirSync(dir).filter(n => n.startsWith('.team-voice-backup-'))
    assert.equal(backups.length, 1)
    const backup = new DatabaseSync(join(dir, backups[0], 'before-0006.sqlite'), { readOnly: true })
    try {
      assert.deepEqual(contents(backup), before)
      assert.equal(backup.prepare("SELECT count(*) n FROM schema_migrations WHERE name LIKE '0006%'").get()!.n, 0)
      assert.equal(backup.prepare("SELECT count(*) n FROM sqlite_master WHERE name='categories'").get()!.n, 0)
    } finally { backup.close() }
    migrate(db)
    assert.equal(readdirSync(dir).filter(n => n.startsWith('.team-voice-backup-')).length, 1)
    db.exec("INSERT INTO categories(code,name_ru,name_kz) VALUES ('custom','Custom','Custom'); INSERT INTO category_routing(category) VALUES ('custom')")
    const inserted = db.prepare("INSERT INTO tickets(author_id,type,title,description,created_at,updated_at,category) VALUES (1,'problem','Title','Description','now','now','custom')").run()
    assert.equal(Number(inserted.lastInsertRowid), 91)
    assert.throws(() => db.exec("UPDATE categories SET is_active=0 WHERE code='general'"), /CHECK constraint/)
    assert.throws(() => db.exec("UPDATE categories SET code='changed' WHERE code='custom'"), /immutable/)
    assert.throws(() => db.exec("DELETE FROM categories WHERE code='custom'"), /FOREIGN KEY constraint/)
    assert.throws(() => db.exec('DELETE FROM tickets WHERE id=1'), /FOREIGN KEY constraint/)
  } finally { db.close(); removeTemp(dir) }
})
test('006 foreign key failure rolls back schema and data and restores enforcement', () => {
  const db = openDatabase(':memory:')
  try {
    fixture(db)
    db.exec("PRAGMA foreign_keys=OFF; INSERT INTO sessions VALUES ('" + 'c'.repeat(64) + "',999,'now','later'); PRAGMA foreign_keys=ON")
    const before = contents(db)
    assert.throws(() => migrate(db), /Migration foreign key check failed/)
    assert.deepEqual(contents(db), before)
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='categories'").get()!.n, 0)
    assert.equal(db.prepare("SELECT count(*) n FROM schema_migrations WHERE name LIKE '0006%'").get()!.n, 0)
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1)
    assert.throws(() => db.exec('DELETE FROM tickets WHERE id=1'), /FOREIGN KEY constraint/)
  } finally { db.close() }
})
test('006 backup failure prevents schema changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-voice-006-'))
  const db = openDatabase(join(dir, 'fixture.sqlite'))
  try {
    fixture(db)
    const before = contents(db)
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      if (sql.startsWith('VACUUM main INTO')) throw new Error('simulated backup failure')
      return prepare(sql)
    }) as typeof db.prepare
    assert.throws(() => migrate(db), /simulated backup failure/)
    assert.deepEqual(contents(db), before)
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='categories'").get()!.n, 0)
    assert.equal(db.prepare("SELECT count(*) n FROM schema_migrations WHERE name LIKE '0006%'").get()!.n, 0)
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1)
  } finally { db.close(); removeTemp(dir) }
})
