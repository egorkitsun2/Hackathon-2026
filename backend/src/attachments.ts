import Busboy from 'busboy'
import { fileTypeFromFile } from 'file-type'
import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, closeSync, openSync, renameSync } from 'node:fs'
import { lstat, mkdir, opendir, open, realpath, unlink } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Transform } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import type { DatabaseSync } from 'node:sqlite'
import { ApiError } from './validation.js'

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
export const MAX_UPLOAD_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024
export const MAX_ATTACHMENTS = 3
export const defaultAttachmentsDir = fileURLToPath(new URL('../data/team-voice.sqlite.attachments/', import.meta.url))
const defaultFrontendDir = fileURLToPath(new URL('../../frontend/', import.meta.url))
const KEY = /^[a-f0-9]{64}$/
const STALE_MS = 24 * 60 * 60 * 1000
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' }
export interface AttachmentRow {
  id: number; ticket_id: number; storage_key: string; original_name: string; mime_type: string; size_bytes: number; created_at: string
}
export const attachmentView = (row: AttachmentRow) => ({ id: row.id, original_name: row.original_name,
  mime_type: row.mime_type, size_bytes: row.size_bytes, created_at: row.created_at,
  url: `/api/v1/tickets/${row.ticket_id}/attachments/${row.id}` })
export interface ReceivedAttachment {
  key: string; originalName: string; mime: string; size: number; tempOwned: boolean; finalOwned: boolean
}
function invalidUpload(message = 'Expected exactly one file field named file') {
  return new ApiError(400, 'VALIDATION_ERROR', message)
}
function formatError() { return new ApiError(415, 'UNSUPPORTED_FILE_TYPE', 'Allowed file formats: JPG, PNG, WebP, PDF') }
function normalizeUploadError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  const code = (error as NodeJS.ErrnoException)?.code
  if (code && ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE', 'EIO'].includes(code)) {
    return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Attachment storage unavailable')
  }
  return invalidUpload('Invalid or interrupted multipart upload')
}
function inside(parent: string, child: string) {
  const part = relative(parent, child)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}
function originalFilename(name: string): string {
  if (!name || Array.from(name).length > 180 || Buffer.byteLength(name) > 255 || /[\x00-\x1f\x7f/\\:]/.test(name) || name === '.' || name === '..') {
    throw invalidUpload('Invalid filename')
  }
  if (!MIME[extname(name).toLowerCase()]) throw formatError()
  return name
}

export class AttachmentStorage {
  readonly directory: string
  private ready?: Promise<void>
  private lastSweep = 0
  private sweep?: Promise<void>
  private active = 0
  constructor(directory: string, private db: DatabaseSync, private frontendDir?: string) {
    this.directory = resolve(directory)
  }
  private path(key: string, kind: 'tmp' | 'files') {
    if (!KEY.test(key)) throw new ApiError(404, 'NOT_FOUND', 'Attachment not found')
    return join(this.directory, kind, `${key}.${kind === 'tmp' ? 'part' : 'bin'}`)
  }
  async initialize(): Promise<void> {
    if (!this.ready) this.ready = this.initializeOnce()
    return this.ready
  }
  private async initializeOnce() {
    for (const publicPath of new Set([defaultFrontendDir, ...(this.frontendDir ? [this.frontendDir] : [])])) {
      const publicDirectory = resolve(publicPath)
      if (inside(publicDirectory, this.directory) || inside(this.directory, publicDirectory)) {
        throw new Error('Attachment storage must not overlap the frontend directory')
      }
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const storage = await realpath(this.directory)
    for (const publicPath of new Set([defaultFrontendDir, ...(this.frontendDir ? [this.frontendDir] : [])])) {
      let publicDirectory: string
      try { publicDirectory = await realpath(resolve(publicPath)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (inside(publicDirectory, storage) || inside(storage, publicDirectory)) throw new Error('Attachment storage must not overlap the frontend directory')
    }
    for (const kind of ['tmp', 'files']) {
      const directory = join(this.directory, kind)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Attachment subdirectories must be private regular directories')
    }
    await this.cleanupStale()
  }
  private async cleanupStale() {
    this.lastSweep = Date.now()
    for (const kind of ['tmp', 'files'] as const) {
      const directory = await opendir(join(this.directory, kind))
      for await (const entry of directory) {
        const match = /^([a-f0-9]{64})\.(part|bin)$/.exec(entry.name)
        if (!match || !entry.isFile() || match[2] !== (kind === 'tmp' ? 'part' : 'bin')) continue
        const filename = this.path(match[1]!, kind)
        let info
        try { info = await lstat(filename) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
        if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > Date.now() - STALE_MS) continue
        // Never remove a committed file. Crash leftovers are bounded by age and periodically swept.
        if (this.db.prepare('SELECT id FROM ticket_attachments WHERE storage_key = ?').get(match[1]!)) continue
        await unlink(filename).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      }
    }
  }
  async discard(file: ReceivedAttachment) {
    if (file.finalOwned) {
      // A storage/COMMIT error can have an uncertain outcome. Never delete a file already referenced by SQLite.
      try {
        if (this.db.prepare('SELECT id FROM ticket_attachments WHERE storage_key = ?').get(file.key)) return
      } catch {
        console.error('Attachment cleanup deferred until metadata can be checked')
        return
      }
    }
    for (const [kind, owned] of [['tmp', file.tempOwned], ['files', file.finalOwned]] as const) {
      if (!owned) continue
      try { await unlink(this.path(file.key, kind)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Attachment cleanup failed; maintenance will retry')
      }
    }
  }
  publish(file: ReceivedAttachment) {
    // Reserve with exclusive creation so even a random-name collision never overwrites an existing file.
    const descriptor = openSync(this.path(file.key, 'files'), 'wx', 0o600)
    file.finalOwned = true
    closeSync(descriptor)
    renameSync(this.path(file.key, 'tmp'), this.path(file.key, 'files'))
  }
  async receive(request: Request): Promise<ReceivedAttachment> {
    if (this.active >= 4) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Too many concurrent uploads')
    this.active++
    const file: ReceivedAttachment = { key: randomBytes(32).toString('hex'), originalName: '', mime: '', size: 0, tempOwned: false, finalOwned: false }
    let success = false
    try {
      await this.initialize()
      if (Date.now() - this.lastSweep > 15 * 60 * 1000) {
        this.sweep ??= this.cleanupStale().finally(() => { this.sweep = undefined })
        await this.sweep
      }
      await this.receiveFile(request, file)
      success = true
      return file
    } finally {
      if (!success) await this.discard(file)
      this.active--
    }
  }
  private async receiveFile(request: Request, file: ReceivedAttachment) {
    const contentType = request.headers.get('content-type') ?? ''
    if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected multipart/form-data')
    const length = request.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw invalidUpload('Invalid Content-Length')
    if (length !== null && Number(length) > MAX_UPLOAD_BYTES) throw new ApiError(413, 'UPLOAD_TOO_LARGE', 'Upload body exceeds the allowed size')
    if (!request.body || request.bodyUsed || request.body.locked) throw invalidUpload()
    let parser
    try {
      parser = Busboy({ headers: { 'content-type': contentType }, preservePath: true, defParamCharset: 'utf8',
        highWaterMark: 64 * 1024, fileHwm: 64 * 1024,
        limits: { fileSize: MAX_ATTACHMENT_BYTES + 1, files: 1, fields: 0, parts: 2, headerPairs: 32 } })
    } catch { throw invalidUpload('Invalid multipart boundary') }
    const aborter = new AbortController()
    let failure: ApiError | undefined
    let rejectAborted!: (error: ApiError) => void
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject })
    void aborted.catch(() => {})
    const fail = (error: unknown) => {
      if (failure) return
      failure = normalizeUploadError(error)
      rejectAborted(failure)
      aborter.abort(failure)
      parser.destroy(failure)
    }
    const onAbort = () => fail(new ApiError(400, 'UPLOAD_ABORTED', 'Upload interrupted'))
    request.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => fail(new ApiError(408, 'UPLOAD_TIMEOUT', 'Upload timed out')), 120000)
    timer.unref()
    const reader = request.body.getReader()
    const completed = finished(parser, { cleanup: true })
    void completed.catch(() => {})
    parser.once('error', fail)
    let fileTask: Promise<void> | undefined
    let fileCount = 0
    parser.on('file', (field, stream, info) => {
      stream.on('error', () => {})
      try {
        if (++fileCount !== 1 || field !== 'file') throw invalidUpload()
        file.originalName = originalFilename(info.filename ?? '')
        file.mime = MIME[extname(file.originalName).toLowerCase()]!
        if (info.mimeType !== file.mime && info.mimeType !== 'application/octet-stream') throw formatError()
        const sink = createWriteStream(this.path(file.key, 'tmp'), { flags: 'wx', mode: 0o600, highWaterMark: 64 * 1024 })
        sink.once('open', () => { file.tempOwned = true })
        stream.once('limit', () => fail(new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds 5 MiB')))
        const counter = new Transform({ transform(chunk: Buffer, _encoding, done) {
          file.size += chunk.length
          if (file.size > MAX_ATTACHMENT_BYTES) done(new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds 5 MiB'))
          else done(null, chunk)
        } })
        fileTask = pipeline(stream, counter, sink, { signal: aborter.signal }).catch((error: unknown) => { fail(error); throw error })
        void fileTask.catch(() => {})
      } catch (error) { stream.resume(); fail(error) }
    })
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const) parser.once(event, () => fail(invalidUpload()))
    try {
      if (request.signal.aborted) onAbort()
      let bytes = 0
      for (;;) {
        const next = await Promise.race([reader.read(), aborted])
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > MAX_UPLOAD_BYTES) throw new ApiError(413, 'UPLOAD_TOO_LARGE', 'Upload body exceeds the allowed size')
        await Promise.race([new Promise<void>((resolveWrite, rejectWrite) => {
          parser.write(next.value, (error?: Error | null) => error ? rejectWrite(error) : resolveWrite())
        }), aborted])
      }
      parser.end()
      await Promise.race([completed, aborted])
      if (fileTask) await fileTask
      if (failure) throw failure
      if (fileCount !== 1 || !file.size || !file.tempOwned) throw invalidUpload()
      // Reject non-allowlisted signatures before invoking a general-purpose detector.
      const handle = await open(this.path(file.key, 'tmp'), 'r+')
      try {
        const head = Buffer.alloc(16)
        await handle.read(head, 0, 16, 0)
        const allowed = head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
          head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') || head.toString('ascii', 0, 5) === '%PDF-'
        if (!allowed) throw formatError()
        await handle.sync()
      } finally { await handle.close() }
      let detected
      try { detected = await fileTypeFromFile(this.path(file.key, 'tmp')) } catch { throw formatError() }
      if (!detected || detected.mime !== file.mime) throw formatError()
      if (failure) throw failure
    } catch (error) {
      fail(error)
      throw failure
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
      parser.destroy()
      if (fileTask) await Promise.allSettled([fileTask])
      await Promise.allSettled([completed])
      // Do not cancel/destroy the underlying HTTP request before its 4xx response can be sent.
      reader.releaseLock()
    }
  }
  async download(row: AttachmentRow, authorize: () => void): Promise<Response> {
    await this.initialize()
    const filename = this.path(row.storage_key, 'files')
    let info
    try { info = await lstat(filename) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'NOT_FOUND', 'Attachment not found')
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size !== row.size_bytes) throw new ApiError(404, 'NOT_FOUND', 'Attachment not found')
    authorize()
    return new Response(Readable.toWeb(createReadStream(filename)) as ReadableStream<Uint8Array>, { headers: {
      'Content-Type': row.mime_type, 'Content-Length': String(row.size_bytes),
      'Content-Disposition': `attachment; filename="attachment${extname(row.original_name).toLowerCase()}"; filename*=UTF-8''${encodeURIComponent(row.original_name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'no-store',
    } })
  }
}
