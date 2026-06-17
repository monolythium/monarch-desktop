// Pure-helper tests for the node-status header feed. The hook + IPC wiring are
// covered indirectly (and need a DOM/Tauri shim); these assert the formatting
// and tone-mapping the header relies on to never show a bogus or red value.

import { describe, expect, it } from "vitest";
import { formatUptime, readyView, serviceTone, stageTone } from "./talosNodeStatus";

describe("formatUptime", () => {
  it("renders sub-minute durations in seconds", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(45)).toBe("45s");
    expect(formatUptime(59)).toBe("59s");
  });

  it("renders minutes and hours, two most-significant units", () => {
    expect(formatUptime(60)).toBe("1m");
    expect(formatUptime(12 * 60)).toBe("12m");
    expect(formatUptime(3 * 3600 + 25 * 60)).toBe("3h 25m");
  });

  it("renders days + hours and drops minutes once days are present", () => {
    expect(formatUptime(3 * 86_400 + 4 * 3600)).toBe("3d 4h");
    // Minutes are dropped when days lead (two-unit cap, largest first).
    expect(formatUptime(2 * 86_400 + 5 * 3600 + 30 * 60)).toBe("2d 5h");
    // Whole days with no remainder hours.
    expect(formatUptime(86_400)).toBe("1d");
  });

  it("degrades to em-dash for null / negative / non-finite", () => {
    expect(formatUptime(null)).toBe("—");
    expect(formatUptime(undefined)).toBe("—");
    expect(formatUptime(-5)).toBe("—");
    expect(formatUptime(Number.NaN)).toBe("—");
    expect(formatUptime(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("stageTone", () => {
  it("maps Running to ok and is case-insensitive", () => {
    expect(stageTone("Running")).toBe("ok");
    expect(stageTone("running")).toBe("ok");
  });

  it("maps transient stages to info", () => {
    expect(stageTone("Booting")).toBe("info");
    expect(stageTone("Installing")).toBe("info");
    expect(stageTone("Upgrading")).toBe("info");
    expect(stageTone("Rebooting")).toBe("info");
  });

  it("maps teardown / maintenance / unknown stages to warn", () => {
    expect(stageTone("Shutting down")).toBe("warn");
    expect(stageTone("Resetting")).toBe("warn");
    expect(stageTone("Maintenance")).toBe("warn");
    expect(stageTone("Unknown")).toBe("warn");
  });

  it("falls back to muted for an absent or unmapped stage", () => {
    expect(stageTone(null)).toBe("muted");
    expect(stageTone(undefined)).toBe("muted");
    expect(stageTone("")).toBe("muted");
    expect(stageTone("Hyperspace")).toBe("muted");
  });
});

describe("readyView", () => {
  it("reports Healthy when ready", () => {
    expect(readyView(true)).toEqual({ tone: "ok", label: "Healthy" });
  });

  it("reports the unmet-condition count when not ready", () => {
    expect(readyView(false)).toEqual({ tone: "warn", label: "Not ready" });
    expect(readyView(false, ["ext-protocore", "kubelet"])).toEqual({
      tone: "warn",
      label: "Not ready (2)",
    });
  });

  it("is muted when readiness was never reported", () => {
    expect(readyView(null)).toEqual({ tone: "muted", label: "—" });
    expect(readyView(undefined)).toEqual({ tone: "muted", label: "—" });
  });
});

describe("serviceTone", () => {
  it("passes the Rust severity vocabulary straight through", () => {
    expect(serviceTone("ok")).toBe("ok");
    expect(serviceTone("warn")).toBe("warn");
    expect(serviceTone("err")).toBe("err");
    expect(serviceTone("info")).toBe("info");
  });

  it("falls back to muted for an absent / unknown severity", () => {
    expect(serviceTone(null)).toBe("muted");
    expect(serviceTone(undefined)).toBe("muted");
    expect(serviceTone("weird")).toBe("muted");
  });
});
