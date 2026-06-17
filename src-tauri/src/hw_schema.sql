-- Local-first hardware time-series for the Hardware view.
--
-- Periodic resource samples persisted so disk-growth / CPU / RAM trends survive
-- app restarts. One row per sample; the Hardware view records every few minutes
-- while it is open and queries a trailing window for the growth + fill-time
-- projection and the CPU/RAM sparklines. PURE READ on the node side — these are
-- snapshots of Talos *read* telemetry, never anything that mutates the node.

CREATE TABLE IF NOT EXISTS hw_samples (
    -- UNIX milliseconds the sample was taken (monotone-ish; client supplied).
    ts          INTEGER NOT NULL,
    -- Bytes used / total on the tracked data-dir mount. `disk_total` may be 0
    -- when the node didn't report a mount total; the projection treats a
    -- non-positive total as "unknown".
    disk_used   INTEGER NOT NULL,
    disk_total  INTEGER NOT NULL,
    -- CPU busy percent (0..100) at sample time, or -1 when the node could not
    -- report it (kept as a sentinel so the row still anchors disk growth).
    cpu_pct     REAL    NOT NULL,
    -- Bytes used / total of RAM, or 0 when unavailable.
    mem_used    INTEGER NOT NULL,
    mem_total   INTEGER NOT NULL
);

-- Trend queries are always "everything since T" ordered by time.
CREATE INDEX IF NOT EXISTS idx_hw_samples_ts ON hw_samples (ts);
