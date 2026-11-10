# Team Voice — API contract v0.2

Status: implemented backend MVP on Node.js + Hono and SQLite.
The agreed endpoint and JSON contracts are unchanged.

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
| 403 | FORBIDDEN, ACCOUNT_DISABLED or INVALID_ORIGIN |
| 404 | NOT_FOUND |
| 409 | INVALID_TRANSITION |
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
