import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { defaultDatabasePath, migrate, openDatabase } from '../src/db.js'
import { bootstrapAdmin } from '../src/accounts.js'
import { ApiError } from '../src/validation.js'

async function main() {
  const { values } = parseArgs({ options: { phone: { type: 'string' }, 'full-name': { type: 'string' },
    department: { type: 'string' }, position: { type: 'string' } }, allowPositionals: false, strict: true })
  if (!values.phone || !values['full-name'] || !values.department || !values.position) {
    throw new Error('Usage: npm run bootstrap:admin -- --phone <phone> --full-name <name> --department <department> --position <position>')
  }
  const db = openDatabase(process.env.DATABASE_PATH ?? defaultDatabasePath)
  const credentialsPath = fileURLToPath(new URL('../.local/bootstrap-admin.json', import.meta.url))
  try {
    migrate(db)
    await bootstrapAdmin(db, { phone: values.phone, full_name: values['full-name'], department: values.department,
      position: values.position }, credentialsPath)
    console.log(`First administrator created. Credentials saved to ${credentialsPath} (Git-ignored); keep this file private.`)
  } finally { db.close() }
}
main().catch((error: unknown) => {
  if (error instanceof ApiError) console.error('Invalid administrator profile; check the CLI arguments.')
  else if (error instanceof Error && (error.message.startsWith('Usage:') || error.message.includes('bootstrap refused'))) console.error(error.message)
  else console.error('Administrator bootstrap failed; check database access, CLI arguments and whether .local/bootstrap-admin.json already exists. No credentials were printed.')
  process.exitCode = 1
})
