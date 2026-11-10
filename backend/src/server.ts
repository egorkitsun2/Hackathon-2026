import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp } from './index.js'
import { defaultDatabasePath, migrate, openDatabase } from './db.js'

const production = process.env.NODE_ENV === 'production'
const port = Number(process.env.PORT ?? 8787)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
const origin = process.env.APP_ORIGIN ?? (production ? '' : `http://localhost:${port}`)
if (!origin) throw new Error('APP_ORIGIN is required in production')
const host = process.env.HOST ?? '127.0.0.1'
const db = openDatabase(process.env.DATABASE_PATH ?? defaultDatabasePath)
try {
  migrate(db)
  const app = await createApp({ db, origin, production })
  // Optional existing frontend build; never serve the repository or private data directory.
  if (process.env.FRONTEND_DIR) {
    const root = resolve(process.env.FRONTEND_DIR)
    if (!statSync(root).isDirectory() || !existsSync(resolve(root, 'index.html'))) {
      throw new Error('FRONTEND_DIR must contain a frontend build with index.html')
    }
    const assets = serveStatic({ root })
    app.get('*', (c, next) => c.req.path === '/api' || c.req.path.startsWith('/api/') ? next() : assets(c, next))
  }
  const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
    console.log(`Team Voice listening on ${host}:${port}; trusted origin ${origin}`)
  })
  server.once('error', (error: NodeJS.ErrnoException) => {
    db.close()
    if (error.code === 'EADDRINUSE') {
      console.error(`Cannot start Team Voice: ${host}:${port} is already in use.`)
      console.error('Stop the previous local server (including old Wrangler), or set PORT and APP_ORIGIN to a free port before restarting.')
    } else {
      console.error(`Cannot start Team Voice: ${error.code ?? 'LISTEN_FAILED'}.`)
    }
    process.exit(1)
  })
  const stop = () => {
    server.close(() => { db.close(); process.exit(0) })
    setTimeout(() => process.exit(1), 10000).unref()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  db.close()
  throw error
}
