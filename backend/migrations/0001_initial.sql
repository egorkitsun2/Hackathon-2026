-- Hackathon-2026 / Team Voice / Cloudflare D1 (SQLite)
-- All timestamps are UTC ISO 8601 strings, set by the application.
-- Users are deactivated, not deleted: this preserves the audit trail.

CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    department TEXT NOT NULL,
    position TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'employee'
        CHECK (role IN ('employee', 'admin')),
    is_active INTEGER NOT NULL DEFAULT 1
        CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL
);

CREATE TABLE tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    type TEXT NOT NULL
        CHECK (type IN ('problem', 'suggestion', 'complaint', 'gratitude')),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 5 AND 120),
    description TEXT NOT NULL
        CHECK (length(trim(description)) BETWEEN 10 AND 4000),
    status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'in_review', 'resolved', 'rejected')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE ticket_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    old_status TEXT
        CHECK (
            old_status IS NULL OR
            old_status IN ('new', 'in_review', 'resolved', 'rejected')
        ),
    new_status TEXT NOT NULL
        CHECK (new_status IN ('new', 'in_review', 'resolved', 'rejected')),
    comment TEXT
        CHECK (
            comment IS NULL OR length(trim(comment)) BETWEEN 5 AND 2000
        ),
    created_at TEXT NOT NULL,
    CHECK (
        new_status NOT IN ('resolved', 'rejected')
        OR comment IS NOT NULL
    )
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX idx_tickets_author
    ON tickets(author_id, created_at DESC, id DESC);

CREATE INDEX idx_tickets_status
    ON tickets(status, created_at DESC, id DESC);

CREATE INDEX idx_events_ticket
    ON ticket_events(ticket_id, id);

CREATE INDEX idx_sessions_user
    ON sessions(user_id);

CREATE INDEX idx_sessions_expires
    ON sessions(expires_at);
