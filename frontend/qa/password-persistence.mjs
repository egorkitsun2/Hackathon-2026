import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createApp } from '../../backend/src/index.ts';
import { openDatabase, migrate } from '../../backend/src/db.ts';
import { hashPassword } from '../../backend/src/security.ts';

const directory = await mkdtemp(join(tmpdir(), 'team-voice-persistence-'));
let db;
try {
  const filename = join(directory, 'test.sqlite');
  db = openDatabase(filename); migrate(db);
  const oldPassword = randomBytes(24).toString('base64url');
  const newPassword = randomBytes(24).toString('base64url');
  db.prepare("INSERT INTO users (phone, full_name, department, position, password_hash, role, is_active, created_at) VALUES ('+77000000001','QA','QA','QA',?,'employee',1,?)")
    .run(await hashPassword(oldPassword), new Date().toISOString());
  const origin = 'http://localhost:8798';
  let app = await createApp({ db, origin, attachmentsDir: join(directory, 'files') });
  let cookie;
  async function post(path, data) {
    const response = await app.request(`${origin}/api/v1${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  assert.equal((await post('/auth/login', { phone: '+77000000001', password: oldPassword })).status, 200);
  assert.equal((await post('/auth/change-password', { current_password: oldPassword, new_password: newPassword })).status, 200);
  db.close(); db = openDatabase(filename); migrate(db);
  app = await createApp({ db, origin, attachmentsDir: join(directory, 'files') });
  assert.equal((await app.request(`${origin}/api/v1/auth/me`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await post('/auth/login', { phone: '+77000000001', password: newPassword })).status, 200);
  assert.equal((await post('/auth/login', { phone: '+77000000001', password: oldPassword })).status, 401);
  console.log('PASS: changed password and session survive closing/reopening the isolated database; old password rejected.');
} finally {
  db?.close();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.match(basename(directory), /^team-voice-persistence-/);
  await rm(directory, { recursive: true, force: true });
}
