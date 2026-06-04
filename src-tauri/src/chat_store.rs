// Local-first chat persistence — SQLite at
// `{app_local_data_dir}/monarch-desktop/chat.db`.
//
// Two tables:
//   * `channels` — one row per cluster channel the operator has joined,
//     keyed by `channel_id` (e.g. `cluster-12`). `subscribed` mirrors
//     the live gossipsub subscription so a relaunch can re-subscribe.
//   * `messages` — append-only signed-message log. The signature,
//     sender pubkey, cluster id, and nonce are persisted alongside the
//     verified body so the signed envelope can be audited after restart.
//
// The store is intentionally narrow: it is the indefinite local history
// (the gossip cache on peers is ~10 min; Phase 3 owns backfill).
// Writes are idempotent on `(channel_id, msg_id)` so a message
// echoed back over gossip from a peer never double-inserts.
//
// Concurrency: the `Connection` lives behind the ChatManager's async
// Mutex (see `chat.rs`). rusqlite is synchronous; calls are short and
// run inside the already-serialized manager lock, so there is no
// separate connection pool.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// FIFO retention budget. The design spec caps the local store at
/// 100 MB; for the MVP we enforce a row cap per channel instead of a
/// byte budget — simpler, and a 4 KB body cap keeps the math bounded.
/// Phase 3 should switch this to the 100 MB byte budget with vacuum.
const MAX_MESSAGES_PER_CHANNEL: i64 = 5_000;

#[derive(Debug, Error)]
pub enum ChatStoreError {
    #[error("chat store: sqlite error: {0}")]
    Sqlite(String),
    #[error("chat store: could not create data directory: {0}")]
    Io(String),
}

impl From<rusqlite::Error> for ChatStoreError {
    fn from(err: rusqlite::Error) -> Self {
        ChatStoreError::Sqlite(err.to_string())
    }
}

/// A persisted chat channel. `kind` is always `"cluster"` for the MVP
/// (DMs / broadcast land in later phases) but is stored so the UI can
/// group channels without a schema change.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelRecord {
    pub channel_id: String,
    pub name: String,
    pub sub: String,
    pub kind: String,
    pub cluster_id: i64,
    pub subscribed: bool,
}

/// A persisted, signature-verified message. The wire envelope is
/// reconstructed from these fields (see `chat::ChatEnvelope`); we store
/// the canonical pieces rather than the raw JSON so the UI never has to
/// re-parse an envelope to render a row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageRecord {
    pub msg_id: String,
    pub channel_id: String,
    pub cluster_id: i64,
    pub sender_address: String,
    /// Hex-encoded ML-DSA-65 public key carried in the signed envelope.
    pub sender_pubkey_hex: String,
    pub body: String,
    pub timestamp_ms: i64,
    /// Hex nonce included in the signing digest.
    pub nonce_hex: String,
    /// Hex-encoded ML-DSA-65 signature over the canonical envelope.
    pub signature_hex: String,
    /// True if the signature verified locally on receipt. Locally-sent
    /// messages are always `true`. Non-verifying messages are dropped
    /// before they ever reach the store, so in practice this is always
    /// `true` today — kept for the Phase-4 "untrusted" surface.
    pub verified: bool,
    /// True when this row is the operator's own message.
    pub from_me: bool,
}

pub struct ChatStore {
    conn: Connection,
}

impl ChatStore {
    /// Open (or create) the chat database under
    /// `{app_local_data_dir}/monarch-desktop/chat.db` and apply the
    /// embedded schema. The directory is created if missing.
    pub fn open(app_local_data_dir: &Path) -> Result<Self, ChatStoreError> {
        let dir = app_local_data_dir.join("monarch-desktop");
        std::fs::create_dir_all(&dir).map_err(|e| ChatStoreError::Io(e.to_string()))?;
        let db_path = dir.join("chat.db");
        let conn = Connection::open(db_path)?;
        let store = Self { conn };
        store.apply_schema()?;
        Ok(store)
    }

    /// In-memory store for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, ChatStoreError> {
        let conn = Connection::open_in_memory()?;
        let store = Self { conn };
        store.apply_schema()?;
        Ok(store)
    }

    fn apply_schema(&self) -> Result<(), ChatStoreError> {
        self.conn.execute_batch(include_str!("chat_schema.sql"))?;
        self.ensure_message_column("cluster_id", "INTEGER NOT NULL DEFAULT 0")?;
        self.ensure_message_column("sender_pubkey_hex", "TEXT NOT NULL DEFAULT ''")?;
        self.ensure_message_column("nonce_hex", "TEXT NOT NULL DEFAULT ''")?;
        Ok(())
    }

    fn ensure_message_column(&self, column: &str, definition: &str) -> Result<(), ChatStoreError> {
        let mut stmt = self.conn.prepare("PRAGMA table_info(messages)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        for row in rows {
            if row? == column {
                return Ok(());
            }
        }
        self.conn.execute(
            &format!("ALTER TABLE messages ADD COLUMN {column} {definition}"),
            [],
        )?;
        Ok(())
    }

    /// Insert / update a channel row. Idempotent on `channel_id`; the
    /// `subscribed` flag is overwritten so the call doubles as a
    /// subscribe/unsubscribe persistence point.
    pub fn upsert_channel(&self, channel: &ChannelRecord) -> Result<(), ChatStoreError> {
        self.conn.execute(
            "INSERT INTO channels (channel_id, name, sub, kind, cluster_id, subscribed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(channel_id) DO UPDATE SET
               name = excluded.name,
               sub = excluded.sub,
               kind = excluded.kind,
               cluster_id = excluded.cluster_id,
               subscribed = excluded.subscribed",
            params![
                channel.channel_id,
                channel.name,
                channel.sub,
                channel.kind,
                channel.cluster_id,
                channel.subscribed as i64,
            ],
        )?;
        Ok(())
    }

    pub fn set_subscribed(&self, channel_id: &str, subscribed: bool) -> Result<(), ChatStoreError> {
        self.conn.execute(
            "UPDATE channels SET subscribed = ?2 WHERE channel_id = ?1",
            params![channel_id, subscribed as i64],
        )?;
        Ok(())
    }

    pub fn list_channels(&self) -> Result<Vec<ChannelRecord>, ChatStoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT channel_id, name, sub, kind, cluster_id, subscribed
             FROM channels ORDER BY cluster_id ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ChannelRecord {
                channel_id: row.get(0)?,
                name: row.get(1)?,
                sub: row.get(2)?,
                kind: row.get(3)?,
                cluster_id: row.get(4)?,
                subscribed: row.get::<_, i64>(5)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Append a message. Idempotent on `(channel_id, msg_id)` so a
    /// gossip echo of a message we already stored is a no-op. Returns
    /// `true` if the row was newly inserted (so the caller knows whether
    /// to emit a live event), `false` if it was a duplicate.
    pub fn insert_message(&self, msg: &MessageRecord) -> Result<bool, ChatStoreError> {
        let changed = self.conn.execute(
            "INSERT OR IGNORE INTO messages
               (msg_id, channel_id, cluster_id, sender_address, sender_pubkey_hex, body, timestamp_ms, nonce_hex, signature_hex, verified, from_me)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                msg.msg_id,
                msg.channel_id,
                msg.cluster_id,
                msg.sender_address,
                msg.sender_pubkey_hex,
                msg.body,
                msg.timestamp_ms,
                msg.nonce_hex,
                msg.signature_hex,
                msg.verified as i64,
                msg.from_me as i64,
            ],
        )?;
        if changed > 0 {
            self.enforce_fifo(&msg.channel_id)?;
        }
        Ok(changed > 0)
    }

    /// Trim the oldest rows in a channel past `MAX_MESSAGES_PER_CHANNEL`.
    fn enforce_fifo(&self, channel_id: &str) -> Result<(), ChatStoreError> {
        self.conn.execute(
            "DELETE FROM messages
             WHERE channel_id = ?1
               AND rowid NOT IN (
                 SELECT rowid FROM messages
                 WHERE channel_id = ?1
                 ORDER BY timestamp_ms DESC, rowid DESC
                 LIMIT ?2
               )",
            params![channel_id, MAX_MESSAGES_PER_CHANNEL],
        )?;
        Ok(())
    }

    /// Fetch the most recent `limit` messages for a channel in ascending
    /// timestamp order (oldest first) so the UI can append-render.
    pub fn messages_for_channel(
        &self,
        channel_id: &str,
        limit: i64,
    ) -> Result<Vec<MessageRecord>, ChatStoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT msg_id, channel_id, cluster_id, sender_address, sender_pubkey_hex, body, timestamp_ms, nonce_hex, signature_hex, verified, from_me
             FROM messages
             WHERE channel_id = ?1
             ORDER BY timestamp_ms DESC, rowid DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![channel_id, limit], |row| {
            Ok(MessageRecord {
                msg_id: row.get(0)?,
                channel_id: row.get(1)?,
                cluster_id: row.get(2)?,
                sender_address: row.get(3)?,
                sender_pubkey_hex: row.get(4)?,
                body: row.get(5)?,
                timestamp_ms: row.get(6)?,
                nonce_hex: row.get(7)?,
                signature_hex: row.get(8)?,
                verified: row.get::<_, i64>(9)? != 0,
                from_me: row.get::<_, i64>(10)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        // Stored newest-first for the LIMIT; reverse to oldest-first.
        out.reverse();
        Ok(out)
    }

    /// True if a message id already exists in a channel (used as a fast
    /// pre-check before signature verification on inbound gossip).
    pub fn has_message(&self, channel_id: &str, msg_id: &str) -> Result<bool, ChatStoreError> {
        let found: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM messages WHERE channel_id = ?1 AND msg_id = ?2 LIMIT 1",
                params![channel_id, msg_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    /// True when the operator has explicitly joined and subscribed to a
    /// cluster channel. Used by the command boundary so a direct Tauri
    /// invoke cannot post to a cluster that the UI has not joined.
    pub fn is_subscribed_cluster(
        &self,
        channel_id: &str,
        cluster_id: i64,
    ) -> Result<bool, ChatStoreError> {
        let found: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM channels
                 WHERE channel_id = ?1 AND cluster_id = ?2 AND subscribed = 1
                 LIMIT 1",
                params![channel_id, cluster_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_channel(id: i64) -> ChannelRecord {
        ChannelRecord {
            channel_id: format!("cluster-{id}"),
            name: format!("Cluster C-{id:03}"),
            sub: "operator cluster".to_string(),
            kind: "cluster".to_string(),
            cluster_id: id,
            subscribed: true,
        }
    }

    fn sample_message(channel_id: &str, n: i64) -> MessageRecord {
        MessageRecord {
            msg_id: format!("m{n}"),
            channel_id: channel_id.to_string(),
            cluster_id: 1,
            sender_address: "0xabc".to_string(),
            sender_pubkey_hex: "0x1234".to_string(),
            body: format!("hello {n}"),
            timestamp_ms: 1_700_000_000_000 + n,
            nonce_hex: format!("0x{n:032x}"),
            signature_hex: "00".to_string(),
            verified: true,
            from_me: false,
        }
    }

    #[test]
    fn upsert_and_list_channels() {
        let store = ChatStore::open_in_memory().unwrap();
        store.upsert_channel(&sample_channel(1)).unwrap();
        store.upsert_channel(&sample_channel(2)).unwrap();
        // Re-upsert flips subscribed without duplicating.
        let mut c1 = sample_channel(1);
        c1.subscribed = false;
        store.upsert_channel(&c1).unwrap();

        let channels = store.list_channels().unwrap();
        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0].cluster_id, 1);
        assert!(!channels[0].subscribed);
        assert!(channels[1].subscribed);
    }

    #[test]
    fn insert_message_is_idempotent() {
        let store = ChatStore::open_in_memory().unwrap();
        let msg = sample_message("cluster-1", 1);
        assert!(store.insert_message(&msg).unwrap());
        // Same id again — no new row, returns false.
        assert!(!store.insert_message(&msg).unwrap());
        let msgs = store.messages_for_channel("cluster-1", 100).unwrap();
        assert_eq!(msgs.len(), 1);
        assert!(store.has_message("cluster-1", "m1").unwrap());
        assert!(!store.has_message("cluster-1", "m2").unwrap());
    }

    #[test]
    fn messages_returned_oldest_first() {
        let store = ChatStore::open_in_memory().unwrap();
        for n in 1..=3 {
            store
                .insert_message(&sample_message("cluster-1", n))
                .unwrap();
        }
        let msgs = store.messages_for_channel("cluster-1", 100).unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].body, "hello 1");
        assert_eq!(msgs[2].body, "hello 3");
    }

    #[test]
    fn set_subscribed_updates_flag() {
        let store = ChatStore::open_in_memory().unwrap();
        store.upsert_channel(&sample_channel(7)).unwrap();
        assert!(store.is_subscribed_cluster("cluster-7", 7).unwrap());
        store.set_subscribed("cluster-7", false).unwrap();
        let channels = store.list_channels().unwrap();
        assert!(!channels[0].subscribed);
        assert!(!store.is_subscribed_cluster("cluster-7", 7).unwrap());
        assert!(!store.is_subscribed_cluster("cluster-8", 8).unwrap());
    }

    #[test]
    fn file_store_persists_channels_and_signed_messages_across_reopen() {
        let root = std::env::temp_dir().join(format!(
            "monarch-chat-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();

        {
            let store = ChatStore::open(&root).unwrap();
            store.upsert_channel(&sample_channel(1)).unwrap();
            store
                .insert_message(&sample_message("cluster-1", 1))
                .unwrap();
        }

        let reopened = ChatStore::open(&root).unwrap();
        let channels = reopened.list_channels().unwrap();
        assert_eq!(channels.len(), 1);
        assert!(channels[0].subscribed);
        assert!(reopened.is_subscribed_cluster("cluster-1", 1).unwrap());

        let messages = reopened.messages_for_channel("cluster-1", 10).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].sender_pubkey_hex, "0x1234");
        assert_eq!(messages[0].nonce_hex, "0x00000000000000000000000000000001");
        assert_eq!(messages[0].cluster_id, 1);

        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}
