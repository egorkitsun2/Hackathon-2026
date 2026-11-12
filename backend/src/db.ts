import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const defaultDatabasePath = fileURLToPath(new URL('../data/team-voice.sqlite', import.meta.url))

// Resolve symlinks in existing ancestors even when the database does not exist yet.
function canonicalPath(path: string): string {
  const absolute = resolve(path)
  let existing = absolute
  while (true) {
    try { return resolve(realpathSync(existing), relative(existing, absolute)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      existing = parent
    }
  }
}

function assertPrivateDatabasePath(filename: string): void {
  const publicDirs = [fileURLToPath(new URL('../../Frontend/', import.meta.url))]
  if (process.env.FRONTEND_DIR) publicDirs.push(process.env.FRONTEND_DIR)
  const inside = (parent: string, child: string) => {
    if (process.platform === 'win32') { parent = parent.toLowerCase(); child = child.toLowerCase() }
    const path = relative(parent, child)
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  }
  for (const publicDir of publicDirs) {
    if (inside(resolve(publicDir), resolve(filename)) || inside(canonicalPath(publicDir), canonicalPath(filename))) {
      throw new Error('DATABASE_PATH must be outside the public frontend directory')
    }
  }
}

export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ':memory:') {
    assertPrivateDatabasePath(filename)
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
  }
  const db = new DatabaseSync(filename)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;')
  return db
}

// All work in this callback must be synchronous: never hold a transaction across await.
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function migrate(db: DatabaseSync): void {
  const main = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')
  const filename = String(main?.file ?? '')
  if (filename) assertPrivateDatabasePath(filename)
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url))
  const names = readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()
  const rebuilds = new Set(['0005_manager_routing.sql', '0006_dynamic_categories.sql'])
  const apply = (name: string) => {
    if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(name)) return
    db.exec(readFileSync(join(directory, name), 'utf8'))
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name)
  }
  transaction(db, () => { db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)') })
  for (const name of names) {
    if (!rebuilds.has(name)) {
      transaction(db, () => apply(name))
      continue
    }
    if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(name)) continue
    if (filename) {
      // VACUUM INTO includes committed WAL data; retain a private, unique snapshot.
      const backupDirectory = mkdtempSync(join(dirname(filename), '.team-voice-backup-'))
      db.prepare('VACUUM main INTO ?').run(join(backupDirectory, `before-${name.slice(0, 4)}.sqlite`))
    }
    db.exec('PRAGMA foreign_keys = OFF')
    try {
      if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 0) throw new Error('Could not disable foreign keys for migration')
      transaction(db, () => {
        apply(name) // Recheck after acquiring the writer lock.
        const violations = db.prepare('PRAGMA foreign_key_check').all()
        if (violations.length) throw new Error(`Migration foreign key check failed: ${JSON.stringify(violations)}`)
      })
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
      if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('Could not restore foreign keys after migration')
    }
  }
}
