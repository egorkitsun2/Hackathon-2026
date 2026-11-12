import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createApp } from '../src/index.js'
import { migrate, openDatabase } from '../src/db.js'
import { digest, hashPassword } from '../src/security.js'

const origin = 'http://localhost:8787'
async function fixture() {
  const db = openDatabase(':memory:'); migrate(db)
  const now = new Date().toISOString(), hash = await hashPassword(randomBytes(24).toString('base64url'))
  let phoneId = 0
  function user(role: string) {
    const id = Number(db.prepare(`INSERT INTO users(phone,full_name,department,position,password_hash,role,created_at)
      VALUES (?, 'Test user', 'Test', 'Test', ?, ?, ?)`).run(`+7700${String(++phoneId).padStart(7, '0')}`, hash, role, now).lastInsertRowid)
    const token = randomBytes(32).toString('base64url')
    db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
      .run(digest(token), id, now, new Date(Date.now() + 3600000).toISOString())
    return { id, cookie: `team_voice_session=${token}` }
  }
  const admin = user('admin'), employee = user('employee'), manager = user('manager'), other = user('manager')
  const ids: Record<string, number> = {}
  for (const [prefix, assignee] of [['empty', null], ['assigned', manager.id]] as const) {
    for (const status of ['new', 'in_review', 'resolved', 'rejected']) {
      const id = Number(db.prepare(`INSERT INTO tickets(author_id,type,title,description,status,category,assigned_to,created_at,updated_at)
        VALUES (?,'problem','Existing request','Existing request description',?,'it',?,?,?)`).run(employee.id, status, assignee, now, now).lastInsertRowid)
      ids[`${prefix}_${status}`] = id
      const event = db.prepare('INSERT INTO ticket_events(ticket_id,actor_id,old_status,new_status,comment,created_at) VALUES (?,?,?,?,?,?)')
      event.run(id, employee.id, null, 'new', null, now)
      if (status !== 'new') event.run(id, admin.id, 'new', 'in_review', null, now)
      if (status === 'resolved' || status === 'rejected') event.run(id, admin.id, 'in_review', status, 'Existing decision', now)
    }
  }
  const app = await createApp({ db, origin })
  const request = (path: string, method = 'GET', body?: unknown, cookie: string | undefined = admin.cookie) => app.request(`/api/v1${path}`, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : { Origin: origin }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  async function queue(query = '') {
    const response = await request(`/admin/tickets${query}`)
    assert.equal(response.status, 200, await response.clone().text())
    return await response.json() as { data: { id: number; assigned_to: number | null; needs_reassignment: boolean }[]; pagination: { total: number } }
  }
  return { db, request, queue, ids, admin, employee, manager, other }
}
function sortedIds(rows: { id: number }[]) { return rows.map(row => row.id).sort((a, b) => a - b) }

test('blocking and reactivation update the flag without changing assignments or history', async () => {
  const f = await fixture()
  try {
    const beforeTickets = f.db.prepare('SELECT * FROM tickets ORDER BY id').all()
    const beforeEvents = f.db.prepare('SELECT * FROM ticket_events ORDER BY id').all()
    const initial = await f.queue()
    for (const row of initial.data) assert.equal(row.needs_reassignment, [f.ids.empty_new, f.ids.empty_in_review].includes(row.id))
    assert.equal((await f.request(`/admin/users/${f.manager.id}`, 'PATCH', { is_active: false })).status, 200)
    const blocked = await f.queue()
    const expected = [f.ids.empty_new, f.ids.empty_in_review, f.ids.assigned_new, f.ids.assigned_in_review]
    for (const row of blocked.data) {
      assert.equal(typeof row.needs_reassignment, 'boolean')
      assert.equal(row.needs_reassignment, expected.includes(row.id))
    }
    assert.deepEqual(sortedIds((await f.queue('?needs_reassignment=true')).data), expected.sort((a, b) => a - b))
    assert.equal((await f.request(`/admin/users/${f.manager.id}`, 'PATCH', { is_active: true })).status, 200)
    assert.deepEqual(sortedIds((await f.queue('?needs_reassignment=true')).data), [f.ids.empty_new, f.ids.empty_in_review].sort((a, b) => a - b))
    assert.equal((await f.request('/auth/me', 'GET', undefined, f.manager.cookie)).status, 401)
    assert.deepEqual(f.db.prepare('SELECT * FROM tickets ORDER BY id').all(), beforeTickets)
    assert.deepEqual(f.db.prepare('SELECT * FROM ticket_events ORDER BY id').all(), beforeEvents)
  } finally { f.db.close() }
})

test('reassignment filter composes with pagination, status and the unchanged unassigned filter', async () => {
  const f = await fixture()
  try {
    await f.request(`/admin/users/${f.manager.id}`, 'PATCH', { is_active: false })
    const all = await f.queue(), disabled = await f.queue('?needs_reassignment=false')
    assert.deepEqual(disabled, all)
    const page1 = await f.queue('?needs_reassignment=true&limit=1&page=1'), page2 = await f.queue('?needs_reassignment=true&limit=1&page=2')
    assert.equal(page1.pagination.total, 4); assert.equal(page2.pagination.total, 4)
    assert.equal(page1.data.length, 1); assert.equal(page2.data.length, 1); assert.notEqual(page1.data[0].id, page2.data[0].id)
    assert.deepEqual(sortedIds((await f.queue('?needs_reassignment=true&status=in_review')).data), [f.ids.empty_in_review, f.ids.assigned_in_review])
    for (const status of ['resolved', 'rejected']) assert.equal((await f.queue(`?needs_reassignment=true&status=${status}`)).pagination.total, 0)
    const empty = await f.queue('?unassigned=true')
    assert.equal(empty.pagination.total, 4)
    assert.deepEqual(sortedIds(empty.data), Object.entries(f.ids).filter(([key]) => key.startsWith('empty_')).map(([, id]) => id).sort((a, b) => a - b))
    assert.deepEqual(sortedIds((await f.queue('?unassigned=true&needs_reassignment=true')).data), [f.ids.empty_new, f.ids.empty_in_review])
    for (const value of ['yes', '1', 'TRUE', '']) {
      const response = await f.request(`/admin/tickets?needs_reassignment=${value}`)
      assert.equal(response.status, 400)
      assert.equal((await response.json() as any).error.details.needs_reassignment, 'EXPECTED_BOOLEAN')
    }
    for (const cookie of [f.employee.cookie, f.other.cookie]) {
      assert.equal((await f.request('/admin/tickets?needs_reassignment=true', 'GET', undefined, cookie)).status, 403)
    }
    assert.equal((await f.request('/admin/tickets?needs_reassignment=true', 'GET', undefined, '')).status, 401)
    for (const [path, cookie] of [['/tickets', f.employee.cookie], ['/manager/tickets', f.other.cookie]]) {
      const response = await f.request(path, 'GET', undefined, cookie)
      assert.equal(response.status, 200)
      for (const row of (await response.json() as any).data) assert.equal(Object.hasOwn(row, 'needs_reassignment'), false)
    }
  } finally { f.db.close() }
})

test('manual reassignment clears the flag and blocked routing still creates unassigned tickets', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.request('/admin/routing/it', 'PATCH', { manager_id: f.manager.id })).status, 200)
    assert.equal((await f.request(`/admin/users/${f.manager.id}`, 'PATCH', { is_active: false })).status, 200)
    const original = f.ids.assigned_new
    assert.equal((await f.queue()).data.find(row => row.id === original)!.assigned_to, f.manager.id)
    const beforeEvents = f.db.prepare('SELECT * FROM ticket_events WHERE ticket_id = ?').all(original)
    const assigned = await f.request(`/admin/tickets/${original}/assignment`, 'PATCH', { assigned_to: f.other.id })
    assert.equal(assigned.status, 200)
    const current = (await f.queue()).data.find(row => row.id === original)!
    assert.equal(current.assigned_to, f.other.id); assert.equal(current.needs_reassignment, false)
    assert.ok(!(await f.queue('?needs_reassignment=true')).data.some(row => row.id === original))
    assert.deepEqual(f.db.prepare('SELECT * FROM ticket_events WHERE ticket_id = ?').all(original), beforeEvents)
    const created = await f.request('/tickets', 'POST', { type: 'problem', title: 'New IT request', description: 'The IT equipment needs repair', category: 'it' }, f.employee.cookie)
    assert.equal(created.status, 201)
    const ticket = (await created.json() as any).data
    assert.equal(ticket.assigned_to, null)
    assert.equal((await f.queue()).data.find(row => row.id === ticket.id)!.needs_reassignment, true)
  } finally { f.db.close() }
})
