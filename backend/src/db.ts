import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const defaultDatabasePath = fileURLToPath(new URL('../data/team-voice.sqlite', import.meta.url))

export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
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
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url))
  transaction(db, () => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)')
    for (const name of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      if (db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(name)) continue
      db.exec(readFileSync(`${directory}/${name}`, 'utf8'))
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name)
    }
  })
}
