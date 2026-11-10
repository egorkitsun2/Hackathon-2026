import { defaultDatabasePath, migrate, openDatabase } from '../src/db.js'
const db = openDatabase(process.env.DATABASE_PATH ?? defaultDatabasePath)
try { migrate(db); console.log('SQLite migrations applied') } finally { db.close() }
