-- Rebuild without renaming the original: dependent foreign keys keep referencing users.
CREATE TABLE users_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    department TEXT NOT NULL,
    position TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'admin', 'manager')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1))
);
INSERT INTO users_new SELECT id, phone, full_name, department, position, password_hash, role, is_active, created_at, must_change_password FROM users;
-- Preserve the high-water mark even when the largest user ID was deleted.
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'users'), 0)) WHERE name = 'users_new';
INSERT INTO sqlite_sequence(name, seq) SELECT 'users_new', seq FROM sqlite_sequence WHERE name = 'users' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'users_new');
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX idx_users_role_created ON users(role, created_at DESC, id DESC);
ALTER TABLE tickets ADD COLUMN category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('it', 'procurement', 'general'));
ALTER TABLE tickets ADD COLUMN assigned_to INTEGER REFERENCES users(id) ON DELETE RESTRICT;
CREATE INDEX idx_tickets_assigned_status ON tickets(assigned_to, status);
CREATE TABLE category_routing (
    category TEXT NOT NULL PRIMARY KEY CHECK (category IN ('it', 'procurement', 'general')),
    manager_id INTEGER REFERENCES users(id) ON DELETE RESTRICT
);
INSERT INTO category_routing(category) VALUES ('it'), ('procurement'), ('general');
