import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

test('occupied port gives an actionable startup error without an unhandled exception', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'team-voice-startup-'))
  const holder = createServer()
  try {
    holder.listen(0, '127.0.0.1')
    await once(holder, 'listening')
    const address = holder.address()
    assert.ok(address && typeof address === 'object')
    const port = String(address.port)
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: port,
        APP_ORIGIN: `http://localhost:${port}`, DATABASE_PATH: join(directory, 'test.sqlite'), FRONTEND_DIR: '' },
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /already in use/)
    assert.match(result.stderr, /PORT and APP_ORIGIN/)
    assert.doesNotMatch(result.stderr, /Unhandled|node:events|at Server\./)
    assert.doesNotMatch(result.stdout, /Team Voice listening/)
  } finally {
    if (holder.listening) await new Promise<void>((done, reject) => holder.close((error) => error ? reject(error) : done()))
    // Remove only the unique directory this test created directly beneath the temp root.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('team-voice-startup-'))
    rmSync(directory, { recursive: true, force: true })
  }
})
