// Pure-helper test for the Hardware view's tracked-mount selection. The mount we
// project a fill time for must be the one carrying the protocore data dir (or,
// failing a clean match, the largest data partition) — not a tiny system mount.

import { describe, expect, it } from "vitest";
import type { TalosMountTelemetry } from "../sdk";
import { pickTrackedMount } from "./Hardware";

function mount(mountedOn: string, sizeGib: number): TalosMountTelemetry {
  const size = sizeGib * 1024 ** 3;
  return {
    filesystem: `dev${mountedOn}`,
    mountedOn,
    sizeBytes: size,
    availableBytes: size / 2,
    usedBytes: size / 2,
    usedPercent: 50,
  };
}

describe("pickTrackedMount", () => {
  it("returns null when no mounts are reported", () => {
    expect(pickTrackedMount([])).toBeNull();
  });

  it("prefers the mount that carries the protocore data dir", () => {
    const mounts = [mount("/", 4), mount("/var", 200), mount("/boot", 1)];
    expect(pickTrackedMount(mounts)?.mountedOn).toBe("/var");
  });

  it("prefers the most specific covering mount", () => {
    const mounts = [
      mount("/", 4),
      mount("/var", 50),
      mount("/var/lib/protocore", 500),
    ];
    expect(pickTrackedMount(mounts)?.mountedOn).toBe("/var/lib/protocore");
  });

  it("falls back to the largest mount when nothing covers the data dir", () => {
    const mounts = [mount("/mnt/a", 10), mount("/mnt/data", 800), mount("/mnt/b", 20)];
    expect(pickTrackedMount(mounts)?.mountedOn).toBe("/mnt/data");
  });
});
