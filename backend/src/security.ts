import { createHash, randomBytes } from 'node:crypto'
import { argon2id, hash, verify } from 'argon2'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './db.js'

export const SESSION_SECONDS = 8 * 60 * 60
export const PASSWORD_OPTIONS = { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1, hashLength: 32 }
export const hashPassword = (password: string): Promise<string> => hash(password, PASSWORD_OPTIONS)
export const verifyPassword = (encoded: string, password: string): Promise<boolean> => verify(encoded, password)
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export const newSessionToken = (): string => randomBytes(32).toString('base64url')

export function normalizePhone(value: string): string | null {
  if (!/^[+\d\s()-]+$/.test(value)) return null
  let digits = value.replace(/[\s()-]/g, '')
  if (digits.startsWith('+')) digits = digits.slice(1)
  if (/^8\d{10}$/.test(digits)) digits = `7${digits.slice(1)}`
  if (/^[67]\d{9}$/.test(digits)) digits = `7${digits}`
  return /^7[67]\d{9}$/.test(digits) ? `+${digits}` : null
}

// Both buckets are charged atomically before expensive hashing, including successful logins.
export function allowLogin(db: DatabaseSync, phone: string, ip: string): boolean {
  const now = Date.now()
  const windowMs = 15 * 60 * 1000
  return transaction(db, () => {
    db.prepare('DELETE FROM login_attempts WHERE window_start <= ?').run(now - windowMs)
    const buckets = [[digest(`phone:${phone}`), 5], [digest(`ip:${ip}`), 60]] as const
    for (const [bucket, maximum] of buckets) {
      const row = db.prepare('SELECT attempts FROM login_attempts WHERE bucket = ?').get(bucket)
      if (row && Number(row.attempts) >= maximum) return false
    }
    for (const [bucket] of buckets) {
      db.prepare(`INSERT INTO login_attempts (bucket, window_start, attempts) VALUES (?, ?, 1)
        ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1`).run(bucket, now)
    }
    return true
  })
}
