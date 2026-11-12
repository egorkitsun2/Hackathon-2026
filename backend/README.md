# Team Voice backend

Hackathon MVP v0.5: TypeScript + Hono on Node.js, SQLite, Argon2id and server-side
cookie sessions. The API and JSON shapes are defined in
[`docs/api-contract.md`](../docs/api-contract.md). No Cloudflare account,
Workers subscription or cloud resources are required.

Manager routing and first-upgrade backup instructions: [API v0.5](../docs/api-contract.md#v05-manager-routing).
Frontend integration: [manager routing handoff](../docs/frontend-manager-routing.md).

## Local launch (PowerShell)

For one-command Windows launch and Cloudflare Quick Tunnel, see
[Windows launchers](../docs/windows-launchers.md). These launchers never seed or bootstrap accounts.

Use Node.js **24.13+** (tested on 26.13.0) and npm. SQLite uses the built-in
`node:sqlite` driver; Argon2 uses the `argon2` native package and its prebuilt
binaries. On platforms without a compatible prebuilt binary, npm may need a
C/C++ build toolchain. Dependencies are locked in `package-lock.json`.

Stop the running backend (Ctrl+C in its terminal) before `npm ci`, especially on
Windows: a loaded Argon2 native library prevents replacement of node_modules.
For Windows recovery and first-admin setup, see
[`docs/windows-local-setup.md`](../docs/windows-local-setup.md).

For an explicitly disposable demo database, from the repository root:

```powershell
cd backend
npm.cmd ci
npm.cmd run db:migrate
npm.cmd run seed
npm.cmd run dev
```

Open **http://localhost:8787/api/v1/health**. Successful response:

```json
{"data":{"status":"ok","database":"ok"}}
```

The server listens on `127.0.0.1:8787`. Use **localhost** in the browser:
`http://127.0.0.1:8787` is a different Origin and mutations will be rejected
unless APP_ORIGIN is set to that exact origin.

If startup reports that port 8787 is already in use, stop the previous local
server with Ctrl+C in its terminal. In particular, stop any old `wrangler dev`
from the earlier Cloudflare version of this backend. Do not terminate unrelated
processes. Alternatively, explicitly use another port and matching Origin:

```powershell
$env:PORT = '8788'
$env:APP_ORIGIN = 'http://localhost:8788'
npm.cmd run dev
```

Then use `http://localhost:8788/api/v1/health`. The server never silently switches
ports, since the frontend and trusted Origin must agree with the selected port.

Seed creates two employees and one administrator. Their phone numbers and
independent, random passwords are saved to **`.local/test-accounts.json`**.
No passwords are printed to logs. This file, `data/`, SQLite sidecar files,
`.env` and build output are Git-ignored. Never publish or share the credential
file or the database. On Windows, keep them in a user-private directory.

Seed is deliberately non-destructive: it refuses a database containing users,
refuses to overwrite an existing credential file, and is disabled when
NODE_ENV=production. Repeated server starts and migrations preserve existing
data. `npm.cmd run seed` is needed only once for a fresh local demo database.
The original D1 schema is retained unchanged; migration 0002 adds only the
persistent login-attempt counters. Old Wrangler local data is not imported.

For a compiled run:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd start
```

## Configuration

Set environment variables in the shell before launching. Commands work from
`backend/`; relative custom paths resolve against the current directory.
`.env` is ignored by Git but is **not loaded automatically**.

| Variable | Default | Meaning |
| --- | --- | --- |
| HOST | 127.0.0.1 | Listen address |
| PORT | 8787 | Listen port |
| DATABASE_PATH | backend/data/team-voice.sqlite | SQLite file, independent of working directory for the default |
| APP_ORIGIN | http://localhost:PORT in development | Exact trusted browser origin, no trailing slash |
| NODE_ENV | development behavior | Set production to require HTTPS origin and Secure cookies |
| FRONTEND_DIR | unset | Optional absolute path to an existing public frontend build containing index.html |
| ATTACHMENTS_DIR | DATABASE_PATH + .attachments | Dedicated private attachment storage, outside FRONTEND_DIR |

The server automatically applies pending local migrations before listening.
`db:migrate` is also available as an explicit preparation step. It does not
contact Cloudflare or any other remote service.

## One origin with the frontend

When the separately developed frontend build is available, point
FRONTEND_DIR to **only that public build directory**, then start the backend.
Hono serves those files and `/api/v1/*` from the same port and origin. `/`
serves its index.html. Missing files return 404; SPA history fallback is not
configured. API paths never fall back to frontend files.

Example (replace the path with the actual build path):

```powershell
$env:FRONTEND_DIR = 'C:\path\to\frontend\dist'
$env:APP_ORIGIN = 'http://localhost:8787'
npm.cmd start
```

Alternatively, a single HTTPS reverse proxy can serve the frontend and forward
`/api/v1/*` to this server. For a frontend dev server on another port, configure
its `/api` proxy and set APP_ORIGIN to that dev server's origin. The browser
must use relative `/api/v1/...` URLs; permissive CORS is not enabled.
No frontend files were changed by this backend implementation.

## Sessions and security

- Phone is a login, not verified ownership. Kazakhstan +7, 8-prefixed and
  ten-digit national formats are normalized to +7XXXXXXXXXX (national 6/7).
- Argon2id: 64 MiB memory, time cost 3, parallelism 1, per-password random salt.
  Unknown accounts verify against a randomly generated dummy hash. Two costly
  verifications may run concurrently per app process; excess requests get 503.
- Login permits 5 incorrect-password attempts per phone per 15-minute window;
  successful logins do not consume that phone limit. The separate 60-attempt
  socket-IP capacity bucket still counts every attempt before hashing.
  Counters persist in SQLite. 429 includes the actual remaining Retry-After seconds.
  Forwarded IP headers are ignored. Behind a reverse proxy, the IP bucket is
  shared by users of that proxy; this is deliberately conservative for the MVP.
- Sessions use 32 random bytes. Only the SHA-256 token digest is stored in
  SQLite. Expiry is 8 hours; login replaces the presented previous session;
  logout deletes the server session and expires the cookie. Expired rows are
  cleaned up on later successful logins.
- Production cookie: `__Host-team_voice_session`, HttpOnly, Secure, Path=/,
  SameSite=Lax, no Domain. Local HTTP cookie: `team_voice_session`.
- Every mutation, including login/logout, requires the **exact Origin**.
  CLI clients must send `Origin: <APP_ORIGIN>`. Auth and role checks run on each
  request; disabled users cannot use their existing sessions.
- JSON bodies have a 32 KiB limit; values and allowed keys are validated.
  SQL uses bound parameters. Error responses never expose SQL or stack traces.
- Employees only read their own tickets; another employee's ticket is 404.
  Ticket `author` appears only in admin responses, without phone or secrets.
- Creation plus initial history, and status updates plus decision events, each
  use a synchronous BEGIN IMMEDIATE transaction. Concurrent decisions reread
  the status under the write lock. Failed history inserts roll back all changes.
- Allowed flow: new -> in_review -> resolved OR rejected. A terminal decision
  requires a trimmed 5-2000 character comment. Reopening is unavailable.

Use one Node process and a local persistent database file for this MVP. Before
public hosting, configure HTTPS, a private persistent data directory and
backups, and APP_ORIGIN. Public hosting and real user provisioning are not
performed here. The demo seed is not a production account-management tool.

## Verification

`npm.cmd test` runs integration tests against real isolated SQLite databases:
authentication, sessions, role and ownership restrictions, admin-only author,
validation, pagination, status flow, rate limiting, rollback on failed history
inserts, and concurrent status changes. Tests do not use the demo database or
commit any test-account credentials.

Scope: nine original endpoints plus employee provisioning, activation/blocking,
password changes, read-only admin dashboard counters and private ticket attachments.
No public registration or invitations,
Telegram, analytics, ticket deletion, editing or reopening.

## First administrator and employee management (v0.3)

For a real initial administrator, use bootstrap **instead of demo seed** on a
fresh database. From backend/:

```powershell
npm.cmd run bootstrap:admin
# Enter phone, full name, department and position in sequence.
# Existing --phone/--full-name/--department/--position flags are also supported.
npm.cmd run dev
```

Bootstrap applies migrations and writes the generated administrator password to
`.local/bootstrap-admin.json` (private and Git-ignored). Passwords are not passed
as shell arguments or printed. It refuses when any admin already exists,
including a disabled one, and will not overwrite the credential file or promote
an employee. On normal write/COMMIT failures, the transaction rolls back and
removes only the credential file created by that invocation. SQLite and the
filesystem are not one crash-atomic transaction: after a machine/process crash,
inspect any leftover file and account state locally before retrying. On an existing demo database, use its already seeded admin:
bootstrap must refuse it. No public administrator registration route exists.

An authenticated administrator uses POST `/api/v1/admin/users` with phone,
full_name, department and position. The response includes a generated temporary
password once; deliver it privately. GET the same path lists employees, and
PATCH `/api/v1/admin/users/:id` with `{ "is_active": false }` blocks an employee
and revokes all their sessions. true activates without reviving old sessions.
Full request/response shapes are in the v0.3 API contract.

A newly created employee signs in with the temporary password. Login and me
retain the old JSON and expose `X-Password-Change-Required: true` as a response
header. Until POST `/api/v1/auth/change-password` succeeds, only me, logout and
change-password are available. Send current_password and new_password; new
password must be 12-128 characters and different. The change revokes old
sessions, clears the requirement and sets a fresh cookie atomically.

Existing users stay compatible: migration 0003 defaults the new flag to 0,
retaining all accounts, tickets, histories and sessions. `npm.cmd run db:migrate`
and server startup apply pending migrations. Back up an existing SQLite database
with SQLite's backup API before upgrading a live local database.

Account-management and password-change UI are maintained in the parallel
frontend work. Existing ticket/account frontend scenarios are covered by the
integration tests; this backend stage does not modify frontend files. Attachment
UI still needs the separate handoff below. Automated backend tests exercise the
complete empty-database account lifecycle.

The frontend handoff for Sharapat is in
[`docs/frontend-v03-handoff.md`](../docs/frontend-v03-handoff.md).

`GET /api/v1/admin/stats` returns real SQLite counts of employees (total/active)
and tickets (total/new/in_review/resolved/rejected). It requires an administrator
session and uses the existing tables without migrations. The exact response is
specified in the API contract; no frontend changes are included.

## Ticket attachments (v0.4)

Run `npm.cmd run db:migrate` or restart the server to apply migration 0004. It
adds only attachment metadata/index; existing records are retained. The default
storage is `data/team-voice.sqlite.attachments/{tmp,files}` next to the default
database. Each custom DATABASE_PATH gets its own `<database-file>.attachments/`
directory unless ATTACHMENTS_DIR is set. This prevents separate database files
in the same parent directory from sharing their default cleanup namespace. Keep it private, Git-ignored and outside the frontend. Startup rejects
public/private overlaps. On Windows use private directory ACLs: mode 0600/0700
alone is not an ACL configuration. Back up SQLite and attachments as one set
while stopped, and monitor persistent disk capacity.

POST `/api/v1/tickets/:id/attachments` accepts one multipart `file` (JPG/JPEG,
PNG, WebP, PDF), max 5 MiB, at most three per ticket. Only the author in status
new can upload. GET `/api/v1/tickets/:id` includes metadata in attachments[];
GET `/api/v1/tickets/:id/attachments/:attachmentId` streams a protected download
for the author/admin. JSON bodies still have the 32 KiB cap. Upload body cap is
5 MiB + 64 KiB; backpressure, four concurrent streams and a 120-second deadline
bound live uploads. The API contract defines exact responses/errors.

Failures remove temporary files after closing writers. Crash leftovers with
server-generated names, older than 24h and unreferenced by SQLite, are cleaned
at startup and during subsequent upload maintenance. Correctly committed files
are retained. Never pair an unrelated database with an existing storage folder.
Signature detection is not antivirus or deep file validation; documents are
served as downloads with nosniff/sandbox, not public assets. No thumbnails,
resumable uploads, editing/deletion or external storage is implemented.

Frontend implementation is separate; see
[`docs/frontend-attachments-handoff.md`](../docs/frontend-attachments-handoff.md).
