import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked sdk surface the resolver depends on.
const talosStatus = vi.fn();
const talosHostTelemetry = vi.fn();
const talosMaintenanceDisks = vi.fn();

vi.mock("../../sdk", () => ({
  talosStatus: (...a: unknown[]) => talosStatus(...a),
  talosHostTelemetry: (...a: unknown[]) => talosHostTelemetry(...a),
  talosMaintenanceDisks: (...a: unknown[]) => talosMaintenanceDisks(...a),
}));

// Import after the mock is registered.
import { resolveNodeTarget } from "./resolveNodeTarget";

const STATUS_OK = {
  configured: true,
  reachable: false,
  endpoint: "https://10.0.0.5:50000",
  nodeAddress: "10.0.0.5",
  configPath: "/tmp/x.talosconfig",
  clientMode: "native",
  version: null,
  lastError: null,
};

beforeEach(() => {
  talosStatus.mockReset();
  talosHostTelemetry.mockReset();
  talosMaintenanceDisks.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveNodeTarget — active-connection anchoring", () => {
  it("resolves host from talosStatus even when telemetry throws (quarantined node)", async () => {
    talosStatus.mockResolvedValue(STATUS_OK);
    talosHostTelemetry.mockRejectedValue(new Error("telemetry read failed"));
    talosMaintenanceDisks.mockRejectedValue(new Error("not in maintenance"));

    const t = await resolveNodeTarget();
    expect(t.host).toBe("10.0.0.5");
    // Disk could not be resolved — operator fills it in manually.
    expect(t.disk).toBeNull();
  });

  it("falls back to talosMaintenanceDisks for the disk when telemetry has no usable disk", async () => {
    talosStatus.mockResolvedValue(STATUS_OK);
    talosHostTelemetry.mockResolvedValue({
      nodeAddress: "10.0.0.5",
      endpoint: "https://10.0.0.5:50000",
      disks: [], // telemetry returned no usable disk
    });
    talosMaintenanceDisks.mockResolvedValue([
      { deviceName: "/dev/sr0", model: "cd", sizeBytes: 1, sizeHuman: "1B", diskType: "cd", readonly: true, systemDiskHint: false },
      { deviceName: "/dev/vda", model: "vd", sizeBytes: 100, sizeHuman: "100B", diskType: "hdd", readonly: false, systemDiskHint: true },
    ]);

    const t = await resolveNodeTarget();
    expect(t.host).toBe("10.0.0.5");
    expect(t.disk).toBe("/dev/vda");
    expect(talosMaintenanceDisks).toHaveBeenCalledWith("10.0.0.5");
  });

  it("prefers the telemetry system disk and never calls the maintenance fallback when telemetry resolves it", async () => {
    talosStatus.mockResolvedValue(STATUS_OK);
    talosHostTelemetry.mockResolvedValue({
      nodeAddress: "10.0.0.5",
      endpoint: "https://10.0.0.5:50000",
      disks: [
        { deviceName: "/dev/sda", systemDisk: true, readonly: false },
        { deviceName: "/dev/sdb", systemDisk: false, readonly: false },
      ],
    });

    const t = await resolveNodeTarget();
    expect(t.disk).toBe("/dev/sda");
    expect(talosMaintenanceDisks).not.toHaveBeenCalled();
  });

  it("never throws — both status and telemetry failing yields nulls, not a rejection", async () => {
    talosStatus.mockRejectedValue(new Error("status failed"));
    talosHostTelemetry.mockRejectedValue(new Error("telemetry failed"));

    const t = await resolveNodeTarget();
    expect(t).toEqual({ host: null, disk: null });
    // With no host, the maintenance-disk fallback must not be attempted.
    expect(talosMaintenanceDisks).not.toHaveBeenCalled();
  });
});
