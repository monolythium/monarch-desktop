import { describe, expect, it } from "vitest";
import {
  EMPTY_PREFLIGHT_PROBES,
  OPERATOR_SIGNED_KINDS,
  buildPreflightRows,
  preflightBlocked,
  preflightNeeds,
  requiredBondLythoshi,
  type PreflightProbes,
} from "./preflight";
import { FOUNDATION_OP_KINDS } from "./errors";
import { MIN_REGISTER_BOND_LYTHOSHI } from "../sdk/onboarding";
import { OP_KINDS, type OpKind, type OpRequest } from "./types";

function req(partial: Partial<OpRequest> & { kind: OpKind }): OpRequest {
  return { title: "t", sub: "s", intro: "i", fields: [], ...partial };
}

function probes(overrides: Partial<PreflightProbes>): PreflightProbes {
  return { ...EMPTY_PREFLIGHT_PROBES, ...overrides };
}

describe("preflightNeeds", () => {
  it("never marks a verb both operator-signed and foundation-signed", () => {
    for (const kind of OP_KINDS) {
      expect(OPERATOR_SIGNED_KINDS.has(kind) && FOUNDATION_OP_KINDS.has(kind), kind).toBe(false);
    }
  });

  it("requires the seal key only for cluster join requests", () => {
    for (const kind of OP_KINDS) {
      expect(preflightNeeds(kind).sealEk, kind).toBe(kind === "cluster-request-join");
    }
  });

  it("requires the service stopped only for export-backup", () => {
    for (const kind of OP_KINDS) {
      expect(preflightNeeds(kind).service, kind).toBe(kind === "export-backup");
    }
  });
});

describe("requiredBondLythoshi", () => {
  it("floors register at 5,000 LYTH even when the form says less", () => {
    const low = req({
      kind: "operator-register",
      registerInput: { endpoint: "e", capabilities: 1, bondLythoshi: "1" },
    });
    expect(requiredBondLythoshi(low)).toBe(MIN_REGISTER_BOND_LYTHOSHI);
  });

  it("uses the larger of form bond and the floor", () => {
    const high = req({
      kind: "operator-register",
      registerInput: {
        endpoint: "e",
        capabilities: 1,
        bondLythoshi: (MIN_REGISTER_BOND_LYTHOSHI * 2n).toString(),
      },
    });
    expect(requiredBondLythoshi(high)).toBe(MIN_REGISTER_BOND_LYTHOSHI * 2n);
  });
});

describe("buildPreflightRows", () => {
  it("blocks register when the key is verified missing, with a Keys fix-it", () => {
    const rows = buildPreflightRows(
      req({ kind: "operator-register" }),
      probes({ inTauri: true, hasOperatorKey: false }),
    );
    const key = rows.find((row) => row.id === "operator-key");
    expect(key?.status).toBe("fail");
    expect(key?.fixRoute).toBe("/keys");
    expect(preflightBlocked(rows)).toBe(true);
  });

  it("never blocks on unverifiable probes (browser preview)", () => {
    const rows = buildPreflightRows(req({ kind: "operator-register" }), EMPTY_PREFLIGHT_PROBES);
    expect(rows.every((row) => row.status === "unknown")).toBe(true);
    expect(preflightBlocked(rows)).toBe(false);
  });

  it("flags duplicate registration as a blocking failure for register", () => {
    const rows = buildPreflightRows(
      req({ kind: "operator-register" }),
      probes({ inTauri: true, hasOperatorKey: true, registered: true }),
    );
    const registration = rows.find((row) => row.id === "registration");
    expect(registration?.status).toBe("fail");
    expect(registration?.detail).toMatch(/already registered/i);
  });

  it("requires registration + published seal key + balance for a join request", () => {
    const request = req({
      kind: "cluster-request-join",
      clusterJoinRequestInput: {
        clusterId: "1",
        operatorPubkeyHex: "0xab",
        bondLythoshi: (5000n * 10n ** 18n).toString(),
      },
    });
    const rows = buildPreflightRows(
      request,
      probes({
        inTauri: true,
        hasOperatorKey: true,
        registered: false,
        sealEkPublished: false,
        balanceLythoshi: 1n,
        walletAddress: "mono1example",
      }),
    );
    const ids = Object.fromEntries(rows.map((row) => [row.id, row.status]));
    expect(ids["registration"]).toBe("fail");
    expect(ids["seal-ek"]).toBe("fail");
    expect(ids["balance"]).toBe("fail");
    expect(preflightBlocked(rows)).toBe(true);
  });

  it("passes a fully-prepared join request", () => {
    const request = req({
      kind: "cluster-request-join",
      clusterJoinRequestInput: {
        clusterId: "1",
        operatorPubkeyHex: "0xab",
        bondLythoshi: (5000n * 10n ** 18n).toString(),
      },
    });
    const rows = buildPreflightRows(
      request,
      probes({
        inTauri: true,
        hasOperatorKey: true,
        registered: true,
        sealEkPublished: true,
        balanceLythoshi: 6000n * 10n ** 18n,
      }),
    );
    expect(rows.every((row) => row.status === "ok")).toBe(true);
  });

  it("blocks foundation verbs without a foundation signer", () => {
    const rows = buildPreflightRows(
      req({ kind: "freeze-admission" }),
      probes({ inTauri: true, hasFoundationKey: false }),
    );
    const foundation = rows.find((row) => row.id === "foundation-key");
    expect(foundation?.status).toBe("fail");
    expect(foundation?.detail).toMatch(/foundation-only/i);
  });

  it("blocks export-backup while the service is running", () => {
    const running = buildPreflightRows(
      req({ kind: "export-backup" }),
      probes({ inTauri: true, serviceRunning: true }),
    );
    expect(running.find((row) => row.id === "service-stopped")?.status).toBe("fail");
    const stopped = buildPreflightRows(
      req({ kind: "export-backup" }),
      probes({ inTauri: true, serviceRunning: false }),
    );
    expect(stopped.find((row) => row.id === "service-stopped")?.status).toBe("ok");
  });
});
