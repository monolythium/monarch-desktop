import { describe, expect, it } from "vitest";
import { quorumImpact } from "./OperationsDrawer";
import type { ClusterStatus } from "../sdk/hooks";

const OPERATOR_A = "0xaaaa00000000000000000000000000000000000000000000000000000000aaaa";
const OPERATOR_B = "0xbbbb00000000000000000000000000000000000000000000000000000000bbbb";

function cluster(overrides: Partial<ClusterStatus> = {}): ClusterStatus {
  return {
    id: 0,
    threshold: 7,
    size: 10,
    state: "nominal",
    members: Array.from({ length: 10 }, (_, i) => ({
      id: i,
      operatorId: i === 0 ? OPERATOR_A : `0x${String(i).padStart(2, "0").repeat(32)}`,
      handle: `op-${i}`,
      state: "nominal" as const,
    })),
    epoch: 1,
    anchorAddress: null,
    ...overrides,
  };
}

describe("quorumImpact (service stop/restart verdict)", () => {
  it("returns not-applicable for non-stop/restart verbs", () => {
    expect(quorumImpact("operator-register", 0, cluster(), OPERATOR_A).kind).toBe(
      "not-applicable",
    );
  });

  it("renders the non-cluster branch for a relay/standalone node (clusterId === null)", () => {
    // The bug: a node with no consensus seat (clusterId === null) must NOT be
    // laundered into cluster 0 and shown cluster-0 quorum math.
    const impact = quorumImpact("operator-restart", null, cluster(), OPERATOR_A);
    expect(impact.kind).toBe("non-cluster");

    // The rendered copy for this branch must not borrow cluster math or the
    // "seat was not matched" estimate note.
    const COPY =
      "This node is not a consensus operator — restarting has no committee/quorum impact.";
    expect(COPY).not.toContain("quorum holds");
    expect(COPY).not.toContain("seat was not matched");
    expect(COPY).not.toContain("operators live");
  });

  it("stays non-cluster even when cluster data happens to be present", () => {
    // Even if a stale cluster-0 fetch leaked data in, a null seat must win:
    // the verdict is non-cluster, never quorum.
    expect(quorumImpact("operator-stop", null, cluster(), OPERATOR_A).kind).toBe(
      "non-cluster",
    );
  });

  it("reports unavailable when the seat is known but cluster data has not loaded", () => {
    expect(quorumImpact("operator-restart", 3, null, OPERATOR_A).kind).toBe("unavailable");
  });

  it("computes quorum math for a seated operator and counts the matched seat", () => {
    const impact = quorumImpact("operator-restart", 0, cluster(), OPERATOR_A);
    expect(impact).toEqual({
      kind: "quorum",
      verb: "Restarting",
      after: 9,
      size: 10,
      threshold: 7,
      holds: true,
      counted: true,
    });
  });

  it("flags quorum AT RISK and marks the seat uncounted when self is not a member", () => {
    const small = cluster({
      threshold: 7,
      size: 7,
      members: Array.from({ length: 7 }, (_, i) => ({
        id: i,
        operatorId: `0x${String(i + 20).padStart(2, "0").repeat(32)}`,
        handle: `op-${i}`,
        state: "nominal" as const,
      })),
    });
    const impact = quorumImpact("operator-stop", 0, small, OPERATOR_B);
    expect(impact).toMatchObject({ kind: "quorum", holds: false, counted: false, after: 6 });
  });

  it("excludes jailed members from the live count", () => {
    const withJail = cluster();
    withJail.members[1] = { ...withJail.members[1]!, state: "jail" };
    const impact = quorumImpact("operator-restart", 0, withJail, OPERATOR_A);
    // 10 members, 1 jailed -> 9 live, minus the one going offline -> 8.
    expect(impact).toMatchObject({ kind: "quorum", after: 8 });
  });
});
