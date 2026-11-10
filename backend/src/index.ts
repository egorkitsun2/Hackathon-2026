import { Hono } from 'hono'
import type { Bindings } from './types'

const app = new Hono<{ Bindings: Bindings }>()

/**
 * Stage 1: health check only. Auth, tickets, and admin API will be
 * implemented after the environment and DB migration are verified.
 */
app.get('/api/v1/health', async (c) => {
  try {
    const result = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()

    if (result?.ok !== 1) {
      return c.json(
        { error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' } },
        503
      )
    }

    c.header('Cache-Control', 'no-store')
    return c.json({ data: { status: 'ok', database: 'ok' } }, 200)
  } catch (error) {
    console.error('Health check failed')
    return c.json(
      { error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' } },
      503
    )
  }
})

app.notFound((c) =>
  c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404)
)

app.onError((_error, c) => {
  console.error('Unexpected API error')
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    500
  )
})

export default app
