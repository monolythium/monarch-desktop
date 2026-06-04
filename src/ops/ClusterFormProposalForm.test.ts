import { describe, expect, it } from "vitest";
import {
  CLUSTER_FORM_HEX_LENGTHS,
  CLUSTER_FORM_RUNTIME_NOTICE,
  clusterFormProposalSummary,
  isClusterFormInputComplete,
  parseClusterFormPubkeys,
  parseClusterFormSignatures,
} from "./ClusterFormProposalForm";
import {
  FORM_CLUSTER_MEMBER_COUNT,
  FORM_CLUSTER_SIGNATURE_BYTES,
  MONARCH_ACTIVE_OPERATOR_SEATS,
  MONARCH_STANDBY_OPERATOR_SEATS,
  NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
} from "../sdk";

function pubkey(byte: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES)}`;
}

function sig(byte: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(FORM_CLUSTER_SIGNATURE_BYTES)}`;
}

function validInput() {
  return {
    activePubkeysHex: Array.from({ length: MONARCH_ACTIVE_OPERATOR_SEATS }, (_, index) =>
      pubkey(index + 1),
    ).join("\n"),
    standbyPubkeysHex: Array.from({ length: MONARCH_STANDBY_OPERATOR_SEATS }, (_, index) =>
      pubkey(index + 20),
    ).join("\n"),
    signaturesHex: Array.from({ length: FORM_CLUSTER_MEMBER_COUNT }, (_, index) =>
      sig(index + 40),
    ).join("\n"),
  };
}

describe("cluster formation roster proposal", () => {
  it("pins the expected ML-DSA-65 consensus pubkey length", () => {
    expect(CLUSTER_FORM_HEX_LENGTHS.consensusPubkey).toBe(
      2 + NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES * 2,
    );
    expect(CLUSTER_FORM_HEX_LENGTHS.consentSignature).toBe(
      2 + FORM_CLUSTER_SIGNATURE_BYTES * 2,
    );
  });

  it("parses newline, comma, and whitespace separated pubkeys", () => {
    expect(parseClusterFormPubkeys(` ${pubkey(1)},\n${pubkey(2)} ${pubkey(3)} `)).toEqual([
      pubkey(1),
      pubkey(2),
      pubkey(3),
    ]);
  });

  it("parses newline, comma, and whitespace separated consent signatures", () => {
    expect(parseClusterFormSignatures(` ${sig(1)},\n${sig(2)} ${sig(3)} `)).toEqual([
      sig(1),
      sig(2),
      sig(3),
    ]);
  });

  it("accepts exactly 7 active and 3 standby unique consensus pubkeys", () => {
    const summary = clusterFormProposalSummary(validInput());

    expect(summary.ready).toBe(true);
    expect(summary.activeCount).toBe(7);
    expect(summary.standbyCount).toBe(3);
    expect(summary.totalCount).toBe(10);
    expect(summary.signatureCount).toBe(10);
    expect(summary.consentMessageHex).toMatch(/^0x[0-9a-f]{64}$/u);
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
      ...validInput(),
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

  it("rejects missing or malformed consent signatures", () => {
    const missing = clusterFormProposalSummary({
      ...validInput(),
      signaturesHex: "",
    });
    expect(missing.ready).toBe(false);
    expect(missing.blockers).toContain("expected 10 roster consent signatures");

    const malformed = clusterFormProposalSummary({
      ...validInput(),
      signaturesHex: [sig(1), `0x${"aa".repeat(FORM_CLUSTER_SIGNATURE_BYTES - 1)}`].join("\n"),
    });
    expect(malformed.ready).toBe(false);
    expect(malformed.invalidSignatureCount).toBe(1);
    expect(malformed.blockers).toContain(
      `all consent signatures must be ${FORM_CLUSTER_SIGNATURE_BYTES} byte ML-DSA-65 signatures`,
    );
  });

  it("states that formation execution uses formCluster on compatible runtimes", () => {
    expect(CLUSTER_FORM_RUNTIME_NOTICE).toContain("formCluster(bytes,bytes,bytes)");
    expect(CLUSTER_FORM_RUNTIME_NOTICE).toContain("ten ML-DSA-65 consent signatures");
  });
});
