-- Persistent fixed-window login throttling. Keys are SHA-256 digests, not raw phone/IP.
CREATE TABLE login_attempts (
    bucket TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    attempts INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts_window ON login_attempts(window_start);
