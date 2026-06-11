-- Operator chat local store. Applied idempotently on every open via
-- `CREATE TABLE IF NOT EXISTS`. See `chat_store.rs` for the row shapes.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS channels (
    channel_id TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    sub        TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL DEFAULT 'cluster',
    cluster_id INTEGER NOT NULL,
    subscribed INTEGER NOT NULL DEFAULT 0,
    -- Additive (2026-06-11): unread tracking. Timestamp (ms) of the last
    -- message the operator has seen in this channel; `chat_mark_read`
    -- advances it. Existing databases gain the column via
    -- `ensure_channel_column` in chat_store.rs.
    last_read_ts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    msg_id         TEXT NOT NULL,
    channel_id     TEXT NOT NULL,
    cluster_id     INTEGER NOT NULL,
    sender_address TEXT NOT NULL,
    sender_pubkey_hex TEXT NOT NULL,
    body           TEXT NOT NULL,
    timestamp_ms   INTEGER NOT NULL,
    nonce_hex      TEXT NOT NULL,
    signature_hex  TEXT NOT NULL,
    verified       INTEGER NOT NULL DEFAULT 1,
    from_me        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, msg_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_ts
    ON messages (channel_id, timestamp_ms);
