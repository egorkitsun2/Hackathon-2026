CREATE TABLE categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name_ru TEXT NOT NULL,
    name_kz TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    CHECK (code <> 'general' OR is_active = 1)
);
INSERT INTO categories(code, name_ru, name_kz) VALUES
    ('it', 'IT', 'IT'),
    ('procurement', 'Закупки', 'Сатып алу'),
    ('general', 'Администрация', 'Әкімшілік');
CREATE TRIGGER categories_code_immutable BEFORE UPDATE OF code ON categories
WHEN NEW.code <> OLD.code BEGIN
    SELECT RAISE(ABORT, 'category code is immutable');
END;

-- Keep the original name until DROP so child tables still refer to tickets.
CREATE TABLE tickets_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    type TEXT NOT NULL CHECK (type IN ('problem', 'suggestion', 'complaint', 'gratitude')),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 5 AND 120),
    description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 10 AND 4000),
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_review', 'resolved', 'rejected')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general' REFERENCES categories(code) ON DELETE RESTRICT,
    assigned_to INTEGER REFERENCES users(id) ON DELETE RESTRICT
);
INSERT INTO tickets_new(id, author_id, type, title, description, status, created_at, updated_at, category, assigned_to)
SELECT id, author_id, type, title, description, status, created_at, updated_at, category, assigned_to FROM tickets;
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'tickets'), 0)) WHERE name = 'tickets_new';
INSERT INTO sqlite_sequence(name, seq) SELECT 'tickets_new', seq FROM sqlite_sequence WHERE name = 'tickets' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'tickets_new');
DROP TABLE tickets;
ALTER TABLE tickets_new RENAME TO tickets;
CREATE INDEX idx_tickets_author ON tickets(author_id, created_at DESC, id DESC);
CREATE INDEX idx_tickets_status ON tickets(status, created_at DESC, id DESC);
CREATE INDEX idx_tickets_assigned_status ON tickets(assigned_to, status);

CREATE TABLE category_routing_new (
    category TEXT NOT NULL PRIMARY KEY REFERENCES categories(code) ON DELETE RESTRICT,
    manager_id INTEGER REFERENCES users(id) ON DELETE RESTRICT
);
INSERT INTO category_routing_new(category, manager_id) SELECT category, manager_id FROM category_routing;
DROP TABLE category_routing;
ALTER TABLE category_routing_new RENAME TO category_routing;
