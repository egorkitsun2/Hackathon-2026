-- Existing users retain their password/session behavior; only new employee accounts are forced to change.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0
    CHECK (must_change_password IN (0, 1));
CREATE INDEX idx_users_role_created ON users(role, created_at DESC, id DESC);
