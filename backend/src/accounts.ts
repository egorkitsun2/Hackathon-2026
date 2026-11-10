import type { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { transaction } from './db.js'
import { hashPassword, normalizePhone } from './security.js'
import { ApiError, invalid, text } from './validation.js'
import type { User } from './types.js'

export interface AccountProfile { phone: string; full_name: string; department: string; position: string }
export function accountProfile(body: Record<string, unknown>): AccountProfile {
  const phone = typeof body.phone === 'string' && body.phone.length <= 64 ? normalizePhone(body.phone) : null
  if (!phone) return invalid({ phone: 'INVALID_PHONE' })
  return { phone, full_name: text(body.full_name, 'full_name', 1, 120),
    department: text(body.department, 'department', 1, 120), position: text(body.position, 'position', 1, 120) }
}
export const temporaryPassword = (): string => randomBytes(24).toString('base64url')
export const employeeView = (user: User) => ({ id: user.id, phone: user.phone, full_name: user.full_name,
  department: user.department, position: user.position, role: user.role, is_active: Boolean(user.is_active),
  must_change_password: Boolean(user.must_change_password), created_at: user.created_at })

export async function bootstrapAdmin(db: DatabaseSync, input: AccountProfile, credentialsPath: string): Promise<void> {
  const profile = accountProfile({ ...input })
  const ensureAvailable = () => {
    // Any administrator, including a disabled one, prevents bootstrap from creating another.
    if (db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get()) throw new Error('An administrator already exists; bootstrap refused')
    if (db.prepare('SELECT id FROM users WHERE phone = ?').get(profile.phone)) throw new Error('Phone already belongs to an existing account; bootstrap refused')
  }
  ensureAvailable()
  const password = temporaryPassword()
  const passwordHash = await hashPassword(password)
  mkdirSync(dirname(credentialsPath), { recursive: true, mode: 0o700 })
  let descriptor: number | undefined
  let createdFile: { dev: bigint; ino: bigint } | undefined
  let committed = false
  try {
    transaction(db, () => {
      // Recheck under a database write lock, so concurrent bootstrap processes cannot both succeed.
      ensureAvailable()
      const now = new Date().toISOString()
      const result = db.prepare(`INSERT INTO users (phone, full_name, department, position, password_hash, role,
        is_active, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, 'admin', 1, 0, ?)`)
        .run(profile.phone, profile.full_name, profile.department, profile.position, passwordHash, now)
      descriptor = openSync(credentialsPath, 'wx', 0o600)
      createdFile = fstatSync(descriptor, { bigint: true })
      writeFileSync(descriptor, JSON.stringify({ user: { id: Number(result.lastInsertRowid), ...profile, role: 'admin' }, password }, null, 2) + '\n')
      fsyncSync(descriptor)
    })
    committed = true
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (!committed && createdFile) {
      // Clean up partial writes and failed COMMITs, but never a pre-existing or replaced file.
      let current
      try { current = lstatSync(credentialsPath, { bigint: true }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (current?.isFile() && current.dev === createdFile.dev && current.ino === createdFile.ino) unlinkSync(credentialsPath)
    }
  }
}

export function newPassword(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') ||
    Array.from(value).length < 12 || Array.from(value).length > 128 || Buffer.byteLength(value) > 1024) {
    return invalid({ new_password: 'PASSWORD_LENGTH_12_128' })
  }
  return value
}
export function userId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ApiError(404, 'NOT_FOUND', 'Employee not found')
  return Number(value)
}
