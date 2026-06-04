import { describe, expect, it } from "vitest";
import { mapClusterStatus, mapOperatorInfo } from "./hooks";

const operatorId = `0x${"12".repeat(32)}`;
const chainAddress = "mono1operator";
const legacyRosterKey = `0x${"34".repeat(48)}`;
const consensusRosterKey = `0x${"56".repeat(48)}`;

function operatorInfo(overrides: Record<string, unknown> = {}) {
  return {
    operatorId,
    moniker: null,
    alias: "volans",
    chainAddress,
    bonded: true,
    commissionBps: null,
    delegationCount: null,
    bondedAmount: "100000000",
    activeClusterIds: [0],
    operatorKeyFingerprint: "operator:fallback",
    blsKeyFingerprint: "legacy:fallback",
    lifecycleState: "active",
    capability: {},
    ...overrides,
  } as never;
}

function clusterStatus(members: Record<string, unknown>[]) {
  return {
    clusterId: 0,
    threshold: 1,
    size: members.length,
    live: members.length,
    lagging: 0,
    offline: 0,
    maintenance: 0,
    members,
    epoch: 12n,
    round: 42n,
    quorum: "ok",
    reputationScore: null,
    livenessScore: null,
    lastUpdateHeight: 256n,
  } as never;
}

describe("operator and cluster mappers", () => {
  it("prefers canonical consensus-key fingerprints", () => {
    expect(mapOperatorInfo(operatorInfo({
      consensusKeyFingerprint: "mldsa65:canonical",
      blsKeyFingerprint: "legacy:fallback",
    })).pubkey).toBe("mldsa65:canonical");
  });

  it("keeps legacy operator fingerprint fallback for current packaged SDK rows", () => {
    expect(mapOperatorInfo(operatorInfo()).pubkey).toBe("legacy:fallback");
    expect(mapOperatorInfo(operatorInfo({
      blsKeyFingerprint: null,
    })).pubkey).toBe("operator:fallback");
  });

  it("derives anchors from canonical consensus roster keys", () => {
    const mapped = mapClusterStatus(clusterStatus([
      { operatorId, consensusPubkey: consensusRosterKey, state: "active" },
      { operatorId: `0x${"78".repeat(32)}`, consensusPubkey: legacyRosterKey, state: "active" },
    ]));

    expect(mapped.anchorAddress).toMatch(/^monok1/);
  });

  it("keeps legacy roster-key fallback for current packaged SDK rows", () => {
    const mapped = mapClusterStatus(clusterStatus([
      { operatorId, blsPubkey: legacyRosterKey, state: "active" },
    ]));

    expect(mapped.anchorAddress).toMatch(/^monok1/);
  });
});
