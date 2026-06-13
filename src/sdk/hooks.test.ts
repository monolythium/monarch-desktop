import { describe, expect, it } from "vitest";
import {
  isMethodNotFound,
  isOperatorAuthorityUnavailable,
  mapClusterStatus,
  mapOperatorInfo,
} from "./hooks";

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

describe("rpc error classifiers", () => {
  it("treats a -32601 method-not-found as not-exposed", () => {
    expect(isMethodNotFound({ code: -32601, message: "method not found" })).toBe(true);
  });

  it("treats a -32045 method-disabled as not-exposed (drives the chain-status fallback)", () => {
    // The testnet fleet returns this for lyth_chainStatus; it must route to the
    // compose-from-primitives fallback, not surface as a hard error that blanks
    // operatorCount/clusterCount.
    expect(isMethodNotFound({ code: -32045, message: "method disabled: lyth_chainStatus" })).toBe(true);
    expect(isMethodNotFound({ message: "Method disabled" })).toBe(true);
  });

  it("does not treat an unrelated error as not-exposed", () => {
    expect(isMethodNotFound({ code: -32000, message: "execution reverted" })).toBe(false);
    expect(isMethodNotFound(null)).toBe(false);
  });

  it("does not mislabel a mempool -32045 spending-policy rejection as not-exposed", () => {
    // -32045 is overloaded: it's also SpendingPolicyDestinationNotAllowed. A
    // real policy rejection must surface as an error, not get hidden as "not
    // exposed" — so the bare code is not enough; the message must say so.
    expect(
      isMethodNotFound({ code: -32045, message: "spending policy: destination not allowed" }),
    ).toBe(false);
  });

  it("classifies the #53 malformed-BLS-pubkey authority error as unavailable, not a hard error", () => {
    expect(
      isOperatorAuthorityUnavailable({
        code: -32603,
        message: "internal error: provider returned malformed BLS pubkey for authority 0: must be 48 bytes, got 1952",
      }),
    ).toBe(true);
  });

  it("does not classify a generic -32603 internal error as authority-unavailable", () => {
    expect(isOperatorAuthorityUnavailable({ code: -32603, message: "internal error" })).toBe(false);
  });
});
