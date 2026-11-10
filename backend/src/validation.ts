import type { Context } from 'hono'

export class ApiError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 415 | 429 | 503, public code: string,
    message: string, public details?: Record<string, string>) { super(message) }
}
export function invalid(details?: Record<string, string>): never {
  throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request data', details)
}

export async function jsonBody(c: Context, allowed: readonly string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json')
  }
  let value: unknown
  try { value = await c.req.json() } catch { return invalid({ body: 'INVALID_JSON' }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid({ body: 'EXPECTED_OBJECT' })
  if (Object.keys(value).some((key) => !allowed.includes(key))) return invalid({ body: 'UNKNOWN_FIELD' })
  return value as Record<string, unknown>
}

export function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.includes('\0')) return invalid({ [field]: 'INVALID_STRING' })
  const trimmed = value.trim()
  const length = Array.from(trimmed).length
  if (length < min) return invalid({ [field]: `${field.toUpperCase()}_TOO_SHORT` })
  if (length > max) return invalid({ [field]: `${field.toUpperCase()}_TOO_LONG` })
  return trimmed
}
export function ticketId(value: string): number {
  const id = Number(value)
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id)) {
    throw new ApiError(404, 'NOT_FOUND', 'Ticket not found')
  }
  return id
}
export function pagination(c: Context): {page: number; limit: number; offset: number} {
  function integer(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return invalid({ pagination: 'INVALID_INTEGER' })
    return Number(value)
  }
  const page = integer(c.req.query('page'), 1)
  const limit = Math.min(integer(c.req.query('limit'), 20), 50)
  const offset = (page - 1) * limit
  if (!Number.isSafeInteger(offset)) return invalid({ pagination: 'OUT_OF_RANGE' })
  return { page, limit, offset }
}
