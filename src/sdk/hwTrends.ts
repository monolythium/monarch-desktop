// Pure, testable disk-growth + fill-time projection for the Hardware view.
//
// No React, no Tauri, no I/O — just the math over a window of locally-persisted
// resource samples (`HwSample`, mirroring the Rust `hw_store::HwSample`) plus an
// optional *immediate* estimate derived from the node itself so the operator
// gets a projection on first open, before any local history has accrued.
//
// HONESTY RULES (matched by the tests):
//   * A non-positive growth pace, or a disk already at/over capacity, yields a
//     `null` projection that the UI renders as "unknown" — never a fake number.
//   * Too few samples (or too short a span) to trust a delta yields `null` for
//     the local pace; the caller then falls back to the immediate estimate.
//   * Disk/mem totals of 0 and a `cpuPct` sentinel of -1 mean "the node didn't
//     report it" — those points don't anchor a real value.

/** One persisted resource sample. Mirrors the Rust `hw_store::HwSample`
 *  (`#[serde(rename_all = "camelCase")]`). Bytes are absolute; `ts` is UNIX ms. */
export type HwSample = {
  ts: number;
  diskUsed: number;
  diskTotal: number;
  /** CPU busy percent (0..100), or -1 when the node couldn't report it. */
  cpuPct: number;
  memUsed: number;
  memTotal: number;
};

/** Sentinel a sample carries when CPU busy was unavailable at capture time. */
export const CPU_UNAVAILABLE = -1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A growth delta computed over one trailing window of local samples. */
export type DiskDelta = {
  /** Window label in hours (24 / 48 / 72), for display. */
  windowHours: number;
  /** Bytes the disk-used figure grew across the measured span. Can be negative
   *  (e.g. after a log cleanup). */
  deltaBytes: number;
  /** Milliseconds actually spanned by the first/last sample in the window
   *  (≤ the requested window; the local history may be shorter). */
  spanMs: number;
  /** Linear pace over the measured span. `deltaBytes / spanDays`. */
  bytesPerDay: number;
};

/**
 * Compute the disk-used growth pace over the trailing `windowHours`. Picks the
 * earliest sample at-or-after `(now - window)` and the latest sample, and
 * linearises the delta to bytes/day over the span they actually cover.
 *
 * Returns `null` when there aren't at least two samples in the window, or the
 * span is shorter than `minSpanMs` (so a couple of points seconds apart can't
 * produce a wild pace). A negative or zero delta still returns a value (the
 * caller decides what a non-positive pace means for the projection).
 */
export function diskDeltaOverWindow(
  samples: readonly HwSample[],
  windowHours: number,
  nowMs: number,
  minSpanMs = 60 * 60 * 1000,
): DiskDelta | null {
  if (!Number.isFinite(windowHours) || windowHours <= 0) return null;
  const cutoff = nowMs - windowHours * 60 * 60 * 1000;
  const inWindow = samples.filter((s) => s.ts >= cutoff && s.ts <= nowMs);
  if (inWindow.length < 2) return null;
  // `samples` is oldest-first from the store, but don't assume it.
  const sorted = [...inWindow].sort((a, b) => a.ts - b.ts);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const spanMs = last.ts - first.ts;
  if (spanMs < minSpanMs) return null;
  const deltaBytes = last.diskUsed - first.diskUsed;
  const bytesPerDay = (deltaBytes / spanMs) * MS_PER_DAY;
  return { windowHours, deltaBytes, spanMs, bytesPerDay };
}

/**
 * Immediate growth pace from the unbounded append-only log file: its current
 * size divided by its age. Used on first open when there's no local history.
 * `null` when the age is non-positive or the size is negative — no fake pace.
 */
export function immediateEstimateFromLogfile(input: {
  logfileSize: number;
  logfileAgeMs: number;
}): number | null {
  const { logfileSize, logfileAgeMs } = input;
  if (!Number.isFinite(logfileSize) || logfileSize < 0) return null;
  if (!Number.isFinite(logfileAgeMs) || logfileAgeMs <= 0) return null;
  const ageDays = logfileAgeMs / MS_PER_DAY;
  if (ageDays <= 0) return null;
  return logfileSize / ageDays;
}

/**
 * Immediate growth pace from the data directory size and the node's uptime:
 * `datadirSize / uptimeDays`. A coarse "how fast has the chain DB grown since
 * boot" pace for the first-open case. `null` when uptime is non-positive or the
 * size is negative.
 */
export function immediateEstimateFromDatadir(input: {
  datadirSize: number;
  uptimeSeconds: number;
}): number | null {
  const { datadirSize, uptimeSeconds } = input;
  if (!Number.isFinite(datadirSize) || datadirSize < 0) return null;
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds <= 0) return null;
  const uptimeDays = uptimeSeconds / (24 * 60 * 60);
  if (uptimeDays <= 0) return null;
  return datadirSize / uptimeDays;
}

/**
 * Days until the disk fills at `bytesPerDay`. `null` (→ "unknown") when the pace
 * is non-positive, the inputs are unusable, or the disk is already full. The
 * projection is honest about pace: a flat or shrinking disk has no finite fill
 * time.
 */
export function projectDiskFillDays(input: {
  used: number;
  total: number;
  bytesPerDay: number;
}): number | null {
  const { used, total, bytesPerDay } = input;
  if (![used, total, bytesPerDay].every(Number.isFinite)) return null;
  if (total <= 0 || used < 0) return null;
  if (bytesPerDay <= 0) return null;
  const remaining = total - used;
  if (remaining <= 0) return 0; // already full
  return remaining / bytesPerDay;
}

/**
 * Human, honest fill-time string. `null`/non-finite → "unknown". 0 → "full".
 * Sub-week → "~N days"; sub-year → "~N weeks"; otherwise ">1 year". Rounds to
 * keep the operator from over-reading a linear extrapolation.
 */
export function formatFillTime(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days)) {
    return "unknown";
  }
  if (days <= 0) return "full";
  if (days < 1) return "< 1 day";
  if (days < 14) return `~${Math.round(days)} days`;
  if (days < 365) return `~${Math.round(days / 7)} weeks`;
  return "> 1 year";
}

/** Severity for a fill-time projection, matching the app's halo vocabulary. */
export type FillTone = "ok" | "warn" | "err" | "muted";

/** Thresholds (days) at/under which the disk-fill warning fires. */
export const FILL_WARN_DAYS = 30;
export const FILL_CRITICAL_DAYS = 7;

/**
 * Tone for a projection: critical (≤ 7d) → err, warning (≤ 30d) → warn,
 * comfortable → ok, unknown → muted.
 */
export function fillTone(days: number | null | undefined): FillTone {
  if (days === null || days === undefined || !Number.isFinite(days)) {
    return "muted";
  }
  if (days <= FILL_CRITICAL_DAYS) return "err";
  if (days <= FILL_WARN_DAYS) return "warn";
  return "ok";
}

/** Inputs for the combined disk-trend computation. */
export type DiskTrendInputs = {
  /** Local persisted samples (oldest-first ideally; re-sorted defensively). */
  samples: readonly HwSample[];
  /** Current disk used / total bytes from the live mount snapshot. */
  diskUsed: number;
  diskTotal: number;
  nowMs: number;
  /** First-open fallback estimate from the node, when local history is thin. */
  immediateBytesPerDay?: number | null;
};

/** The full disk-trend view the Hardware page renders. */
export type DiskTrend = {
  /** 24/48/72h deltas (each `null` when that window lacks usable samples). */
  deltas: {
    h24: DiskDelta | null;
    h48: DiskDelta | null;
    h72: DiskDelta | null;
  };
  /** The pace the projection used: the longest available window's pace, else
   *  the immediate node estimate. `null` when nothing usable. */
  paceBytesPerDay: number | null;
  /** Where the pace came from, for an honest caption. */
  paceSource: "local-72h" | "local-48h" | "local-24h" | "immediate" | "none";
  /** Projected days-to-full (`null` → unknown / non-positive pace). */
  fillDays: number | null;
  tone: FillTone;
  /** True when `fillDays` is finite and ≤ the warning threshold. */
  warn: boolean;
};

/**
 * Combine the local-sample deltas with the immediate node estimate into the
 * single disk-trend view the UI shows. Prefers the longest local window with a
 * usable (positive-span) delta — more data, steadier pace — and only falls back
 * to the immediate estimate when no local window qualifies. The projection then
 * uses that pace against the live used/total.
 */
export function computeDiskTrend(inputs: DiskTrendInputs): DiskTrend {
  const { samples, diskUsed, diskTotal, nowMs, immediateBytesPerDay } = inputs;
  const h24 = diskDeltaOverWindow(samples, 24, nowMs);
  const h48 = diskDeltaOverWindow(samples, 48, nowMs);
  const h72 = diskDeltaOverWindow(samples, 72, nowMs);

  // Prefer the longest window that has a delta; its pace is the steadiest.
  let paceBytesPerDay: number | null = null;
  let paceSource: DiskTrend["paceSource"] = "none";
  if (h72) {
    paceBytesPerDay = h72.bytesPerDay;
    paceSource = "local-72h";
  } else if (h48) {
    paceBytesPerDay = h48.bytesPerDay;
    paceSource = "local-48h";
  } else if (h24) {
    paceBytesPerDay = h24.bytesPerDay;
    paceSource = "local-24h";
  } else if (immediateBytesPerDay != null && Number.isFinite(immediateBytesPerDay)) {
    paceBytesPerDay = immediateBytesPerDay;
    paceSource = "immediate";
  }

  const fillDays =
    paceBytesPerDay != null
      ? projectDiskFillDays({
          used: diskUsed,
          total: diskTotal,
          bytesPerDay: paceBytesPerDay,
        })
      : null;

  const tone = fillTone(fillDays);
  const warn = fillDays != null && Number.isFinite(fillDays) && fillDays <= FILL_WARN_DAYS;

  return {
    deltas: { h24, h48, h72 },
    paceBytesPerDay,
    paceSource,
    fillDays,
    tone,
    warn,
  };
}

/** Format a bytes/day pace compactly (e.g. "1.2 GiB/day"). "—" when null. */
export function formatPacePerDay(bytesPerDay: number | null | undefined): string {
  if (bytesPerDay === null || bytesPerDay === undefined || !Number.isFinite(bytesPerDay)) {
    return "—";
  }
  const sign = bytesPerDay < 0 ? "-" : "";
  const abs = Math.abs(bytesPerDay);
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = abs;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${sign}${value.toFixed(digits)} ${units[unit]}/day`;
}
