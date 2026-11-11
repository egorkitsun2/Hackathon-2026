import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie, setCookie } from 'hono/cookie'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { transaction } from './db.js'
import { AttachmentStorage, attachmentView, defaultAttachmentsDir, MAX_ATTACHMENTS } from './attachments.js'
import type { AttachmentRow } from './attachments.js'
import { accountProfile, employeeView, newPassword, temporaryPassword, userId } from './accounts.js'
import { allowLogin, digest, hashPassword, newSessionToken, normalizePhone, SESSION_SECONDS, verifyPassword } from './security.js'
import { ApiError, invalid, jsonBody, pagination, text, ticketId } from './validation.js'
import type { AppEnv, Role, Ticket, TicketStatus, User } from './types.js'

const statuses = ['new', 'in_review', 'resolved', 'rejected']
const ticketTypes = ['problem', 'suggestion', 'complaint', 'gratitude']
const publicUser = (user: User) => ({ id: user.id, full_name: user.full_name, phone: user.phone,
  department: user.department, position: user.position, role: user.role })
const publicTicket = (ticket: Ticket) => ({ id: ticket.id, type: ticket.type, title: ticket.title,
  description: ticket.description, status: ticket.status, created_at: ticket.created_at, updated_at: ticket.updated_at })

export interface AppOptions { db: DatabaseSync; origin: string; production?: boolean; attachmentsDir?: string; frontendDir?: string }

export async function createApp({ db, origin, production = false, attachmentsDir, frontendDir }: AppOptions) {
  const url = new URL(origin)
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || (production && url.protocol !== 'https:')) {
    throw new Error('APP_ORIGIN must be an exact origin; production requires HTTPS')
  }
  const app = new Hono<AppEnv>()
  const attachmentStorage = new AttachmentStorage(attachmentsDir ?? defaultAttachmentsDir, db, frontendDir)
  if (attachmentsDir !== undefined) await attachmentStorage.initialize()
  const cookieName = production ? '__Host-team_voice_session' : 'team_voice_session'
  const cookieOptions = { httpOnly: true, secure: production, sameSite: 'Lax' as const, path: '/' }
  // Unknown users pay the same Argon2 cost as known users. Never store a dummy password in Git.
  const dummyHash = await hashPassword(randomBytes(32).toString('base64url'))
  let activeVerifications = 0
  async function passwordWork<T>(work: () => Promise<T>): Promise<T> {
    if (activeVerifications >= 2) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Please retry shortly')
    activeVerifications++
    try { return await work() } finally { activeVerifications-- }
  }
  function clientIp(c: Context): string {
    if (c.env && typeof c.env === 'object' && 'incoming' in c.env) return getConnInfo(c).remote.address ?? 'unknown'
    return 'local'
  }
  function passwordChangeHeader(c: Context, user: User) {
    c.header('X-Password-Change-Required', user.must_change_password ? 'true' : 'false')
  }

  const isAttachmentUpload = (c: Context) => c.req.method === 'POST' && /^\/api\/v1\/tickets\/[^/]+\/attachments$/.test(c.req.path)
  app.use('/api/*', async (c, next) => {
    // Also close uploads rejected by Origin/session checks before their body is consumed.
    if (isAttachmentUpload(c)) c.header('Connection', 'close')
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Cross-Origin-Resource-Policy', 'same-origin')
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method) && c.req.header('origin') !== origin) {
      throw new ApiError(403, 'INVALID_ORIGIN', 'Invalid request origin')
    }
    await next()
  })
  const jsonLimit = bodyLimit({ maxSize: 32768,
    onError: (c) => c.json({ error: { code: 'VALIDATION_ERROR', message: 'Request body too large' } }, 400) })
  app.use('/api/*', (c, next) => {
    // Only the specific upload route bypasses the JSON buffer; its receiver enforces streaming limits.
    if (isAttachmentUpload(c)) return next()
    return jsonLimit(c, next)
  })

  function sessionUser(tokenHash: string, role?: Role, allowPasswordChange = false): User {
    const user = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash, new Date().toISOString()) as unknown as User | undefined
    if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required')
    if (!user.is_active) throw new ApiError(403, 'ACCOUNT_DISABLED', 'Account disabled')
    if (role && user.role !== role) throw new ApiError(403, 'FORBIDDEN', 'Access denied')
    if (!allowPasswordChange && user.must_change_password) {
      throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your password before continuing')
    }
    return user
  }
  const authenticated = (role?: Role, allowPasswordChange = false): MiddlewareHandler<AppEnv> => async (c, next) => {
    const token = getCookie(c, cookieName)
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required')
    const tokenHash = digest(token)
    c.set('user', sessionUser(tokenHash, role, allowPasswordChange))
    c.set('tokenHash', tokenHash)
    await next()
  }

  app.get('/api/v1/health', (c) => {
    try {
      const result = db.prepare('SELECT 1 AS ok').get()
      if (result?.ok !== 1) throw new Error('Unavailable')
      return c.json({ data: { status: 'ok', database: 'ok' } })
    } catch {
      return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' } }, 503)
    }
  })

  app.post('/api/v1/auth/login', async (c) => {
    const body = await jsonBody(c, ['phone', 'password'])
    const phone = typeof body.phone === 'string' && body.phone.length <= 64 ? normalizePhone(body.phone) : null
    if (!phone) return invalid({ phone: 'INVALID_PHONE' })
    if (typeof body.password !== 'string' || body.password.length < 1 || Buffer.byteLength(body.password) > 1024) {
      return invalid({ password: 'INVALID_PASSWORD' })
    }
    // Use the socket peer only; client-supplied forwarding headers are not trusted.
    const ip = clientIp(c)
    if (!allowLogin(db, phone, ip)) {
      c.header('Retry-After', '900')
      throw new ApiError(429, 'RATE_LIMITED', 'Too many login attempts')
    }
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone) as unknown as User | undefined
    const valid = await passwordWork(() => verifyPassword(user?.password_hash ?? dummyHash, body.password as string))
    if (!valid || !user) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid phone or password')
    const token = newSessionToken()
    const now = new Date()
    const current = transaction(db, () => {
      // Password/activation may change while Argon2 runs or in another process.
      const current = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as unknown as User | undefined
      if (!current || current.password_hash !== user.password_hash) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid phone or password')
      if (!current.is_active) throw new ApiError(403, 'ACCOUNT_DISABLED', 'Account disabled')
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString())
      const previous = getCookie(c, cookieName)
      if (previous) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(previous))
      db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(digest(token), current.id, now.toISOString(), new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString())
      return current
    })
    setCookie(c, cookieName, token, { ...cookieOptions, maxAge: SESSION_SECONDS, expires: new Date(now.getTime() + SESSION_SECONDS * 1000) })
    passwordChangeHeader(c, current)
    return c.json({ data: { user: publicUser(current) } })
  })

  app.get('/api/v1/auth/me', authenticated(undefined, true), (c) => {
    passwordChangeHeader(c, c.get('user'))
    return c.json({ data: { user: publicUser(c.get('user')) } })
  })
  app.post('/api/v1/auth/logout', authenticated(undefined, true), (c) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(c.get('tokenHash'))
    setCookie(c, cookieName, '', { ...cookieOptions, maxAge: 0, expires: new Date(0) })
    return c.body(null, 204)
  })

  app.post('/api/v1/auth/change-password', authenticated(undefined, true), async (c) => {
    const body = await jsonBody(c, ['current_password', 'new_password'])
    if (typeof body.current_password !== 'string' || !body.current_password.length || Buffer.byteLength(body.current_password) > 1024) {
      return invalid({ current_password: 'INVALID_PASSWORD' })
    }
    const password = newPassword(body.new_password)
    if (body.current_password === password) return invalid({ new_password: 'PASSWORD_MUST_DIFFER' })
    const user = c.get('user')
    if (!allowLogin(db, `password-change:${user.id}`, clientIp(c))) {
      c.header('Retry-After', '900')
      throw new ApiError(429, 'RATE_LIMITED', 'Too many password change attempts')
    }
    const passwordHash = await passwordWork(async () => {
      if (!await verifyPassword(user.password_hash, body.current_password as string)) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid current password')
      }
      return hashPassword(password)
    })
    const token = newSessionToken()
    const now = new Date()
    const current = transaction(db, () => {
      const current = sessionUser(c.get('tokenHash'), undefined, true)
      if (current.password_hash !== user.password_hash) throw new ApiError(409, 'PASSWORD_CHANGED', 'Password already changed; sign in again')
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(passwordHash, user.id)
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id)
      db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(digest(token), user.id, now.toISOString(), new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString())
      return { ...current, must_change_password: 0 }
    })
    setCookie(c, cookieName, token, { ...cookieOptions, maxAge: SESSION_SECONDS, expires: new Date(now.getTime() + SESSION_SECONDS * 1000) })
    passwordChangeHeader(c, current)
    return c.json({ data: { user: publicUser(current) } })
  })

  app.get('/api/v1/admin/stats', authenticated('admin'), (c) => {
    // One read statement provides a consistent snapshot, including zeroes on empty tables.
    const counts = db.prepare(`SELECT
      (SELECT count(*) FROM users WHERE role = 'employee') AS employees_total,
      (SELECT count(*) FROM users WHERE role = 'employee' AND is_active = 1) AS employees_active,
      count(*) AS tickets_total,
      count(CASE WHEN status = 'new' THEN 1 END) AS tickets_new,
      count(CASE WHEN status = 'in_review' THEN 1 END) AS tickets_in_review,
      count(CASE WHEN status = 'resolved' THEN 1 END) AS tickets_resolved,
      count(CASE WHEN status = 'rejected' THEN 1 END) AS tickets_rejected
      FROM tickets`).get()!
    return c.json({ data: {
      employees: { total: Number(counts.employees_total), active: Number(counts.employees_active) },
      tickets: { total: Number(counts.tickets_total), new: Number(counts.tickets_new),
        in_review: Number(counts.tickets_in_review), resolved: Number(counts.tickets_resolved), rejected: Number(counts.tickets_rejected) },
    } })
  })

  app.post('/api/v1/admin/users', authenticated('admin'), async (c) => {
    const body = await jsonBody(c, ['phone', 'full_name', 'department', 'position'])
    const profile = accountProfile(body)
    const password = temporaryPassword()
    const passwordHash = await passwordWork(() => hashPassword(password))
    const user = transaction(db, () => {
      sessionUser(c.get('tokenHash'), 'admin')
      if (db.prepare('SELECT id FROM users WHERE phone = ?').get(profile.phone)) throw new ApiError(409, 'PHONE_EXISTS', 'Phone already in use')
      const result = db.prepare(`INSERT INTO users (phone, full_name, department, position, password_hash, role,
        is_active, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, 'employee', 1, 1, ?)`)
        .run(profile.phone, profile.full_name, profile.department, profile.position, passwordHash, new Date().toISOString())
      return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as User
    })
    // The temporary password is returned exactly once, only to the authenticated administrator.
    return c.json({ data: { user: employeeView(user), temporary_password: password } }, 201)
  })
  app.get('/api/v1/admin/users', authenticated('admin'), (c) => {
    const { page, limit, offset } = pagination(c)
    return c.json(transaction(db, () => {
      const total = Number(db.prepare("SELECT count(*) AS total FROM users WHERE role = 'employee'").get()!.total)
      const users = db.prepare(`SELECT id, phone, full_name, department, position, role, is_active, must_change_password, created_at
        FROM users WHERE role = 'employee' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(limit, offset) as unknown as User[]
      return { data: users.map(employeeView), pagination: { page, limit, total } }
    }))
  })
  app.patch('/api/v1/admin/users/:id', authenticated('admin'), async (c) => {
    const id = userId(c.req.param('id'))
    const body = await jsonBody(c, ['is_active'])
    if (typeof body.is_active !== 'boolean') return invalid({ is_active: 'EXPECTED_BOOLEAN' })
    const user = transaction(db, () => {
      sessionUser(c.get('tokenHash'), 'admin')
      const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'employee'").get(id) as unknown as User | undefined
      if (!user) throw new ApiError(404, 'NOT_FOUND', 'Employee not found')
      db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(body.is_active ? 1 : 0, id)
      if (!body.is_active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
      return { ...user, is_active: body.is_active ? 1 : 0 }
    })
    return c.json({ data: { user: employeeView(user) } })
  })

  function listTickets(userId: number | null, page: number, limit: number, offset: number, status?: string) {
    const where = userId !== null ? 'WHERE t.author_id = ?' : status ? 'WHERE t.status = ?' : ''
    const args = userId !== null ? [userId] : status ? [status] : []
    // The only dynamic SQL fragments are the fixed expressions above. All inputs are bound.
    return transaction(db, () => {
      const total = Number(db.prepare(`SELECT count(*) AS total FROM tickets t ${where}`).get(...args)!.total)
      const rows = db.prepare(`SELECT t.id, t.type, t.title, t.status, t.created_at, t.updated_at,
        u.id AS author_id, u.full_name, u.department, u.position FROM tickets t
        JOIN users u ON u.id = t.author_id ${where}
        ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset)
      const data = rows.map((row) => ({ id: row.id, type: row.type, title: row.title, status: row.status,
        created_at: row.created_at, updated_at: row.updated_at,
        ...(userId === null ? { author: { id: row.author_id, full_name: row.full_name,
          department: row.department, position: row.position } } : {}) }))
      return { data, pagination: { page, limit, total } }
    })
  }
  app.get('/api/v1/tickets', authenticated('employee'), (c) => {
    const { page, limit, offset } = pagination(c)
    return c.json(listTickets(c.get('user').id, page, limit, offset))
  })
  app.get('/api/v1/admin/tickets', authenticated('admin'), (c) => {
    const { page, limit, offset } = pagination(c)
    const status = c.req.query('status')
    if (status !== undefined && !statuses.includes(status)) return invalid({ status: 'INVALID_STATUS' })
    return c.json(listTickets(null, page, limit, offset, status))
  })
  app.post('/api/v1/tickets', authenticated('employee'), async (c) => {
    const body = await jsonBody(c, ['type', 'title', 'description'])
    if (typeof body.type !== 'string' || !ticketTypes.includes(body.type)) return invalid({ type: 'INVALID_TYPE' })
    const title = text(body.title, 'title', 5, 120)
    const description = text(body.description, 'description', 10, 4000)
    const authorId = c.get('user').id
    const now = new Date().toISOString()
    const ticket = transaction(db, () => {
      sessionUser(c.get('tokenHash'), 'employee')
      const result = db.prepare(`INSERT INTO tickets (author_id, type, title, description, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'new', ?, ?)`).run(authorId, body.type as string, title, description, now, now)
      const id = Number(result.lastInsertRowid)
      db.prepare(`INSERT INTO ticket_events (ticket_id, actor_id, old_status, new_status, comment, created_at)
        VALUES (?, ?, NULL, 'new', NULL, ?)`).run(id, authorId, now)
      return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as unknown as Ticket
    })
    return c.json({ data: publicTicket(ticket) }, 201)
  })

  function attachmentTicket(id: number, user: User, upload = false): Ticket {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as unknown as Ticket | undefined
    if (!ticket || (user.role !== 'admin' && ticket.author_id !== user.id)) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found')
    if (upload && ticket.author_id !== user.id) throw new ApiError(403, 'FORBIDDEN', 'Only the ticket author can upload attachments')
    if (upload && ticket.status !== 'new') throw new ApiError(409, 'ATTACHMENTS_LOCKED', 'Attachments are allowed only for new tickets')
    return ticket
  }
  function attachmentQuota(id: number) {
    const count = Number(db.prepare('SELECT count(*) AS total FROM ticket_attachments WHERE ticket_id = ?').get(id)!.total)
    if (count >= MAX_ATTACHMENTS) throw new ApiError(409, 'ATTACHMENT_LIMIT_REACHED', 'At most three attachments per ticket')
  }
  app.post('/api/v1/tickets/:id/attachments', authenticated(), async (c) => {
    const id = ticketId(c.req.param('id'))
    attachmentTicket(id, c.get('user'), true)
    attachmentQuota(id)
    const file = await attachmentStorage.receive(c.req.raw)
    let committed = false
    try {
      if (c.req.raw.signal.aborted) throw new ApiError(400, 'UPLOAD_ABORTED', 'Upload interrupted')
      const row = transaction(db, () => {
        attachmentTicket(id, sessionUser(c.get('tokenHash')), true)
        attachmentQuota(id)
        attachmentStorage.publish(file)
        const created = db.prepare(`INSERT INTO ticket_attachments
          (ticket_id, storage_key, original_name, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(id, file.key, file.originalName, file.mime, file.size, new Date().toISOString())
        return db.prepare('SELECT * FROM ticket_attachments WHERE id = ?').get(Number(created.lastInsertRowid)) as unknown as AttachmentRow
      })
      committed = true
      return c.json({ data: attachmentView(row) }, 201)
    } finally { if (!committed) await attachmentStorage.discard(file) }
  })
  app.get('/api/v1/tickets/:id/attachments/:attachmentId', authenticated(), async (c) => {
    const id = ticketId(c.req.param('id'))
    const attachmentId = ticketId(c.req.param('attachmentId'))
    attachmentTicket(id, c.get('user'))
    const row = db.prepare('SELECT * FROM ticket_attachments WHERE id = ? AND ticket_id = ?').get(attachmentId, id) as unknown as AttachmentRow | undefined
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Attachment not found')
    return attachmentStorage.download(row, () => { attachmentTicket(id, sessionUser(c.get('tokenHash'))) })
  })

  app.get('/api/v1/tickets/:id', authenticated(), (c) => {
    const id = ticketId(c.req.param('id'))
    const user = c.get('user')
    return c.json(transaction(db, () => {
      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as unknown as Ticket | undefined
      if (!ticket || (user.role !== 'admin' && ticket.author_id !== user.id)) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found')
      const author = user.role === 'admin' ? db.prepare('SELECT id, full_name, department, position FROM users WHERE id = ?').get(ticket.author_id) : undefined
      const events = db.prepare(`SELECT e.id, e.old_status, e.new_status, e.comment, e.created_at,
        u.id AS actor_id, u.full_name AS actor_name, u.role AS actor_role FROM ticket_events e
        JOIN users u ON u.id = e.actor_id WHERE e.ticket_id = ? ORDER BY e.id ASC`).all(id).map((row) => ({
          id: row.id, actor: { id: row.actor_id, full_name: row.actor_name, role: row.actor_role },
          old_status: row.old_status, new_status: row.new_status, comment: row.comment, created_at: row.created_at }))
      const attachments = (db.prepare('SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY id ASC').all(id) as unknown as AttachmentRow[]).map(attachmentView)
      return { data: { ...publicTicket(ticket), ...(author ? { author } : {}), events, attachments } }
    }))
  })

  app.patch('/api/v1/admin/tickets/:id', authenticated('admin'), async (c) => {
    const id = ticketId(c.req.param('id'))
    const body = await jsonBody(c, ['status', 'comment'])
    if (typeof body.status !== 'string' || !statuses.includes(body.status)) return invalid({ status: 'INVALID_STATUS' })
    const nextStatus = body.status as TicketStatus
    const comment = body.comment === undefined ? null : text(body.comment, 'comment', 5, 2000)
    if (['resolved', 'rejected'].includes(nextStatus) && !comment) return invalid({ comment: 'COMMENT_REQUIRED' })
    const result = transaction(db, () => {
      sessionUser(c.get('tokenHash'), 'admin')
      // Read the status only after taking the write lock. Concurrent decisions cannot share an old status.
      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as unknown as Ticket | undefined
      if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found')
      if (!((ticket.status === 'new' && nextStatus === 'in_review') ||
        (ticket.status === 'in_review' && ['resolved', 'rejected'].includes(nextStatus)))) {
        throw new ApiError(409, 'INVALID_TRANSITION', 'Invalid status transition')
      }
      const now = new Date().toISOString()
      db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus, now, id)
      const inserted = db.prepare(`INSERT INTO ticket_events (ticket_id, actor_id, old_status, new_status, comment, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, c.get('user').id, ticket.status, nextStatus, comment, now)
      return { id, status: nextStatus, updated_at: now, event: { id: Number(inserted.lastInsertRowid),
        old_status: ticket.status, new_status: nextStatus, comment, created_at: now } }
    })
    return c.json({ data: result })
  })

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404))
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message,
      ...(error.details ? { details: error.details } : {}) } }, error.status)
    // SQL errors, request data, stack traces and credentials never enter responses or logs.
    console.error('Unexpected API error')
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
  })
  return app
}
