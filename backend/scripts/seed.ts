import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { defaultDatabasePath, migrate, openDatabase, transaction } from '../src/db.js'
import { hashPassword, normalizePhone } from '../src/security.js'

// Test accounts only. Never reset existing users or print credentials to logs.
if (process.env.NODE_ENV === 'production') throw new Error('Test seed is disabled in production')
const db = openDatabase(process.env.DATABASE_PATH ?? defaultDatabasePath)
const credentialsPath = fileURLToPath(new URL('../.local/test-accounts.json', import.meta.url))
try {
  migrate(db)
  if (Number(db.prepare('SELECT count(*) AS count FROM users').get()!.count) !== 0) {
    throw new Error('Seed requires an empty users table; existing accounts were not changed. See .local/test-accounts.json for a previous seed.')
  }
  const users = [
    { phone: '+77000000001', full_name: 'Test Employee One', department: 'Test department', position: 'Employee', role: 'employee' },
    { phone: '+77000000002', full_name: 'Test Employee Two', department: 'Test department', position: 'Employee', role: 'employee' },
    { phone: '+77000000003', full_name: 'Test Administrator', department: 'Test department', position: 'Administrator', role: 'admin' },
  ].map((user) => ({ ...user, password: randomBytes(24).toString('base64url') }))
  const hashes: string[] = []
  for (const user of users) hashes.push(await hashPassword(user.password))
  mkdirSync(dirname(credentialsPath), { recursive: true, mode: 0o700 })
  transaction(db, () => {
    // Recheck under the write lock; never race another seed into the same database.
    if (Number(db.prepare('SELECT count(*) AS count FROM users').get()!.count)) throw new Error('Database already seeded')
    users.forEach((user, index) => {
      db.prepare(`INSERT INTO users (phone, full_name, department, position, password_hash, role, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(normalizePhone(user.phone)!, user.full_name, user.department,
          user.position, hashes[index]!, user.role, new Date().toISOString())
    })
    // Exclusive create: a second seed never overwrites the previous credential file.
    writeFileSync(credentialsPath, JSON.stringify({ users }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
  console.log(`Created two employees and one admin. Credentials are in ${credentialsPath} (Git-ignored).`)
} finally { db.close() }
