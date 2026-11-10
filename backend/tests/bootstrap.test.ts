import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { bootstrapAdmin } from '../src/accounts.js';
import { migrate, openDatabase } from '../src/db.js';

const profile = { phone: '+77001110001', full_name: 'Admin One', department: 'Office', position: 'Manager' };

test('bootstrap removes credentials when commit fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'team-voice-bootstrap-'));
  const db = openDatabase(':memory:');
  const credentials = join(dir, 'admin.json');
  try {
    migrate(db);
    db.exec(`CREATE TABLE bootstrap_fk_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE bootstrap_fk_child (parent_id INTEGER REFERENCES bootstrap_fk_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER bootstrap_fail_commit AFTER INSERT ON users BEGIN
        INSERT INTO bootstrap_fk_child(parent_id) VALUES (1);
      END;`);
    await assert.rejects(bootstrapAdmin(db, profile, credentials), /FOREIGN KEY constraint failed/);
    assert.equal(db.prepare('SELECT count(*) AS count FROM users').get()!.count, 0);
    assert.equal(existsSync(credentials), false, 'credentials must not survive a rolled-back bootstrap');
  } finally {
    db.close();
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.match(basename(resolve(dir)), /^team-voice-bootstrap-/);
    await rm(dir, { recursive: true, force: true });
  }
});

// Multiple piped answers can arrive in one chunk; none may be lost between prompts.
test('interactive bootstrap reads piped answers and retries an invalid phone', async () => {
  const { Readable, Writable } = await import('node:stream');
  const { readBootstrapProfile } = await import('../scripts/bootstrap-admin.js');
  let output = '';
  const capture = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const result = await readBootstrapProfile([], Readable.from(['wrong\n+77001110001\n Admin One \n Office \n Manager \n']), capture);
  assert.deepEqual(result, profile);
  assert.ok(output.length > 0, 'interactive input should prompt the operator');
});

test('bootstrap supports complete and partial command-line profiles', async () => {
  const { Readable, Writable } = await import('node:stream');
  const { readBootstrapProfile } = await import('../scripts/bootstrap-admin.js');
  const capture = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const args = ['--phone', profile.phone, '--full-name', profile.full_name, '--department', profile.department, '--position', profile.position];
  assert.deepEqual(await readBootstrapProfile(args, Readable.from([]), capture), profile);
  assert.deepEqual(await readBootstrapProfile(args.slice(0, 4), Readable.from(['Office\nManager\n']), capture), profile);
});

test('bootstrap help and invalid or incomplete input do not produce a profile', async () => {
  const { Readable, Writable } = await import('node:stream');
  const { readBootstrapProfile } = await import('../scripts/bootstrap-admin.js');
  const capture = new Writable({ write(_chunk, _encoding, done) { done(); } });
  assert.equal(await readBootstrapProfile(['--help'], Readable.from([]), capture), null);
  await assert.rejects(readBootstrapProfile(['--unknown'], Readable.from([]), capture));
  await assert.rejects(readBootstrapProfile([], Readable.from(['+77001110001\n']), capture));
});
