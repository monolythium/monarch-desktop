import { describe, expect, it } from "vitest";
import {
  MONARCH_ACTIVE_OPERATOR_SEATS,
  MONARCH_CLUSTER_SIZE,
  MONARCH_CLUSTER_THRESHOLD,
  MONARCH_STANDBY_OPERATOR_SEATS,
  MONARCH_TARGET_CLUSTER_COUNT,
  DEFAULT_ACTIVE_CLUSTER_ID,
  clusterLabel,
  evaluateClusterModel,
  targetClusterSummary,
} from "./clusterModel";
import type { ClusterStatus } from "./hooks";

function cluster(overrides: Partial<ClusterStatus> = {}): ClusterStatus {
  return {
    id: 1,
    threshold: MONARCH_CLUSTER_THRESHOLD,
    size: MONARCH_CLUSTER_SIZE,
    state: "nominal",
    members: Array.from({ length: MONARCH_CLUSTER_SIZE }, (_, index) => ({
      id: index + 1,
      operatorId: `operator-${index + 1}`,
      handle: `op-${index + 1}`,
      state: "nominal" as const,
    })),
    epoch: 1,
    anchorAddress: "monok1cluster",
    ...overrides,
  };
}

describe("clusterLabel", () => {
  it("targets the genesis cluster by default", () => {
    expect(DEFAULT_ACTIVE_CLUSTER_ID).toBe(0);
    expect(clusterLabel(DEFAULT_ACTIVE_CLUSTER_ID)).toBe("C-000");
  });

  it("formats public cluster ids with the canonical C-### label", () => {
    expect(clusterLabel(1)).toBe("C-001");
    expect(clusterLabel(42)).toBe("C-042");
    expect(clusterLabel(null)).toBe("C---");
  });
});

describe("targetClusterSummary", () => {
  it("pins the whitepaper target topology", () => {
    expect(MONARCH_TARGET_CLUSTER_COUNT).toBe(100);
    expect(MONARCH_CLUSTER_SIZE).toBe(10);
    expect(MONARCH_CLUSTER_THRESHOLD).toBe(7);
    expect(MONARCH_ACTIVE_OPERATOR_SEATS).toBe(7);
    expect(MONARCH_STANDBY_OPERATOR_SEATS).toBe(3);
    expect(targetClusterSummary(null)).toBe("100 clusters x 10 operator seats");
    expect(targetClusterSummary(12)).toBe("12/100 clusters x 10 operator seats");
  });
});

describe("evaluateClusterModel", () => {
  it("marks the 7-of-10 topology as aligned when quorum is live", () => {
    expect(evaluateClusterModel(cluster(), 100)).toMatchObject({
      state: "aligned",
      label: "whitepaper topology",
      liveOperators: 10,
      offlineOperators: 0,
      standbySeats: 3,
      blockers: [],
    });
  });

  it("reports topology drift instead of silently accepting non-whitepaper clusters", () => {
    const report = evaluateClusterModel(cluster({ threshold: 5, size: 7 }), 7);
    expect(report.state).toBe("partial");
    expect(report.blockers).toContain("expected 10 operator seats");
    expect(report.blockers).toContain("expected 7-of-10 threshold");
    expect(report.blockers).toContain("expected 3 standby seats");
  });

  it("degrades when live operators fall below the reported threshold", () => {
    const members = cluster().members.map((member, index) => ({
      ...member,
      state: index < 4 ? "jail" as const : "nominal" as const,
    }));
    const report = evaluateClusterModel(cluster({ members }), 100);
    expect(report.state).toBe("degraded");
    expect(report.liveOperators).toBe(6);
    expect(report.offlineOperators).toBe(4);
    expect(report.blockers).toContain("live operators below cluster threshold");
  });
});
