// Pure-math tests for the Hardware view's disk-growth + fill-time projection.
// No DOM / Tauri — every function here is deterministic over plain inputs.

import { describe, expect, it } from "vitest";
import {
  computeDiskTrend,
  diskDeltaOverWindow,
  fillTone,
  formatFillTime,
  formatPacePerDay,
  immediateEstimateFromDatadir,
  immediateEstimateFromLogfile,
  projectDiskFillDays,
  type HwSample,
} from "./hwTrends";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;

function sample(ts: number, diskUsed: number, over: Partial<HwSample> = {}): HwSample {
  return {
    ts,
    diskUsed,
    diskTotal: 100 * GIB,
    cpuPct: 10,
    memUsed: 4 * GIB,
    memTotal: 16 * GIB,
    ...over,
  };
}

describe("diskDeltaOverWindow", () => {
  it("linearises a 1 GiB rise over 24h to ~1 GiB/day", () => {
    const now = 1_000_000_000_000;
    const samples = [
      sample(now - 24 * HOUR, 10 * GIB),
      sample(now - 12 * HOUR, 10.5 * GIB),
      sample(now, 11 * GIB),
    ];
    const d = diskDeltaOverWindow(samples, 24, now);
    expect(d).not.toBeNull();
    expect(d!.deltaBytes).toBeCloseTo(GIB, -3);
    // span is the full 24h → pace ≈ delta over 1 day.
    expect(d!.bytesPerDay).toBeCloseTo(GIB, -3);
    expect(d!.windowHours).toBe(24);
  });

  it("only counts samples inside the window", () => {
    const now = 1_000_000_000_000;
    const samples = [
      sample(now - 80 * HOUR, 5 * GIB), // outside a 48h window
      sample(now - 40 * HOUR, 9 * GIB),
      sample(now - 2 * HOUR, 11 * GIB),
    ];
    const d = diskDeltaOverWindow(samples, 48, now);
    expect(d).not.toBeNull();
    // delta is from the in-window first (9 GiB) to last (11 GiB) = 2 GiB.
    expect(d!.deltaBytes).toBeCloseTo(2 * GIB, -3);
  });

  it("returns null with fewer than two samples in the window", () => {
    const now = 1_000_000_000_000;
    expect(diskDeltaOverWindow([sample(now, 10 * GIB)], 24, now)).toBeNull();
    expect(diskDeltaOverWindow([], 24, now)).toBeNull();
  });

  it("returns null when the span is shorter than the minimum", () => {
    const now = 1_000_000_000_000;
    // Two samples 5 minutes apart — far below the 1h default min span.
    const samples = [sample(now - 5 * 60_000, 10 * GIB), sample(now, 10.1 * GIB)];
    expect(diskDeltaOverWindow(samples, 24, now)).toBeNull();
  });

  it("handles a negative delta (e.g. after a log cleanup)", () => {
    const now = 1_000_000_000_000;
    const samples = [sample(now - 24 * HOUR, 20 * GIB), sample(now, 18 * GIB)];
    const d = diskDeltaOverWindow(samples, 24, now);
    expect(d).not.toBeNull();
    expect(d!.bytesPerDay).toBeLessThan(0);
  });
});

describe("immediateEstimateFromLogfile", () => {
  it("derives pace from logfile size / age", () => {
    // 2 GiB accumulated over 4 days → 0.5 GiB/day.
    const pace = immediateEstimateFromLogfile({
      logfileSize: 2 * GIB,
      logfileAgeMs: 4 * DAY,
    });
    expect(pace).toBeCloseTo(0.5 * GIB, -3);
  });

  it("is null for a non-positive age", () => {
    expect(immediateEstimateFromLogfile({ logfileSize: GIB, logfileAgeMs: 0 })).toBeNull();
    expect(immediateEstimateFromLogfile({ logfileSize: GIB, logfileAgeMs: -DAY })).toBeNull();
  });

  it("is null for a negative size", () => {
    expect(immediateEstimateFromLogfile({ logfileSize: -1, logfileAgeMs: DAY })).toBeNull();
  });
});

describe("immediateEstimateFromDatadir", () => {
  it("derives pace from datadir size / uptime", () => {
    // 10 GiB over 5 days of uptime → 2 GiB/day.
    const pace = immediateEstimateFromDatadir({
      datadirSize: 10 * GIB,
      uptimeSeconds: 5 * 24 * 60 * 60,
    });
    expect(pace).toBeCloseTo(2 * GIB, -3);
  });

  it("is null for non-positive uptime", () => {
    expect(immediateEstimateFromDatadir({ datadirSize: GIB, uptimeSeconds: 0 })).toBeNull();
  });
});

describe("projectDiskFillDays", () => {
  it("computes remaining / pace", () => {
    // 90 GiB free, growing 3 GiB/day → 30 days.
    const days = projectDiskFillDays({
      used: 10 * GIB,
      total: 100 * GIB,
      bytesPerDay: 3 * GIB,
    });
    expect(days).toBeCloseTo(30, 5);
  });

  it("is null for a non-positive pace (flat or shrinking disk)", () => {
    expect(
      projectDiskFillDays({ used: 10 * GIB, total: 100 * GIB, bytesPerDay: 0 }),
    ).toBeNull();
    expect(
      projectDiskFillDays({ used: 10 * GIB, total: 100 * GIB, bytesPerDay: -GIB }),
    ).toBeNull();
  });

  it("is null for a missing total", () => {
    expect(projectDiskFillDays({ used: 10 * GIB, total: 0, bytesPerDay: GIB })).toBeNull();
  });

  it("returns 0 when already at/over capacity", () => {
    expect(
      projectDiskFillDays({ used: 100 * GIB, total: 100 * GIB, bytesPerDay: GIB }),
    ).toBe(0);
  });
});

describe("formatFillTime", () => {
  it("renders days, weeks, and the > 1 year cap", () => {
    expect(formatFillTime(3)).toBe("~3 days");
    expect(formatFillTime(21)).toBe("~3 weeks");
    expect(formatFillTime(400)).toBe("> 1 year");
  });

  it("renders edge cases honestly", () => {
    expect(formatFillTime(0)).toBe("full");
    expect(formatFillTime(0.5)).toBe("< 1 day");
    expect(formatFillTime(null)).toBe("unknown");
    expect(formatFillTime(undefined)).toBe("unknown");
    expect(formatFillTime(Number.POSITIVE_INFINITY)).toBe("unknown");
    expect(formatFillTime(Number.NaN)).toBe("unknown");
  });
});

describe("fillTone", () => {
  it("escalates as the projection shortens", () => {
    expect(fillTone(60)).toBe("ok");
    expect(fillTone(20)).toBe("warn");
    expect(fillTone(5)).toBe("err");
    expect(fillTone(null)).toBe("muted");
  });
});

describe("formatPacePerDay", () => {
  it("formats binary units with a sign", () => {
    expect(formatPacePerDay(2 * GIB)).toBe("2.0 GiB/day");
    expect(formatPacePerDay(-512 * 1024 * 1024)).toBe("-512 MiB/day");
    expect(formatPacePerDay(null)).toBe("—");
  });
});

describe("computeDiskTrend", () => {
  const now = 1_000_000_000_000;

  it("prefers the longest local window and projects from its pace", () => {
    // A clean 72h series growing 1 GiB/day.
    const samples: HwSample[] = [];
    for (let h = 72; h >= 0; h -= 6) {
      samples.push(sample(now - h * HOUR, (100 - h / 24) * GIB - 90 * GIB));
    }
    const trend = computeDiskTrend({
      samples,
      diskUsed: 10 * GIB,
      diskTotal: 100 * GIB,
      nowMs: now,
    });
    expect(trend.paceSource).toBe("local-72h");
    expect(trend.deltas.h72).not.toBeNull();
    expect(trend.paceBytesPerDay).toBeGreaterThan(0);
    expect(trend.fillDays).not.toBeNull();
  });

  it("falls back to the immediate estimate when local history is thin", () => {
    // Single sample → no usable window.
    const trend = computeDiskTrend({
      samples: [sample(now, 10 * GIB)],
      diskUsed: 10 * GIB,
      diskTotal: 100 * GIB,
      nowMs: now,
      immediateBytesPerDay: 3 * GIB, // → 90 GiB / 3 = 30 days
    });
    expect(trend.paceSource).toBe("immediate");
    expect(trend.fillDays).toBeCloseTo(30, 5);
    expect(trend.warn).toBe(true); // 30d is at the warn threshold
    expect(trend.tone).toBe("warn");
  });

  it("reports unknown (no warning) when there is no pace at all", () => {
    const trend = computeDiskTrend({
      samples: [sample(now, 10 * GIB)],
      diskUsed: 10 * GIB,
      diskTotal: 100 * GIB,
      nowMs: now,
    });
    expect(trend.paceSource).toBe("none");
    expect(trend.paceBytesPerDay).toBeNull();
    expect(trend.fillDays).toBeNull();
    expect(trend.warn).toBe(false);
    expect(trend.tone).toBe("muted");
    expect(formatFillTime(trend.fillDays)).toBe("unknown");
  });

  it("does not warn on a comfortable projection", () => {
    const trend = computeDiskTrend({
      samples: [sample(now, 10 * GIB)],
      diskUsed: 10 * GIB,
      diskTotal: 100 * GIB,
      nowMs: now,
      immediateBytesPerDay: 0.1 * GIB, // 90 GiB / 0.1 = 900 days
    });
    expect(trend.warn).toBe(false);
    expect(trend.tone).toBe("ok");
  });

  it("fires the warning when the disk is filling fast", () => {
    const trend = computeDiskTrend({
      samples: [sample(now, 95 * GIB)],
      diskUsed: 95 * GIB,
      diskTotal: 100 * GIB,
      nowMs: now,
      immediateBytesPerDay: 5 * GIB, // 5 GiB free / 5 = 1 day
    });
    expect(trend.warn).toBe(true);
    expect(trend.tone).toBe("err");
    expect(trend.fillDays).toBeCloseTo(1, 5);
  });
});
