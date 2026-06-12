import { describe, expect, it } from "vitest";
import type { ActiveCharterView, ClusterDiversityView } from "@monolythium/core-sdk";
import {
  serviceRewardEarningsView,
  sumMemberShareBps,
  type ServiceRewardEarningsInputs,
} from "./serviceRewardEarnings";

const DIVERSITY: ClusterDiversityView = {
  clusterId: 1,
  score: 7350,
  asnVariance: 8000,
  geoVariance: 6500,
  hostingSpread: 7000,
};

const CHARTER: ActiveCharterView = {
  present: true,
  delegatorShareBps: 2000,
  // 7 active seats + 3 standby — operator-pot shares sum to 10000.
  memberShareBps: [1600, 1600, 1600, 1600, 1200, 1200, 1200, 0, 0, 0],
};

function inputs(overrides: Partial<ServiceRewardEarningsInputs> = {}): ServiceRewardEarningsInputs {
  return {
    score: 42_000n,
    diversity: DIVERSITY,
    proverActive: false,
    charter: CHARTER,
    ...overrides,
  };
}

describe("sumMemberShareBps", () => {
  it("sums the per-seat operator-pot shares to the operator pot", () => {
    expect(sumMemberShareBps(CHARTER.memberShareBps)).toBe(10000);
  });

  it("ignores non-finite entries", () => {
    expect(sumMemberShareBps([5000, Number.NaN, 5000])).toBe(10000);
    expect(sumMemberShareBps([])).toBe(0);
  });
});

describe("serviceRewardEarningsView", () => {
  it("surfaces the settled ServiceScore as the headline reward weight", () => {
    const view = serviceRewardEarningsView(inputs());
    expect(view.score).toBe(42_000n);
    expect(view.scored).toBe(true);
    expect(view.scoreLabel).toBe("42000");
    expect(view.summary).toContain("proved service, not stake");
  });

  it("emits the six scored service families in a stable order", () => {
    const view = serviceRewardEarningsView(inputs());
    expect(view.families.map((f) => f.key)).toEqual([
      "base",
      "archive",
      "prover",
      "rpc",
      "indexer",
      "diversity",
    ]);
  });

  it("reads the diversity sub-breakdown live (never fabricated)", () => {
    const view = serviceRewardEarningsView(inputs());
    const diversity = view.families.find((f) => f.key === "diversity");
    expect(diversity?.status).toBe("active");
    expect(diversity?.detail).toBe(
      "73.5% spread · ASN 80.0% · geo 65.0% · hosting 70.0%",
    );
  });

  it("marks diversity unknown when the read is gated", () => {
    const view = serviceRewardEarningsView(inputs({ diversity: null }));
    const diversity = view.families.find((f) => f.key === "diversity");
    expect(diversity?.status).toBe("unknown");
    expect(diversity?.detail).toContain("not exposed");
  });

  it("reflects the live prover-market signal on the prover family", () => {
    const off = serviceRewardEarningsView(inputs({ proverActive: false }));
    expect(off.families.find((f) => f.key === "prover")?.status).toBe("available");
    const on = serviceRewardEarningsView(inputs({ proverActive: true }));
    expect(on.families.find((f) => f.key === "prover")?.status).toBe("active");
    expect(on.families.find((f) => f.key === "prover")?.detail).toContain("serving");
  });

  it("does NOT fabricate per-family numbers for archive/rpc/indexer", () => {
    const view = serviceRewardEarningsView(inputs());
    for (const key of ["archive", "rpc", "indexer"] as const) {
      const fam = view.families.find((f) => f.key === key);
      expect(fam?.status).toBe("scored");
      expect(fam?.detail).toBe("scored on-chain from this cluster's service proofs");
      expect(fam?.detail).not.toMatch(/\d+%/u);
    }
  });

  it("derives the operator/delegator split from the active charter", () => {
    const view = serviceRewardEarningsView(inputs());
    expect(view.split.present).toBe(true);
    expect(view.split.operatorShareBps).toBe(10000);
    expect(view.split.delegatorShareBps).toBe(2000);
  });

  it("reports no explicit split for a legacy / unread charter", () => {
    const view = serviceRewardEarningsView(inputs({ charter: null }));
    expect(view.split.present).toBe(false);
    expect(view.split.operatorShareBps).toBe(0);
    const absent = serviceRewardEarningsView(
      inputs({ charter: { present: false, delegatorShareBps: 0, memberShareBps: [] } }),
    );
    expect(absent.split.present).toBe(false);
  });

  it("treats a zero ServiceScore as 'not scored yet', not an error", () => {
    const view = serviceRewardEarningsView(inputs({ score: 0n }));
    expect(view.score).toBe(0n);
    expect(view.scored).toBe(false);
    expect(view.summary).toContain("not been scored yet");
  });

  it("handles a missing ServiceScore read (null) honestly", () => {
    const view = serviceRewardEarningsView(inputs({ score: null }));
    expect(view.score).toBeNull();
    expect(view.scored).toBe(false);
    expect(view.scoreLabel).toBe("—");
    expect(view.summary).toContain("unavailable");
  });
});
