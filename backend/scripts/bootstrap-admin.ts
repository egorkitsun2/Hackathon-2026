import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { defaultDatabasePath, migrate, openDatabase } from '../src/db.js'
import { accountProfile, bootstrapAdmin } from '../src/accounts.js'
import type { AccountProfile } from '../src/accounts.js'
import { normalizePhone } from '../src/security.js'
import { ApiError, text } from '../src/validation.js'

const usage = 'Usage: npm run bootstrap:admin [-- --phone <phone> --full-name <name> --department <department> --position <position>]'
const fields = [
  ['phone', 'phone', 'Administrator phone (+7...): '],
  ['full-name', 'full_name', 'Full name: '],
  ['department', 'department', 'Department: '],
  ['position', 'position', 'Position: '],
] as const

// The iterator buffers pasted/piped lines too; consecutive readline.question calls would lose them.
export async function readBootstrapProfile(args: string[], input: Readable = process.stdin,
  output: Writable = process.stdout): Promise<AccountProfile | null> {
  const { values } = parseArgs({ args, options: { phone: { type: 'string' }, 'full-name': { type: 'string' },
    department: { type: 'string' }, position: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: false, strict: true })
  if (values.help) { output.write(`${usage}\nOmit fields to enter them one by one. The password is generated, never requested.\n`); return null }
  const profile: Record<string, string> = {}
  const missing = fields.some(([flag]) => values[flag] === undefined)
  const terminal = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY)
  const reader = missing ? createInterface({ input, output, terminal }) : undefined
  const lines = reader?.[Symbol.asyncIterator]()
  reader?.on('SIGINT', () => reader.close())
  try {
    for (const [flag, field, prompt] of fields) {
      let value = values[flag]
      while (true) {
        if (value === undefined) {
          output.write(prompt)
          const line = await lines!.next()
          if (line.done) throw new Error('Input ended before all administrator fields were provided; no account was created.')
          value = line.value
        }
        try {
          if (field === 'phone') {
            const phone = value.length <= 64 ? normalizePhone(value) : null
            if (!phone) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid phone')
            profile[field] = phone
          } else profile[field] = text(value, field, 1, 120)
          break
        } catch (error) {
          if (!(error instanceof ApiError) || values[flag] !== undefined) throw error
          output.write(field === 'phone' ? 'Enter a valid Kazakhstan phone number.\n' : 'Enter 1-120 nonblank characters.\n')
          value = undefined
        }
      }
    }
    return accountProfile(profile)
  } finally { reader?.close() }
}

async function main() {
  const profile = await readBootstrapProfile(process.argv.slice(2))
  if (!profile) return
  const db = openDatabase(process.env.DATABASE_PATH ?? defaultDatabasePath)
  const credentialsPath = fileURLToPath(new URL('../.local/bootstrap-admin.json', import.meta.url))
  try {
    migrate(db)
    await bootstrapAdmin(db, profile, credentialsPath)
    console.log(`First administrator created. Credentials saved to ${credentialsPath} (Git-ignored); keep this file private.`)
  } finally { db.close() }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    if (error instanceof ApiError) console.error('Invalid administrator profile; check the CLI arguments.')
    else if (error instanceof Error && (error.message.includes('bootstrap refused') || error.message.startsWith('Input ended'))) console.error(error.message)
    else console.error('Administrator bootstrap failed; check arguments, database access and whether .local/bootstrap-admin.json already exists. Use --help for usage. No credentials were printed.')
    process.exitCode = 1
  })
}
