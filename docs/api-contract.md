# Team Voice — API contract v0.4

Status: MVP v0.4 attachments on Node.js + Hono and SQLite.
Existing routes retain their fields; ticket details additionally return attachments.
Existing account lifecycle and admin statistics routes remain unchanged.
An additive admin-only employee password reset is documented below.

Base path: /api/v1. Request and response bodies are JSON except multipart attachment
uploads and binary downloads documented below. Dates are UTC ISO 8601
strings. User sessions are sent using same-origin HttpOnly cookies. UI labels
are translated on the frontend (RU/KZ); API enums are language-neutral.

## Access roles

- employee: creates tickets, reads only own tickets and their histories.
- admin: reads all tickets, sees their authors, changes status and adds
  a decision comment.
- Anonymous tickets and public registration are outside MVP.

## Endpoints

| Method | Path | Access | Success |
|---|---|---|---|
| GET | /health | Public | 200 |
| POST | /auth/login | Public | 200 |
| POST | /auth/logout | Session | 204 |
| GET | /auth/me | Session | 200 |
| GET | /tickets | Employee | 200 |
| POST | /tickets | Employee | 201 |
| GET | /tickets/:id | Author or admin | 200 |
| POST | /tickets/:id/attachments | Ticket author, status new | 201 |
| GET | /tickets/:id/attachments/:attachmentId | Author or admin | 200 (binary) |
| GET | /admin/tickets | Admin | 200 |
| PATCH | /admin/tickets/:id | Admin | 200 |
| POST | /admin/users | Admin | 201 |
| GET | /admin/users | Admin | 200 |
| GET | /admin/stats | Admin | 200 |
| PATCH | /admin/users/:id | Admin | 200 |
| POST | /admin/users/:id/reset-password | Admin, employee target only | 200 |
| POST | /auth/change-password | Session, including temporary-password sessions | 200 |

The admin and employee detail screens use **the same**
GET /api/v1/tickets/:id endpoint.

## Important frontend decision: author in ticket details

For an ADMIN viewing GET /api/v1/tickets/:id, the response includes
the following author object in data:

~~~json
{
  "author": {
    "id": 1,
    "full_name": "Алия Серикова",
    "department": "Склад",
    "position": "Кладовщик"
  }
}
~~~

For an EMPLOYEE viewing their own ticket, the author property is **omitted**
entirely. Do not return author: null for employee views. Frontend should
check whether author is present before rendering the admin-only section.

Never expose the author's phone number, password hash, or session data
through ticket endpoints. A user requesting another employee's ticket
receives 404 even if that ticket exists.

## Login

POST /auth/login body:

~~~json
{"phone":"+77000000000","password":"example-password"}
~~~

200 result:

~~~json
{
  "data": {
    "user": {
      "id": 1,
      "full_name": "Алия Серикова",
      "phone": "+77000000000",
      "department": "Склад",
      "position": "Кладовщик",
      "role": "employee"
    }
  }
}
~~~

A session cookie is set via Set-Cookie and is never returned in JSON.
GET /auth/me returns exactly the same data.user shape.
POST /auth/logout returns 204 without a response body.

Login rate limiting: the phone bucket counts incorrect-password attempts only
(5 per 15-minute window). Successful logins do not consume that phone budget.
The separate socket-IP capacity bucket still counts all attempts (60 per window),
including successful logins and shared password-change work. Counters persist
across restarts. HTTP 429 includes Retry-After with the actual remaining whole
seconds until all currently blocking buckets expire; frontend may display a
countdown. Successful login does not clear prior failures. Existing counters from
older server versions expire naturally; deployment does not delete them.

## Ticket enums and validation

type: problem | suggestion | complaint | gratitude

status: new | in_review | resolved | rejected

Status flow: new -> in_review -> resolved OR rejected.
Both terminal transitions require an admin comment. No reopen in MVP.

Ticket input:
- type: one of the four types
- title: 5–120 characters after trim
- description: 10–4000 characters after trim

POST /tickets request:

~~~json
{
  "type": "problem",
  "title": "Не работает сканер",
  "description": "На складе перестал работать сканер штрихкодов."
}
~~~

201 result:

~~~json
{
  "data": {
    "id": 124,
    "type": "problem",
    "title": "Не работает сканер",
    "description": "На складе перестал работать сканер штрихкодов.",
    "status": "new",
    "created_at": "2026-11-10T09:30:00.000Z",
    "updated_at": "2026-11-10T09:30:00.000Z"
  }
}
~~~

The backend derives author_id from the current session. Do not send user_id
or role in a create request.

GET /tickets?page=1&limit=20 returns only the current employee's
tickets as data array. Each item includes id, type, title, status,
created_at, updated_at; there is no description or author in the list.

~~~json
{
  "data": [
    {
      "id": 124,
      "type": "problem",
      "title": "Не работает сканер",
      "status": "new",
      "created_at": "2026-11-10T09:30:00.000Z",
      "updated_at": "2026-11-10T09:30:00.000Z"
    }
  ],
  "pagination": {"page":1,"limit":20,"total":1}
}
~~~

## Ticket details and audit trail

GET /tickets/:id response for an ADMIN:

~~~json
{
  "data": {
    "id": 124,
    "type": "problem",
    "title": "Не работает сканер",
    "description": "На складе перестал работать сканер штрихкодов.",
    "status": "resolved",
    "created_at": "2026-11-10T09:30:00.000Z",
    "updated_at": "2026-11-10T11:00:00.000Z",
    "author": {
      "id": 1,
      "full_name": "Алия Серикова",
      "department": "Склад",
      "position": "Кладовщик"
    },
    "events": [
      {
        "id": 1,
        "actor": {"id": 1, "full_name": "Алия Серикова", "role": "employee"},
        "old_status": null,
        "new_status": "new",
        "comment": null,
        "created_at": "2026-11-10T09:30:00.000Z"
      },
      {
        "id": 2,
        "actor": {"id": 2, "full_name": "Администратор", "role": "admin"},
        "old_status": "new",
        "new_status": "in_review",
        "comment": null,
        "created_at": "2026-11-10T10:00:00.000Z"
      },
      {
        "id": 3,
        "actor": {"id": 2, "full_name": "Администратор", "role": "admin"},
        "old_status": "in_review",
        "new_status": "resolved",
        "comment": "Оборудование передано на ремонт.",
        "created_at": "2026-11-10T11:00:00.000Z"
      }
    ],
    "attachments": []
  }
}
~~~

The EMPLOYEE receives the same data object with the author property
omitted. History events are ordered by id ascending.

## Admin list and status mutation

GET /admin/tickets?page=1&limit=20&status=new supports optional
status filter. Response uses the same pagination structure as
GET /tickets; admin list items additionally contain:

~~~json
{
  "author": {
    "id": 1,
    "full_name": "Алия Серикова",
    "department": "Склад",
    "position": "Кладовщик"
  }
}
~~~

PATCH /admin/tickets/:id:

~~~json
{"status":"in_review"}
~~~

or

~~~json
{"status":"resolved","comment":"Оборудование передано на ремонт."}
~~~

200 result:

~~~json
{
  "data": {
    "id": 124,
    "status": "resolved",
    "updated_at": "2026-11-10T11:00:00.000Z",
    "event": {
      "id": 3,
      "old_status": "in_review",
      "new_status": "resolved",
      "comment": "Оборудование передано на ремонт.",
      "created_at": "2026-11-10T11:00:00.000Z"
    }
  }
}
~~~

Status change and ticket_events insert must be atomic. Concurrent updates
must not produce conflicting audit history.

## Pagination

page defaults to 1. limit defaults to 20, maximum 50.
Order: created_at DESC, id DESC.
Returns data: [] for an empty list.

## Errors

All errors use this envelope:

~~~json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": {"title":"TITLE_TOO_SHORT"}
  }
}
~~~

| HTTP | code |
|---|---|
| 400 | VALIDATION_ERROR or UPLOAD_ABORTED |
| 401 | INVALID_CREDENTIALS or UNAUTHORIZED |
| 403 | FORBIDDEN, ACCOUNT_DISABLED, INVALID_ORIGIN or PASSWORD_CHANGE_REQUIRED |
| 404 | NOT_FOUND |
| 408 | UPLOAD_TIMEOUT |
| 409 | INVALID_TRANSITION, PHONE_EXISTS, PASSWORD_CHANGED, ATTACHMENTS_LOCKED or ATTACHMENT_LIMIT_REACHED |
| 413 | FILE_TOO_LARGE or UPLOAD_TOO_LARGE |
| 415 | UNSUPPORTED_MEDIA_TYPE or UNSUPPORTED_FILE_TYPE |
| 429 | RATE_LIMITED |
| 500 | INTERNAL_ERROR |
| 503 | SERVICE_UNAVAILABLE |

Error details is optional. No SQL messages, stack traces or sensitive data in
production responses.

## Security requirements before enabling private routes

- Normalize Kazakhstan phone numbers to +7XXXXXXXXXX.
- No public signup, no SMS in the MVP. Phone is a login, not proof of possession.
- Store slow, salted password hashes; never raw passwords.
- Store only hashes of 32-byte random session tokens in SQLite.
- HttpOnly, Secure, SameSite=Lax cookies in production; 8-hour expiry.
- Enforce exact trusted Origin for state-changing authenticated requests.
- Do not enable permissive cross-origin credential requests.
- Check role and ownership **on each request** server-side.
- Rate-limit login attempts; validate JSON bodies and enforce size limits.
- No account, password, or session secrets in Git.
- Do not ship authentication without a safe CPU budget for password hashing.

## v0.3 stage 1: account lifecycle

### Compatibility and first login

The nine v0.2 routes and all their success JSON shapes remain unchanged.
In particular, `data.user` in login and me has exactly id, full_name, phone,
department, position, role; no password state is added to that JSON object.
`author` in tickets remains admin-only and never includes phone or secrets.

POST /auth/login and GET /auth/me additionally return the response header:

```http
X-Password-Change-Required: true
```

The value is `false` for accounts that do not require a change. For a newly
created employee it is `true`. A temporary-password login sets the usual
HttpOnly session cookie and returns the normal 200 login response. That
session may access only GET /auth/me, POST /auth/logout and
POST /auth/change-password. Ticket endpoints return 403 PASSWORD_CHANGE_REQUIRED
until the password is changed. Role restrictions still apply independently.
Health remains public. Frontend should read the header on login and session
restoration and present the change-password form before ordinary work.
The frontend UI for account management/password changes is outside this stage.

### First administrator: local CLI only

There is **no public administrator signup endpoint**. On an unprovisioned local
database, an operator runs from backend/:

```powershell
npm.cmd run bootstrap:admin -- --phone '+77001234567' --full-name 'First Administrator' --department 'Office' --position 'Administrator'
```

Run `npm.cmd run bootstrap:admin` without arguments for sequential prompts.
Missing fields are prompted individually; the complete flag form above remains
supported. `npm.cmd run bootstrap:admin -- --help` prints usage without opening
the database. EOF/Ctrl+C cancels before account creation; no password is requested.

This command applies local migrations and creates one active admin with a
cryptographically random password (24 random bytes, 32 base64url characters).
Credentials are saved once to backend/.local/bootstrap-admin.json with exclusive
file creation; they are not printed to logs or committed. The operator retrieves
this private file locally. Its path is printed on success. Existing files are
not overwritten. Treat the generated password as a private administrator secret.

Bootstrap is permitted only if **no user with role admin exists**, including
disabled administrators. The check and insertion execute under one SQLite write
transaction; concurrent invocations cannot create multiple initial admins.
An existing employee's phone cannot be reused or promoted through bootstrap.
It never resets accounts or destroys existing tickets/sessions. The generated
administrator can use the normal login and may change the generated password
using the same authenticated change-password endpoint.

### Create an employee

POST /admin/users (admin session and exact trusted Origin required):

```json
{
  "phone": "+77001234568",
  "full_name": "Employee One",
  "department": "Warehouse",
  "position": "Worker"
}
```

All four fields are required strings. Phone uses the same Kazakhstan
normalization as login, with a maximum of 64 input characters. The other three
fields are trimmed and must each contain 1-120 Unicode characters. Extra keys,
including role, password, is_active and must_change_password, are rejected.
The role is always employee; the account starts active and must change its
password. A duplicate normalized phone returns 409 PHONE_EXISTS, including
phones assigned to disabled users or admins.

201 result (the password below is an illustrative placeholder):

```json
{
  "data": {
    "user": {
      "id": 4,
      "phone": "+77001234568",
      "full_name": "Employee One",
      "department": "Warehouse",
      "position": "Worker",
      "role": "employee",
      "is_active": true,
      "must_change_password": true,
      "created_at": "2026-11-10T12:00:00.000Z"
    },
    "temporary_password": "<generated-once-32-character-password>"
  }
}
```

The temporary password uses 24 cryptographically random bytes and is stored
only as an Argon2id hash. This response is the **only API disclosure** of the
password; deliver it privately to the employee. It is never retrievable from
GET endpoints, database plaintext or server logs. Responses use Cache-Control:
no-store. There is no public self-service recovery or invitation flow. If a create
response is lost, an administrator can explicitly reset the password as described below;
the previous plaintext password is never recoverable through GET.

### List employees

GET /admin/users?page=1&limit=20 returns:

```json
{
  "data": [],
  "pagination": {"page": 1, "limit": 20, "total": 0}
}
```

Each item uses the `data.user` shape in the create example **without**
temporary_password. Both active and disabled employees are included;
administrators are excluded. Page defaults to 1, limit to 20 and is capped at
50. Order: created_at DESC, id DESC. No hash or session fields are returned.

### Activate or block an employee

PATCH /admin/users/:id body:

```json
{"is_active": false}
```

Use true to activate. Exactly one boolean is required; other keys are rejected.
200 returns `{"data":{"user":{...}}}` with the same employee user shape as
creation. An unknown ID or administrator ID returns 404 NOT_FOUND.
Deactivation and deletion of **all** that employee's sessions are atomic.
Existing cookies then return 401 UNAUTHORIZED; login with correct credentials
returns 403 ACCOUNT_DISABLED while blocked. Activation does not revive revoked
sessions or clear must_change_password. No user deletion/role changes are exposed.

### Reset a forgotten employee password (admin only)

POST /admin/users/:id/reset-password requires a current active administrator
session, no pending mandatory password change, and the exact trusted Origin.
The request has no fields: send no body, or application/json with `{}`. Nonempty
bodies use strict JSON validation; extra fields (including password, role and
is_active) are rejected. The existing 32 KiB request limit applies.

200 result (placeholder only, never a real credential):

```json
{
  "data": {
    "user": {
      "id": 5,
      "phone": "+77001234567",
      "full_name": "Employee One",
      "department": "Warehouse",
      "position": "Worker",
      "role": "employee",
      "is_active": true,
      "must_change_password": true,
      "created_at": "2026-11-10T12:00:00.000Z"
    },
    "temporary_password": "<generated-once-32-character-password>"
  }
}
```

`user` is the existing employeeView shape. The server generates 24 random bytes
(base64url, 32 characters), hashes the password with the existing Argon2id
settings, sets must_change_password=1 and revokes **all** employee sessions in
one SQLite transaction. is_active is preserved: a blocked employee remains
blocked and cannot log in until separately activated. No schema migration is
needed. Existing tickets, histories and other accounts are unchanged.

Only the successful response discloses the temporary password. It is not saved
as plaintext, logged, written to files or retrievable from any GET endpoint.
Responses use Cache-Control: no-store. After signing in with the temporary
password, the employee must use the existing POST /auth/change-password flow;
X-Password-Change-Required is true and ticket routes return 403
PASSWORD_CHANGE_REQUIRED until the change succeeds. Old passwords and revoked
sessions no longer work; activation never restores a revoked session.

Admin authorization/session and the target role are rechecked under the SQLite
write lock after Argon2. Password work shares the existing two-task limit with
login, account creation and password changes. Overload returns 503
SERVICE_UNAVAILABLE. Sequential resets each generate a new password and revoke
all employee sessions again. Overlapping resets (or another password change)
that started from the same hash cannot both overwrite it: the stale request
returns 409 PASSWORD_CHANGED with no temporary password. SQLite errors roll
back the hash, flag and session revocations together (500 INTERNAL_ERROR).

- 401 UNAUTHORIZED: no valid session, including a session revoked during hashing.
- 403 FORBIDDEN: employee caller, administrator target or self-reset.
- 403 ACCOUNT_DISABLED / PASSWORD_CHANGE_REQUIRED: current admin account is
  disabled / has a pending password change.
- 403 INVALID_ORIGIN: missing or different Origin.
- 404 NOT_FOUND: malformed ID or target no longer exists.
- 400 VALIDATION_ERROR / 415 UNSUPPORTED_MEDIA_TYPE: invalid nonempty body.
- 409 PASSWORD_CHANGED: password changed concurrently; refresh the employee
  list before deciding whether another explicit reset is needed.
- 503 SERVICE_UNAVAILABLE: Argon2 capacity is occupied; no reset was committed.

The operation is **not idempotent**. Disable duplicate UI submissions. If the
response is lost or times out, do not retry automatically: the password may
already have changed. A later administrator-confirmed reset invalidates the
previous temporary password; GET cannot recover it.

### Change password

POST /auth/change-password (session and exact Origin required):

```json
{
  "current_password": "<current-or-temporary-password>",
  "new_password": "<new-private-password>"
}
```

Both fields are required strings; extra keys are rejected. Current password is
1-1024 UTF-8 bytes. New password is 12-128 Unicode characters, at most 1024
UTF-8 bytes, contains no NUL, cannot be all whitespace, and must differ from
the current password. Passwords are **not trimmed or normalized**. Incorrect
current password returns 401 INVALID_CREDENTIALS; validation failures return
400 VALIDATION_ERROR. Disabled accounts cannot change passwords.

On success, the new Argon2id hash and clearing must_change_password are committed
atomically with revoking **every existing session** and inserting a fresh 8-hour
session. A new HttpOnly cookie replaces the caller's cookie; other devices and
old tokens must sign in again. 200 returns the unchanged public user shape:
`{"data":{"user":{"id":4,"full_name":"Employee One","phone":"+77001234568","department":"Warehouse","position":"Worker","role":"employee"}}}`.
The response header X-Password-Change-Required is false. No passwords, hashes or
tokens appear in the response JSON.

The endpoint works both for mandatory first changes and later authenticated
changes. It permits 5 attempts per account in 15 minutes; the existing 60/IP
bucket is shared with login attempts. Both success and failure count. 429 uses
RATE_LIMITED with Retry-After. Password work, including login, employee creation
and changes (including administrative resets), shares the existing two-task
Argon2 concurrency bound; overload
returns 503 SERVICE_UNAVAILABLE. Sessions and account state are rechecked under
the write lock after password work. A session revoked concurrently returns
401 UNAUTHORIZED; a concurrent changed hash, if the session remains valid,
returns 409 PASSWORD_CHANGED and requires sign-in again.

### Migration and access

Migration 0003_account_lifecycle.sql adds users.must_change_password with a
non-null default of 0 and an index for employee pagination. Existing users,
Argon2 hashes, roles, tickets, histories and sessions are retained. Only newly
created employees receive must_change_password=1 automatically. Demo seed
accounts remain compatible with v0.2; seed is not the bootstrap command.

All /admin/users routes require a current active administrator session.
Anonymous requests return 401; employees return 403 FORBIDDEN. All new mutation
routes retain the existing exact Origin check, JSON validation (reset also accepts
an empty body), 32 KiB body
limit, strict validation and generic error envelopes. Account lifecycle adds no
public registration or invitations. Attachments are specified separately below.

## Admin dashboard statistics (additive v0.3 endpoint)

GET /api/v1/admin/stats requires a current active administrator session.
No request body, filters or pagination. 200 example:

```json
{
  "data": {
    "employees": {"total": 3, "active": 2},
    "tickets": {"total": 5, "new": 2, "in_review": 1, "resolved": 1, "rejected": 1}
  }
}
```

All seven values are integer counts computed from the existing SQLite users
and tickets tables in a single read statement, not placeholders or cached values.
`employees.total` includes only role=employee, both active and blocked;
`employees.active` includes only role=employee with is_active=1, including active
employees who still need to change their temporary password. Admins are excluded.

`tickets.total` includes every ticket, including tickets by blocked employees.
The other four ticket fields count the corresponding exact status enum; resolved
and rejected are separate counts, not a combined terminal count. Their sum equals
tickets.total. History events never multiply ticket counts. Empty sets return
numeric 0, never null. Responses use Cache-Control: no-store and contain no
personal data, passwords, hashes or session details. No database mutation occurs.

Anonymous/expired sessions return 401 UNAUTHORIZED; employee sessions return
403 FORBIDDEN. Disabled admins return 403 ACCOUNT_DISABLED, and an account
requiring password change returns 403 PASSWORD_CHANGE_REQUIRED. Role and account
state are checked on each request using the existing auth middleware. Existing
endpoints and JSON contracts are unchanged; no schema migration is needed.

## v0.4: private ticket attachments

### Upload one file

POST /api/v1/tickets/:id/attachments uses **multipart/form-data** with exactly
one file part named `file`. Other parts/fields are rejected. Send each attachment
in a separate request. The browser must set the multipart Content-Type/boundary;
do not set application/json or a manual boundary when passing FormData.
Same-origin cookie authentication and the exact trusted Origin remain required.

Only the ticket author may upload, and only while status is new. An administrator
who is not the author cannot upload. Employees requesting another employee's
ticket receive 404; an admin uploading to someone else's ticket gets 403 FORBIDDEN.
The session, author, status and remaining quota are checked before reading and
again under a write transaction after streaming. A status change to in_review
while an upload is pending prevents its commit (409 ATTACHMENTS_LOCKED).

Limits:

- At most **3 committed attachments per ticket**, across all upload requests.
- File size **1 to 5,242,880 bytes inclusive** (5 MiB).
- Whole multipart body at most **5,308,416 bytes** (file limit plus 64 KiB).
- Extensions .jpg/.jpeg, .png, .webp, .pdf (case-insensitive).
- Declared part MIME must match the extension's canonical MIME, or be
  application/octet-stream; actual detected content must match too.
- Original filename: at most 180 Unicode characters and 255 UTF-8 bytes;
  no slash, backslash, colon, ASCII control characters, NUL or traversal names.
- The server streams bytes to disk with backpressure; it never calls formData(),
  arrayBuffer() or buffers an unbounded request. Byte limits are enforced even
  without Content-Length. Non-upload JSON requests retain their **32 KiB** limit.
- Maximum four active uploads per application process; overload gives 503.
  A receive deadline of 120 seconds returns 408 UPLOAD_TIMEOUT.

201 response:

```json
{
  "data": {
    "id": 7,
    "original_name": "photo.jpg",
    "mime_type": "image/jpeg",
    "size_bytes": 123456,
    "created_at": "2026-11-11T10:00:00.000Z",
    "url": "/api/v1/tickets/124/attachments/7"
  }
}
```

These are **public attachment metadata fields**. No storage key, disk path,
session token, or author phone is returned. All sizes are bytes, dates UTC.
Names are display text only; frontend must render them as text, not HTML.

No request is automatically retried/idempotent. If a connection is lost near
commit, the upload may already exist. Refresh ticket details before proposing a
manual retry; do not automatically send the same file again.

### Ticket details

GET /api/v1/tickets/:id now includes `data.attachments`, an array of the same
metadata objects as above, ordered by attachment id ascending. Old tickets and
tickets with no uploads return `attachments: []`. Existing ticket fields,
author-only/admin access rules and history order stay unchanged. The author
object is still omitted for employees and included only for admins. List,
create and status-change response shapes do not gain attachment fields.

### Protected binary download

GET /api/v1/tickets/:id/attachments/:attachmentId requires a current session:
only the author and administrators may read. The attachment must belong to that
specific ticket; mismatched IDs, missing files or unauthorized employee access
return 404 NOT_FOUND. Disabled accounts and mandatory-password-change sessions
retain existing restrictions. Account/session access is rechecked after disk I/O.

200 returns the binary file, streamed from private storage. Content-Type is
image/jpeg, image/png, image/webp or application/pdf. Headers include:

```http
Content-Disposition: attachment; filename="attachment.jpg"; filename*=UTF-8''photo.jpg
X-Content-Type-Options: nosniff
Content-Security-Policy: sandbox; default-src 'none'
Cache-Control: no-store
```

The relative metadata URL is protected, not a public or signed link. Use a normal
same-origin download link or credentialed fetch. No inline PDF execution,
thumbnails, conversion, Range/resume support or delete endpoint is added.

### Upload errors and storage lifecycle

All errors use the existing JSON envelope. 400 VALIDATION_ERROR covers bad
multipart/filename, missing/empty file, unknown fields and multiple parts;
400 UPLOAD_ABORTED covers a signalled interruption. Invalid outer media type
returns 415 UNSUPPORTED_MEDIA_TYPE. A forbidden extension, declared MIME mismatch
or detected content mismatch returns 415 UNSUPPORTED_FILE_TYPE. Oversized files
return 413 FILE_TOO_LARGE; an oversized declared body or total byte stream returns
413 UPLOAD_TOO_LARGE. If several limits are violated, the first detected error
wins; the server does not continue reading to determine another error. Quota is
409 ATTACHMENT_LIMIT_REACHED. Upload connections close after their response,
including early Origin/auth failures, to avoid retaining unread arbitrary bodies.

Migration 0004_ticket_attachments.sql adds only ticket_attachments and its index;
existing accounts, tickets, events and sessions are preserved. File publication
and metadata insertion are performed under the same write lock with cleanup
on ordinary errors, including quota/status/session races and failed DB commits.
If a COMMIT/storage error has an uncertain outcome, cleanup checks metadata before
deleting a published file; an already committed reference is always preserved.
A received file is first written under a random 256-bit key to private tmp/;
publication reserves its final random name exclusively, then renames it into
files/. Client filenames never form disk paths. Downloads reject non-regular
files and storage keys that do not match the server's fixed key format.

The server stores files under ATTACHMENTS_DIR; by default, append `.attachments`
to the absolute SQLite filename (normally backend/data/team-voice.sqlite.attachments).
Each database filename therefore has a separate default storage directory. This must
be a dedicated private local directory outside every served frontend directory.
Startup rejects overlapping canonical paths; tmp/ and files/ cannot be symlinks.
Back up the database and this directory together while the application is stopped.
Do not point a different/unrelated database at an existing attachment directory.

Ordinary failed, interrupted and timed-out uploads close writers and remove
uncommitted files. Cleanup errors are logged generically and retried by
maintenance. On startup and at most every 15 minutes on subsequent upload work,
files with server-generated names older than 24 hours and without metadata are
removed; committed files and unrelated names are preserved. There is no global
filesystem/SQLite crash transaction: a crash can leave a recent orphan until
that cleanup. Operators remain responsible for private Windows ACLs, persistent
disk space and backing up both stores. Deleting the directory loses attachments.

Format verification uses allowed binary signatures and file-type detection.
It is not deep document/image validation or antivirus: corrupted/polyglot files,
malicious PDF content and decompression bombs are not guaranteed absent. The
backend does not decode images, execute documents or serve them as frontend
assets; downloads are marked attachment and nosniff. No malware scanning,
external storage, attachment editing/deletion or other features are included.
