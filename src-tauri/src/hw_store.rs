// Local-first hardware time-series — SQLite at
// `{app_local_data_dir}/monarch-desktop/hardware.db`.
//
// Mirrors `chat_store.rs`: a single `Connection` behind the app's async Mutex
// (rusqlite is synchronous; the calls are short and already serialized). One
// table, `hw_samples`, holds periodic resource snapshots the Hardware view
// records every few minutes while it is open. The view queries a trailing
// window to compute disk-growth deltas (24/48/72h), a linear fill-time
// projection, and the CPU/RAM sparklines — so the trends survive an app
// restart instead of starting from zero each launch.
//
// PURE READ on the node side: every value stored here is a snapshot of Talos
// *read* telemetry (mounts / memory / CPU load). Nothing in this module — or
// the commands that feed it — mutates the node.
//
// Retention: the window the UI cares about is a few days; we keep ~30 days of
// samples and FIFO-trim a generous row cap so the file can't grow unbounded.

use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Keep ~30 days at a ~3-minute cadence (≈14.4k rows) with headroom. A FIFO
/// trim past this cap bounds the file regardless of how long the app runs.
const MAX_SAMPLES: i64 = 50_000;

/// Drop samples older than this on insert. 31 days comfortably covers the
/// 72h projection window plus context; older points add nothing to the trend.
const RETENTION_MS: i64 = 31 * 24 * 60 * 60 * 1_000;

/// Sentinel CPU value persisted when the node could not report CPU busy. The
/// row still anchors disk/mem growth; the projection ignores the CPU field.
pub const CPU_UNAVAILABLE: f64 = -1.0;

#[derive(Debug, Error)]
pub enum HwStoreError {
    #[error("hardware store: sqlite error: {0}")]
    Sqlite(String),
    #[error("hardware store: could not create data directory: {0}")]
    Io(String),
}

impl From<rusqlite::Error> for HwStoreError {
    fn from(err: rusqlite::Error) -> Self {
        HwStoreError::Sqlite(err.to_string())
    }
}

/// One persisted resource sample. Field names match the TS `HwSample`
/// (`#[serde(rename_all = "camelCase")]`). Disk/mem totals of `0` and a
/// `cpu_pct` of `CPU_UNAVAILABLE` mean "the node didn't report it" — the
/// pure-TS projection treats those as missing rather than as a real zero.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HwSample {
    /// UNIX milliseconds.
    pub ts: i64,
    pub disk_used: i64,
    pub disk_total: i64,
    pub cpu_pct: f64,
    pub mem_used: i64,
    pub mem_total: i64,
}

pub struct HwStore {
    conn: Connection,
}

impl HwStore {
    /// Open (or create) the hardware database under
    /// `{app_local_data_dir}/monarch-desktop/hardware.db` and apply the
    /// embedded schema. The directory is created if missing.
    pub fn open(app_local_data_dir: &Path) -> Result<Self, HwStoreError> {
        let dir = app_local_data_dir.join("monarch-desktop");
        std::fs::create_dir_all(&dir).map_err(|e| HwStoreError::Io(e.to_string()))?;
        let db_path = dir.join("hardware.db");
        let conn = Connection::open(db_path)?;
        let store = Self { conn };
        store.apply_schema()?;
        Ok(store)
    }

    /// In-memory store for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, HwStoreError> {
        let conn = Connection::open_in_memory()?;
        let store = Self { conn };
        store.apply_schema()?;
        Ok(store)
    }

    fn apply_schema(&self) -> Result<(), HwStoreError> {
        self.conn.execute_batch(include_str!("hw_schema.sql"))?;
        Ok(())
    }

    /// Append a sample and enforce retention (age + row cap). Best-effort:
    /// the caller records one of these every few minutes, so a single failed
    /// insert never blocks the live snapshot.
    pub fn insert_sample(&self, sample: &HwSample) -> Result<(), HwStoreError> {
        self.conn.execute(
            "INSERT INTO hw_samples (ts, disk_used, disk_total, cpu_pct, mem_used, mem_total)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                sample.ts,
                sample.disk_used,
                sample.disk_total,
                sample.cpu_pct,
                sample.mem_used,
                sample.mem_total,
            ],
        )?;
        self.enforce_retention(sample.ts)?;
        Ok(())
    }

    /// Drop samples older than `RETENTION_MS` relative to the newest, then FIFO
    /// the oldest rows past `MAX_SAMPLES`.
    fn enforce_retention(&self, newest_ts: i64) -> Result<(), HwStoreError> {
        self.conn.execute(
            "DELETE FROM hw_samples WHERE ts < ?1",
            params![newest_ts - RETENTION_MS],
        )?;
        self.conn.execute(
            "DELETE FROM hw_samples
             WHERE rowid NOT IN (
               SELECT rowid FROM hw_samples ORDER BY ts DESC, rowid DESC LIMIT ?1
             )",
            params![MAX_SAMPLES],
        )?;
        Ok(())
    }

    /// All samples with `ts >= since_ms`, oldest first so the UI can plot them
    /// left-to-right and read the first/last for a delta.
    pub fn samples_since(&self, since_ms: i64) -> Result<Vec<HwSample>, HwStoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT ts, disk_used, disk_total, cpu_pct, mem_used, mem_total
             FROM hw_samples
             WHERE ts >= ?1
             ORDER BY ts ASC, rowid ASC",
        )?;
        let rows = stmt.query_map(params![since_ms], |row| {
            Ok(HwSample {
                ts: row.get(0)?,
                disk_used: row.get(1)?,
                disk_total: row.get(2)?,
                cpu_pct: row.get(3)?,
                mem_used: row.get(4)?,
                mem_total: row.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(ts: i64, disk_used: i64) -> HwSample {
        HwSample {
            ts,
            disk_used,
            disk_total: 100_000_000_000,
            cpu_pct: 12.5,
            mem_used: 4_000_000_000,
            mem_total: 16_000_000_000,
        }
    }

    #[test]
    fn round_trips_a_sample() {
        let store = HwStore::open_in_memory().unwrap();
        store.insert_sample(&sample(1_700_000_000_000, 10)).unwrap();
        let rows = store.samples_since(0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].ts, 1_700_000_000_000);
        assert_eq!(rows[0].disk_used, 10);
        assert_eq!(rows[0].disk_total, 100_000_000_000);
        assert!((rows[0].cpu_pct - 12.5).abs() < f64::EPSILON);
        assert_eq!(rows[0].mem_used, 4_000_000_000);
        assert_eq!(rows[0].mem_total, 16_000_000_000);
    }

    #[test]
    fn samples_since_filters_and_orders_oldest_first() {
        let store = HwStore::open_in_memory().unwrap();
        // Insert out of order; expect ascending output and the `since` filter.
        store.insert_sample(&sample(3_000, 30)).unwrap();
        store.insert_sample(&sample(1_000, 10)).unwrap();
        store.insert_sample(&sample(2_000, 20)).unwrap();

        let all = store.samples_since(0).unwrap();
        assert_eq!(
            all.iter().map(|s| s.ts).collect::<Vec<_>>(),
            vec![1_000, 2_000, 3_000]
        );

        let recent = store.samples_since(2_000).unwrap();
        assert_eq!(
            recent.iter().map(|s| s.ts).collect::<Vec<_>>(),
            vec![2_000, 3_000]
        );
    }

    #[test]
    fn age_retention_drops_samples_older_than_window() {
        let store = HwStore::open_in_memory().unwrap();
        let now = 1_700_000_000_000;
        // Older than RETENTION_MS relative to the newest insert.
        store.insert_sample(&sample(now - RETENTION_MS - 1, 1)).unwrap();
        store.insert_sample(&sample(now, 2)).unwrap();
        // The newest insert triggers the age trim, evicting the stale row.
        let rows = store.samples_since(0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].ts, now);
    }

    #[test]
    fn cpu_unavailable_sentinel_round_trips() {
        let store = HwStore::open_in_memory().unwrap();
        let mut s = sample(42, 0);
        s.cpu_pct = CPU_UNAVAILABLE;
        s.disk_total = 0;
        s.mem_total = 0;
        store.insert_sample(&s).unwrap();
        let rows = store.samples_since(0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].cpu_pct, CPU_UNAVAILABLE);
        assert_eq!(rows[0].disk_total, 0);
    }

    #[test]
    fn file_store_persists_across_reopen() {
        let root = std::env::temp_dir().join(format!(
            "monarch-hw-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();

        {
            let store = HwStore::open(&root).unwrap();
            store.insert_sample(&sample(1_000, 11)).unwrap();
            store.insert_sample(&sample(2_000, 22)).unwrap();
        }

        let reopened = HwStore::open(&root).unwrap();
        let rows = reopened.samples_since(0).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].disk_used, 11);
        assert_eq!(rows[1].disk_used, 22);

        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}
