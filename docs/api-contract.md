# Team Voice — API contract v0.3

Status: MVP v0.3 stage 1 on Node.js + Hono and SQLite.
The nine v0.2 routes retain their response JSON contracts; account lifecycle routes are additive.

Base path: /api/v1. Request and response bodies are JSON. Dates are UTC ISO 8601
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
| GET | /admin/tickets | Admin | 200 |
| PATCH | /admin/tickets/:id | Admin | 200 |
| POST | /admin/users | Admin | 201 |
| GET | /admin/users | Admin | 200 |
| PATCH | /admin/users/:id | Admin | 200 |
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
    ]
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
| 400 | VALIDATION_ERROR |
| 401 | INVALID_CREDENTIALS or UNAUTHORIZED |
| 403 | FORBIDDEN, ACCOUNT_DISABLED, INVALID_ORIGIN or PASSWORD_CHANGE_REQUIRED |
| 404 | NOT_FOUND |
| 409 | INVALID_TRANSITION, PHONE_EXISTS or PASSWORD_CHANGED |
| 415 | UNSUPPORTED_MEDIA_TYPE |
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
no-store. There is no password-reset/invitation flow in this stage; if a create
response is lost, the account/password is not recoverable through another GET.

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
and changes, shares the existing two-task Argon2 concurrency bound; overload
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

All three /admin/users routes require a current active administrator session.
Anonymous requests return 401; employees return 403 FORBIDDEN. All new mutation
routes retain the existing exact Origin check, JSON media type, 32 KiB body
limit, strict validation and generic error envelopes. No registration,
invitations, attachments or statistics were added.
