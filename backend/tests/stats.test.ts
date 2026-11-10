import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createApp } from '../src/index.js'
import { migrate, openDatabase } from '../src/db.js'
import { digest, hashPassword, SESSION_SECONDS } from '../src/security.js'

async function fixture() {
  const db = openDatabase(':memory:')
  migrate(db)
  const passwordHash = await hashPassword(randomBytes(24).toString('base64url'))
  const now = new Date().toISOString()
  function user(role: 'admin' | 'employee', active = 1, mustChange = 0) {
    const id = Number(db.prepare(`INSERT INTO users (phone, full_name, department, position, password_hash,
      role, is_active, must_change_password, created_at) VALUES (?, 'Stats user', 'Test', 'Test', ?, ?, ?, ?, ?)`)
      .run(`+7700${String(Number(db.prepare('SELECT count(*) AS n FROM users').get()!.n) + 1).padStart(7, '0')}`,
        passwordHash, role, active, mustChange, now).lastInsertRowid)
    const token = randomBytes(32).toString('base64url')
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(digest(token), id, now, new Date(Date.now() + SESSION_SECONDS * 1000).toISOString())
    return { id, cookie: `team_voice_session=${token}` }
  }
  const admin = user('admin')
  const app = await createApp({ db, origin: 'http://localhost:8787' })
  const request = (cookie?: string) => app.request('/api/v1/admin/stats', { headers: cookie ? { Cookie: cookie } : {} })
  return { db, admin, user, request, now }
}

const zero = { employees: { total: 0, active: 0 }, tickets: { total: 0, new: 0, in_review: 0, resolved: 0, rejected: 0 } }

test('admin stats returns numeric zeroes with no employees or tickets', async () => {
  const f = await fixture()
  try {
    const response = await f.request(f.admin.cookie)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { data: zero })
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  } finally { f.db.close() }
})

test('admin stats enforces authentication, current role, activation and password state', async () => {
  const f = await fixture()
  async function denied(cookie: string | undefined, status: number, code: string) {
    const response = await f.request(cookie)
    assert.equal(response.status, status)
    assert.equal((await response.json() as { error: { code: string } }).error.code, code)
  }
  try {
    await denied(undefined, 401, 'UNAUTHORIZED')
    await denied(f.user('employee').cookie, 403, 'FORBIDDEN')
    await denied(f.user('admin', 0).cookie, 403, 'ACCOUNT_DISABLED')
    await denied(f.user('admin', 1, 1).cookie, 403, 'PASSWORD_CHANGE_REQUIRED')
    f.db.prepare("UPDATE users SET role = 'employee' WHERE id = ?").run(f.admin.id)
    await denied(f.admin.cookie, 403, 'FORBIDDEN')
    f.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(f.admin.id)
    f.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(f.admin.id)
    await denied(f.admin.cookie, 401, 'UNAUTHORIZED')
  } finally { f.db.close() }
})

test('admin stats counts actual employee and ticket rows and reflects subsequent changes without writing data', async () => {
  const f = await fixture()
  try {
    const active = f.user('employee')
    const blocked = f.user('employee', 0)
    f.user('employee', 1, 1) // An active employee awaiting password change still counts as active.
    f.user('admin') // Administrators never contribute to employee totals.
    const insert = f.db.prepare(`INSERT INTO tickets (author_id, type, title, description, status, created_at, updated_at)
      VALUES (?, 'problem', 'Stats ticket', 'Actual SQLite fixture ticket.', ?, ?, ?)`)
    const ids: number[] = []
    for (const status of ['new', 'new', 'in_review', 'resolved', 'rejected']) {
      ids.push(Number(insert.run(status === 'rejected' ? blocked.id : active.id, status, f.now, f.now).lastInsertRowid))
    }
    // Multiple audit events must never inflate counts of tickets.
    for (const [oldStatus, newStatus] of [[null, 'new'], ['new', 'in_review'], ['in_review', 'resolved']]) {
      f.db.prepare(`INSERT INTO ticket_events (ticket_id, actor_id, old_status, new_status, comment, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(ids[3]!, f.admin.id, oldStatus!, newStatus!, newStatus === 'resolved' ? 'Fixed for testing' : null, f.now)
    }
    const snapshot = () => JSON.stringify(['users', 'tickets', 'ticket_events', 'sessions', 'login_attempts', 'schema_migrations']
      .map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()))
    const before = snapshot()
    const response = await f.request(f.admin.cookie)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { data: {
      employees: { total: 3, active: 2 }, tickets: { total: 5, new: 2, in_review: 1, resolved: 1, rejected: 1 },
    } })
    assert.equal(snapshot(), before)
    f.db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(blocked.id)
    f.db.prepare("UPDATE tickets SET status = 'resolved' WHERE id = ?").run(ids[2]!)
    const afterMutation = snapshot()
    const refreshed = await f.request(f.admin.cookie)
    assert.equal(refreshed.status, 200)
    assert.deepEqual(await refreshed.json(), { data: {
      employees: { total: 3, active: 3 }, tickets: { total: 5, new: 2, in_review: 0, resolved: 2, rejected: 1 },
    } })
    assert.equal(snapshot(), afterMutation)
  } finally { f.db.close() }
})
