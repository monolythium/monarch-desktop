import { describe, expect, it } from "vitest";
import type { ClusterResignationRow } from "@monolythium/core-sdk";
import {
  clusterResignationSummary,
  formatResignationHeight,
  resignationStatusTone,
} from "./clusterResignations";

const rows: ClusterResignationRow[] = [
  {
    operator: "0x" + "11".repeat(48),
    status: "wire_pending",
    nonce: 1n,
    expedited: true,
  },
  {
    operator: "0x" + "22".repeat(48),
    status: "pending",
    submitted_at_height: 100n,
    effective_at_height: 120n,
    nonce: 2n,
    expedited: false,
  },
  {
    operator: "0x" + "33".repeat(48),
    status: "applied",
    submitted_at_height: 90n,
    effective_at_height: 110n,
    nonce: 3n,
    expedited: false,
  },
];

describe("cluster resignation helpers", () => {
  it("summarizes pending, wire-pending, applied, and expedited rows", () => {
    expect(clusterResignationSummary(rows)).toEqual({
      total: 3,
      pending: 1,
      wirePending: 1,
      applied: 1,
      expedited: 1,
    });
  });

  it("maps resignation statuses to UI tones", () => {
    expect(resignationStatusTone("applied")).toBe("ok");
    expect(resignationStatusTone("wire_pending")).toBe("info");
    expect(resignationStatusTone("pending")).toBe("warn");
  });

  it("formats optional heights without showing fabricated values", () => {
    expect(formatResignationHeight(120n)).toBe("120");
    expect(formatResignationHeight(undefined)).toBe("not submitted");
  });
});
