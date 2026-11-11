CREATE TABLE ticket_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
    storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) = 64),
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
    size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
    created_at TEXT NOT NULL
);
CREATE INDEX idx_attachments_ticket ON ticket_attachments(ticket_id, id);
