import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { openDatabase, migrate } from '../src/db.js'
import { createApp } from '../src/index.js'
import { digest, hashPassword, verifyPassword } from '../src/security.js'

const origin = 'http://localhost:8787'
const keys = ['created_at', 'department', 'full_name', 'id', 'is_active', 'must_change_password', 'phone', 'position', 'role'].sort()
const secret = () => randomBytes(24).toString('base64url')
async function fixture() {
  const db = openDatabase(':memory:'); migrate(db)
  const adminPassword = secret(), employeePassword = secret()
  const adminHash = await hashPassword(adminPassword), employeeHash = await hashPassword(employeePassword)
  const insert = db.prepare(`INSERT INTO users (phone, full_name, department, position, password_hash, role, is_active, must_change_password, created_at) VALUES (?, ?, 'Office', 'Worker', ?, ?, 1, 0, ?)`)
  const adminId = Number(insert.run('+77001110001', 'Admin', adminHash, 'admin', new Date().toISOString()).lastInsertRowid)
  const employeeId = Number(insert.run('+77001110002', 'Employee', employeeHash, 'employee', new Date().toISOString()).lastInsertRowid)
  const app = await createApp({ db, origin })
  function session(id: number) {
    const token = randomBytes(32).toString('base64url')
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(digest(token), id, new Date().toISOString(), new Date(Date.now() + 3600000).toISOString())
    return `team_voice_session=${token}`
  }
  return { db, app, adminId, employeeId, adminPassword, employeePassword, admin: session(adminId), employee: session(employeeId), session }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function request(f: Fixture, path: string, options: { cookie?: string; origin?: string; body?: unknown; method?: string } = {}) {
  const headers = new Headers()
  if (options.cookie) headers.set('Cookie', options.cookie)
  if (options.origin !== undefined) headers.set('Origin', options.origin)
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')
  return f.app.request(`/api/v1${path}`, { method: options.method ?? 'POST', headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
}
const reset = (f: Fixture, id: number | string, body?: unknown, cookie = f.admin, requestOrigin = origin) => request(f, `/admin/users/${id}/reset-password`, { cookie, origin: requestOrigin, body })
async function error(res: Response, status: number, code: string) {
  assert.equal(res.status, status, await res.clone().text())
  assert.equal((await res.json() as any).error.code, code)
}
async function success(res: Response) {
  assert.equal(res.status, 200, await res.clone().text())
  assert.equal(res.headers.get('Cache-Control'), 'no-store')
  const payload = await res.json() as any
  assert.deepEqual(Object.keys(payload), ['data'])
  assert.deepEqual(Object.keys(payload.data).sort(), ['temporary_password', 'user'])
  assert.deepEqual(Object.keys(payload.data.user).sort(), keys)
  assert.match(payload.data.temporary_password, /^[A-Za-z0-9_-]{32}$/)
  assert.equal(Buffer.from(payload.data.temporary_password, 'base64url').length, 24)
  return payload.data as { user: { id: number; is_active: boolean; must_change_password: boolean }; temporary_password: string }
}
async function login(f: Fixture, password: string) {
  return request(f, '/auth/login', { origin, body: { phone: '+77001110002', password } })
}
function cookie(res: Response) { const value = res.headers.get('set-cookie'); assert.ok(value); return value.split(';')[0] }

test('reset invalidates credentials and sessions until the employee changes the temporary password', async () => {
  const f = await fixture()
  try {
    const otherSession = f.session(f.employeeId)
    const before = f.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(f.employeeId) as any
    const messages: string[] = []
    const originalLog = console.log, originalError = console.error
    console.log = (...args: unknown[]) => { messages.push(args.map(String).join(' ')) }
    console.error = (...args: unknown[]) => { messages.push(args.map(String).join(' ')) }
    let response: Response
    try { response = await reset(f, f.employeeId) } finally { console.log = originalLog; console.error = originalError }
    const data = await success(response)
    assert.ok(!messages.join('\n').includes(data.temporary_password))
    assert.equal(data.user.id, f.employeeId); assert.equal(data.user.is_active, true); assert.equal(data.user.must_change_password, true)
    const row = f.db.prepare('SELECT password_hash, must_change_password FROM users WHERE id = ?').get(f.employeeId) as any
    assert.match(row.password_hash, /^\$argon2id\$/); assert.notEqual(row.password_hash, before.password_hash)
    assert.equal(row.must_change_password, 1); assert.ok(await verifyPassword(row.password_hash, data.temporary_password))
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?').get(f.employeeId) as any).n, 0)
    for (const old of [f.employee, otherSession]) await error(await request(f, '/auth/me', { method: 'GET', cookie: old }), 401, 'UNAUTHORIZED')
    await error(await login(f, f.employeePassword), 401, 'INVALID_CREDENTIALS')
    const signedIn = await login(f, data.temporary_password); assert.equal(signedIn.status, 200); assert.equal(signedIn.headers.get('X-Password-Change-Required'), 'true')
    const temporarySession = cookie(signedIn)
    await error(await request(f, '/tickets', { method: 'GET', cookie: temporarySession }), 403, 'PASSWORD_CHANGE_REQUIRED')
    const newPassword = secret()
    const changed = await request(f, '/auth/change-password', { cookie: temporarySession, origin, body: { current_password: data.temporary_password, new_password: newPassword } })
    assert.equal(changed.status, 200, await changed.clone().text())
    const tickets = await request(f, '/tickets', { method: 'GET', cookie: cookie(changed) }); assert.equal(tickets.status, 200)
    const serialized = JSON.stringify(f.db.prepare('SELECT * FROM users').all())
    assert.ok(!serialized.includes(data.temporary_password))
    const list = await request(f, '/admin/users', { method: 'GET', cookie: f.admin })
    assert.ok(!(await list.text()).includes(data.temporary_password))
  } finally { f.db.close() }
})

test('authorization, origin, validation and disabled employees', async () => {
  const f = await fixture()
  try {
    await error(await request(f, `/admin/users/${f.employeeId}/reset-password`, { origin }), 401, 'UNAUTHORIZED')
    await error(await reset(f, f.employeeId, undefined, f.employee), 403, 'FORBIDDEN')
    await error(await reset(f, f.employeeId, undefined, f.admin, 'http://evil.example'), 403, 'INVALID_ORIGIN')
    await error(await reset(f, 'invalid'), 404, 'NOT_FOUND')
    await error(await reset(f, 99999), 404, 'NOT_FOUND')
    await error(await reset(f, f.adminId), 403, 'FORBIDDEN')
    const otherAdmin = Number(f.db.prepare(`INSERT INTO users (phone,full_name,department,position,password_hash,role,created_at)
      SELECT '+77001110003',full_name,department,position,password_hash,'admin',created_at FROM users WHERE id = ?`).run(f.adminId).lastInsertRowid)
    await error(await reset(f, otherAdmin), 403, 'FORBIDDEN')
    await error(await request(f, `/admin/users/${f.employeeId}/reset-password`, { cookie: f.admin }), 403, 'INVALID_ORIGIN')
    await error(await reset(f, f.employeeId, { password: 'chosen' }), 400, 'VALIDATION_ERROR')
    f.db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(f.employeeId)
    const result = await success(await reset(f, f.employeeId, {}))
    assert.equal(result.user.is_active, false); assert.equal(result.user.must_change_password, true)
    await error(await login(f, result.temporary_password), 403, 'ACCOUNT_DISABLED')
    assert.equal((f.db.prepare('SELECT is_active FROM users WHERE id = ?').get(f.employeeId) as any).is_active, 0)
  } finally { f.db.close() }
})

test('sequential resets replace the prior temporary password and overlapping resets conflict', async () => {
  const f = await fixture()
  try {
    const first = await success(await reset(f, f.employeeId, {}))
    const second = await success(await reset(f, f.employeeId))
    assert.notEqual(first.temporary_password, second.temporary_password)
    await error(await login(f, first.temporary_password), 401, 'INVALID_CREDENTIALS')
    const loginSecond = await login(f, second.temporary_password); assert.equal(loginSecond.status, 200)
    const [a, b] = await Promise.all([reset(f, f.employeeId), reset(f, f.employeeId)])
    assert.deepEqual([a.status, b.status].sort(), [200, 409])
    const winner = await success(a.status === 200 ? a : b)
    await error(a.status === 409 ? a : b, 409, 'PASSWORD_CHANGED')
    await error(await request(f, '/auth/me', { method: 'GET', cookie: cookie(loginSecond) }), 401, 'UNAUTHORIZED')
    assert.equal((await login(f, winner.temporary_password)).status, 200)
  } finally { f.db.close() }
})

test('failure deleting sessions rolls back the password and preserves sessions', async () => {
  const f = await fixture()
  try {
    const before = f.db.prepare('SELECT password_hash, must_change_password FROM users WHERE id = ?').get(f.employeeId)
    f.db.exec(`CREATE TRIGGER fail_reset_delete BEFORE DELETE ON sessions WHEN OLD.user_id = ${f.employeeId} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`)
    const response = await reset(f, f.employeeId)
    assert.equal(response.status, 500)
    assert.deepEqual(f.db.prepare('SELECT password_hash, must_change_password FROM users WHERE id = ?').get(f.employeeId), before)
    assert.equal((await request(f, '/auth/me', { method: 'GET', cookie: f.employee })).status, 200)
    assert.equal((await login(f, f.employeePassword)).status, 200)
  } finally { f.db.close() }
})


// Mutate after the pre-hash snapshot is returned, before Argon2 can complete.
test('authority and target role are rechecked after hashing', async () => {
  for (const scenario of ['revoked', 'demoted', 'blocked', 'must-change', 'promoted', 'deleted'] as const) {
    const f = await fixture()
    try {
      const original = f.db.prepare.bind(f.db)
      let observed = false
      ;(f.db as any).prepare = (sql: string) => {
        const statement = original(sql)
        if (sql.trim() !== 'SELECT * FROM users WHERE id = ?' || observed) return statement
        return new Proxy(statement, { get(target, property) {
          if (property === 'get') return (...args: any[]) => {
            const result = (target.get as any)(...args)
            if (Number(args[0]) === f.employeeId && !observed) {
              observed = true
              queueMicrotask(() => {
                if (scenario === 'revoked') original('DELETE FROM sessions WHERE user_id = ?').run(f.adminId)
                if (scenario === 'demoted') original("UPDATE users SET role = 'employee' WHERE id = ?").run(f.adminId)
                if (scenario === 'blocked') original('UPDATE users SET is_active = 0 WHERE id = ?').run(f.adminId)
                if (scenario === 'must-change') original('UPDATE users SET must_change_password = 1 WHERE id = ?').run(f.adminId)
                if (scenario === 'promoted') original("UPDATE users SET role = 'admin' WHERE id = ?").run(f.employeeId)
                if (scenario === 'deleted') original('DELETE FROM users WHERE id = ?').run(f.employeeId)
              })
            }
            return result
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        } })
      }
      const response = await reset(f, f.employeeId)
      assert.ok(observed, `snapshot not observed for ${scenario}`)
      const expected = scenario === 'revoked' ? [401, 'UNAUTHORIZED'] : scenario === 'deleted' ? [404, 'NOT_FOUND'] : scenario === 'blocked' ? [403, 'ACCOUNT_DISABLED'] : scenario === 'must-change' ? [403, 'PASSWORD_CHANGE_REQUIRED'] : [403, 'FORBIDDEN']
      await error(response, expected[0] as number, expected[1] as string)
      if (scenario !== 'deleted') {
        const row = original('SELECT password_hash, must_change_password FROM users WHERE id = ?').get(f.employeeId) as any
        assert.equal(row.must_change_password, 0)
        assert.ok(await verifyPassword(row.password_hash, f.employeePassword))
        assert.equal((original('SELECT count(*) AS n FROM sessions WHERE user_id = ?').get(f.employeeId) as any).n, 1)
      }
    } finally { f.db.close() }
  }
})

test('shared password work limit rejects excess concurrent resets', async () => {
  const f = await fixture()
  try {
    const results = await Promise.all([reset(f, f.employeeId), reset(f, f.employeeId), reset(f, f.employeeId)])
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 503])
  } finally { f.db.close() }
})
