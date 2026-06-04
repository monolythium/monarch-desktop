import { describe, expect, it } from "vitest";
import {
  CLUSTER_FORM_HEX_LENGTHS,
  CLUSTER_FORM_RUNTIME_NOTICE,
  clusterFormProposalSummary,
  isClusterFormInputComplete,
  parseClusterFormPubkeys,
} from "./ClusterFormProposalForm";
import {
  MONARCH_ACTIVE_OPERATOR_SEATS,
  MONARCH_STANDBY_OPERATOR_SEATS,
  NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
} from "../sdk";

function pubkey(byte: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES)}`;
}

function validInput() {
  return {
    activePubkeysHex: Array.from({ length: MONARCH_ACTIVE_OPERATOR_SEATS }, (_, index) =>
      pubkey(index + 1),
    ).join("\n"),
    standbyPubkeysHex: Array.from({ length: MONARCH_STANDBY_OPERATOR_SEATS }, (_, index) =>
      pubkey(index + 20),
    ).join("\n"),
  };
}

describe("cluster formation roster proposal", () => {
  it("pins the expected ML-DSA-65 consensus pubkey length", () => {
    expect(CLUSTER_FORM_HEX_LENGTHS.consensusPubkey).toBe(
      2 + NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES * 2,
    );
  });

  it("parses newline, comma, and whitespace separated pubkeys", () => {
    expect(parseClusterFormPubkeys(` ${pubkey(1)},\n${pubkey(2)} ${pubkey(3)} `)).toEqual([
      pubkey(1),
      pubkey(2),
      pubkey(3),
    ]);
  });

  it("accepts exactly 7 active and 3 standby unique consensus pubkeys", () => {
    const summary = clusterFormProposalSummary(validInput());

    expect(summary.ready).toBe(true);
    expect(summary.activeCount).toBe(7);
    expect(summary.standbyCount).toBe(3);
    expect(summary.totalCount).toBe(10);
    expect(summary.blockers).toEqual([]);
    expect(summary.roster).toHaveLength(10);
    expect(summary.roster[0]).toMatchObject({
      role: "active",
      index: 0,
    });
    expect(summary.roster[0]?.operatorIdHex).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(isClusterFormInputComplete(validInput())).toBe(true);
  });

  it("rejects wrong seat counts", () => {
    const summary = clusterFormProposalSummary({
      ...validInput(),
      standbyPubkeysHex: "",
    });

    expect(summary.ready).toBe(false);
    expect(summary.blockers).toContain("expected 3 standby operator pubkeys");
    expect(isClusterFormInputComplete({
      ...validInput(),
      standbyPubkeysHex: "",
    })).toBe(false);
  });

  it("rejects malformed and duplicate pubkeys across active and standby rosters", () => {
    const active = Array.from({ length: MONARCH_ACTIVE_OPERATOR_SEATS }, (_, index) =>
      index === 0 ? `0x${"aa".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES - 1)}` : pubkey(index + 1),
    ).join("\n");
    const standby = [pubkey(2), pubkey(30), pubkey(31)].join("\n");
    const summary = clusterFormProposalSummary({
      activePubkeysHex: active,
      standbyPubkeysHex: standby,
    });

    expect(summary.ready).toBe(false);
    expect(summary.invalidActiveCount).toBe(1);
    expect(summary.duplicateCount).toBe(1);
    expect(summary.blockers).toContain(
      `all pubkeys must be ${NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES} byte ML-DSA-65 consensus keys`,
    );
    expect(summary.blockers).toContain(
      "active and standby rosters must not reuse a consensus pubkey",
    );
  });

  it("states that formation execution remains blocked", () => {
    expect(CLUSTER_FORM_RUNTIME_NOTICE).toContain("fail-closed");
    expect(CLUSTER_FORM_RUNTIME_NOTICE).toContain("cluster-formation primitive");
  });
});
