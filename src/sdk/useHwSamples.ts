// Local hardware time-series hook for the Hardware view.
//
// Mirrors `useTalosNodeStatus`: self-contained, gated on `inTauri()`, degrades
// to an empty/idle state in the browser preview without fabricating data. While
// the view is open it periodically records the *current* resource snapshot the
// caller passes (already read from Talos read-RPC telemetry) into the on-disk
// SQLite store, and queries a trailing window so disk-growth + CPU/RAM trends
// survive an app restart.
//
// The recording is driven by the latest values handed in via a ref so the
// interval doesn't re-arm on every telemetry refresh; the query re-runs after
// each record (and on demand) so the projection stays current.

import { useCallback, useEffect, useRef, useState } from "react";
import { inTauri, queryHwSamples, recordHwSample, type HwSample } from "./bridge";
import { CPU_UNAVAILABLE } from "./hwTrends";

/** Default sample cadence: every 3 minutes while the view is open. Slow enough
 *  that a few days of history is a few thousand rows, fast enough that the 24h
 *  window has plenty of points. */
export const HW_SAMPLE_INTERVAL_MS = 3 * 60 * 1000;

/** How far back the view queries for the trend window (72h projection + slack). */
export const HW_QUERY_WINDOW_MS = 96 * 60 * 60 * 1000;

/** The current resource reading the hook should persist, or `null` when the
 *  node isn't reporting enough to anchor a disk sample. Bytes are absolute. */
export type HwSampleInput = {
  diskUsed: number;
  diskTotal: number;
  /** CPU busy percent (0..100), or null when unavailable → stored as -1. */
  cpuPct: number | null;
  memUsed: number;
  memTotal: number;
};

export type HwSamplesSlice = {
  /** The queried trailing window, oldest first. Empty outside Tauri. */
  samples: HwSample[];
  loading: boolean;
  error: string | null;
  /** Re-query the window now (e.g. after a manual refresh). */
  refresh: () => void;
};

/**
 * Persist + read the local hardware time-series.
 *
 * @param current  The latest resource reading to record, or null to skip
 *   recording this tick (e.g. while telemetry is unavailable). A disk total of
 *   0 means "not reported" and is stored as-is — `hwTrends` treats it as
 *   missing, so a bogus zero never anchors a projection.
 * @param options.active  When false the hook idles (no record, no query).
 * @param options.intervalMs  Record cadence; defaults to {@link HW_SAMPLE_INTERVAL_MS}.
 * @param options.windowMs  Query look-back; defaults to {@link HW_QUERY_WINDOW_MS}.
 */
export function useHwSamples(
  current: HwSampleInput | null,
  options?: { active?: boolean; intervalMs?: number; windowMs?: number },
): HwSamplesSlice {
  const active = options?.active ?? true;
  const intervalMs = options?.intervalMs ?? HW_SAMPLE_INTERVAL_MS;
  const windowMs = options?.windowMs ?? HW_QUERY_WINDOW_MS;
  const enabled = active && inTauri();

  const [samples, setSamples] = useState<HwSample[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Latest reading, read inside the interval without re-arming it.
  const currentRef = useRef<HwSampleInput | null>(current);
  currentRef.current = current;

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const runQuery = useCallback(async () => {
    if (!enabled) {
      setSamples([]);
      setLoading(false);
      return;
    }
    try {
      const since = Date.now() - windowMs;
      const rows = await queryHwSamples(since);
      setSamples(rows);
      setError(null);
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, [enabled, windowMs]);

  // Record a sample if a usable reading is available, then re-query.
  const recordAndQuery = useCallback(async () => {
    if (!enabled) return;
    const reading = currentRef.current;
    if (reading && Number.isFinite(reading.diskUsed)) {
      try {
        await recordHwSample({
          ts: Date.now(),
          diskUsed: Math.max(0, Math.round(reading.diskUsed)),
          diskTotal: Math.max(0, Math.round(reading.diskTotal)),
          cpuPct:
            reading.cpuPct != null && Number.isFinite(reading.cpuPct)
              ? reading.cpuPct
              : CPU_UNAVAILABLE,
          memUsed: Math.max(0, Math.round(reading.memUsed)),
          memTotal: Math.max(0, Math.round(reading.memTotal)),
        });
      } catch (err) {
        // A failed record is non-fatal — keep the last good window.
        setError((err as Error)?.message ?? String(err));
      }
    }
    await runQuery();
  }, [enabled, runQuery]);

  useEffect(() => {
    if (!enabled) {
      setSamples([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Query immediately so the view shows history at once; then record+requery
    // on the cadence so the first new point lands one interval in (avoids
    // double-recording right after a manual refresh).
    void runQuery();
    const timer = setInterval(() => {
      if (!cancelled) void recordAndQuery();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, intervalMs, runQuery, recordAndQuery, nonce]);

  return { samples, loading, error, refresh };
}
