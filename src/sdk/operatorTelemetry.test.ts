import { describe, expect, it } from "vitest";
import type {
  OperatorRiskResponse,
  OperatorSigningActivityResponse,
} from "@monolythium/core-sdk";
import { operatorRiskView, signingActivityView } from "./operatorTelemetry";

const baseRisk: OperatorRiskResponse = {
  schemaVersion: 1,
  authorityIndex: 3,
  dataHeight: 1000n,
  windowRounds: 200,
  missedRounds: 2,
  observedRounds: 200,
  missRateBps: 100,
  thresholdBps: 500,
  remainingHeadroomBps: 400,
  jailStatus: {
    jailed: false,
    tombstoned: false,
    jailedUntilHeight: 0n,
    unjailCount: 0n,
  },
  reasons: [],
};

describe("operatorRiskView", () => {
  it("maps a healthy risk window to low risk", () => {
    const view = operatorRiskView(baseRisk);

    expect(view.tone).toBe("ok");
    expect(view.label).toBe("low");
    expect(view.fillPct).toBe(1);
    expect(view.thresholdPct).toBe(5);
    expect(view.detail).toContain("2/200 missed rounds");
  });

  it("escalates when the jail-status window reports removal state", () => {
    const view = operatorRiskView({
      ...baseRisk,
      jailStatus: {
        jailed: true,
        tombstoned: false,
        jailedUntilHeight: 1200n,
        unjailCount: 1n,
      },
    });

    expect(view.tone).toBe("err");
    expect(view.label).toBe("jailed");
  });
});

describe("signingActivityView", () => {
  it("summarizes signed, missed, and no-certificate rounds", () => {
    const activity: OperatorSigningActivityResponse = {
      schemaVersion: 1,
      authorityIndex: 3,
      currentRound: 600n,
      limit: 4,
      entries: [
        { round: 597n, status: "signed" },
        { round: 598n, status: "missed" },
        { round: 599n, status: "no_cert" },
        { round: 600n, status: "signed" },
      ],
    };

    const view = signingActivityView(activity);

    expect(view.observed).toBe(4);
    expect(view.signed).toBe(2);
    expect(view.missed).toBe(1);
    expect(view.noCert).toBe(1);
    expect(view.signedPctLabel).toBe("50.0%");
  });
});
