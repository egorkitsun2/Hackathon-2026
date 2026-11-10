# Team Voice — backend

Backend for Hackathon-2026. Stage 1 implements the Hono Worker, a D1 binding,
the initial SQL migration, and GET /api/v1/health. Authentication and ticket
endpoints are documented but **not implemented yet**.

## Requirements

- Node.js 20+ and npm
- Cloudflare account only for remote deployment
- For local development, Wrangler uses a separate local D1 database

## Local development

From the repository root:

~~~sh
cd backend
npm install
npm run db:migrate:local
npm run typecheck
npm run dev
~~~

Open http://127.0.0.1:8787/api/v1/health.

Expected response:

~~~json
{"data":{"status":"ok","database":"ok"}}
~~~

The all-zero D1 ID in wrangler.jsonc is a placeholder for **local development
only**. No real Cloudflare D1 database has been created by this commit.

## Remote deployment (later)

1. Log in using npx wrangler login.
2. Create the D1 database using npx wrangler d1 create team-voice-db.
3. Replace database_id in wrangler.jsonc with the actual returned UUID.
4. Apply migrations: npm run db:migrate:remote.
5. Deploy the Worker: npm run deploy.

Do not deploy with the placeholder ID. Do not run remote database migrations
before checking the target database and having a backup for existing data.

## Frontend integration (later)

Frontend is being developed independently in the Frontend branch.
The final deployment must serve the frontend and /api/v1/* on **the same origin**.
Static Assets configuration will be added after the frontend build directory
and framework are agreed. Until then, this Worker only exposes the API health
endpoint and returns 404 for other paths.

## Security and scope

- No credentials, password hashes or test users are committed.
- Authentication, role checks and CSRF defense are still pending.
- Do not expose ticket endpoints before those controls are implemented.
- Author details are available in ticket details to admins only.
- See docs/api-contract.md for the approved client/server contract.
