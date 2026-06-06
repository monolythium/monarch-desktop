import { describe, expect, it } from "vitest";
import {
  CLUSTER_JOIN_FORM_HEX_LENGTHS,
  CLUSTER_JOIN_SEAL_KEY_REQUIREMENT,
  clusterJoinTtlLabel,
  clusterJoinRequestStatusPreview,
  clusterVoteAdmitStatusPreview,
  isClusterJoinRequestInputComplete,
  isClusterVoteAdmitInputComplete,
} from "./ClusterJoinForms";
import type { ClusterJoinRequestView } from "../sdk";
import { GET_CLUSTER_JOIN_REQUEST_SELECTOR } from "../sdk/clusterJoinOps";
import { NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES } from "../sdk/operatorKeys";

const consensusPubkeyHex = "0x" + "ab".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES);
const operatorIdHex = "0x" + "11".repeat(32);

function requestView(overrides: Partial<ClusterJoinRequestView> = {}): ClusterJoinRequestView {
  return {
    owner: "0x" + "22".repeat(20),
    requestEpoch: "10",
    snapshotThreshold: 7,
    snapshotN: 10,
    voteCount: 3,
    status: "open",
    statusCode: 1,
    bondLythoshi: "5000",
    sealRosterPending: true,
    exists: true,
    ...overrides,
  };
}

describe("CJ-1 cluster join input validation", () => {
  it("pins byte-sized hex inputs to the node-registry ABI", () => {
    expect(CLUSTER_JOIN_FORM_HEX_LENGTHS.consensusPubkey).toBe(
      2 + NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES * 2,
    );
    expect(CLUSTER_JOIN_FORM_HEX_LENGTHS.operatorId).toBe(66);
  });

  it("discloses the seal-key publication requirement before join requests", () => {
    expect(CLUSTER_JOIN_SEAL_KEY_REQUIREMENT).toContain("Publish the operator LythiumSeal EK");
    expect(CLUSTER_JOIN_SEAL_KEY_REQUIREMENT).toContain("live seal rosters");
  });

  it("prepares the request-status address from the joining operator pubkey", () => {
    const preview = clusterJoinRequestStatusPreview({
      clusterId: "7",
      operatorPubkeyHex: consensusPubkeyHex,
      bondLythoshi: "1",
    });

    expect(preview.status).toBe("ready");
    expect(preview.operatorIdHex).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(preview.getRequestCalldata.startsWith(GET_CLUSTER_JOIN_REQUEST_SELECTOR)).toBe(true);
    expect(preview.getRequestCalldata).toContain(preview.operatorIdHex.slice(2));
    expect(preview.voteProgressLabel).toContain("vote_count / snapshot_threshold");
  });

  it("shows a live TTL countdown when the current cluster epoch is available", () => {
    expect(clusterJoinTtlLabel(requestView(), 13)).toBe(
      "opened epoch 10 · current epoch 13 · expires epoch 16 · 3 epochs remaining",
    );
    expect(clusterJoinTtlLabel(requestView(), 15)).toBe(
      "opened epoch 10 · current epoch 15 · expires epoch 16 · 1 epoch remaining",
    );
    expect(clusterJoinTtlLabel(requestView(), 16)).toBe(
      "TTL window elapsed at epoch 16 · current epoch 16",
    );
  });

  it("keeps TTL explicit when current epoch or open status is unavailable", () => {
    expect(clusterJoinTtlLabel(requestView(), null)).toBe(
      "opened epoch 10 · expires epoch 16",
    );
    expect(clusterJoinTtlLabel(requestView({ status: "admitted", statusCode: 2 }), 13)).toBe(
      "request is admitted",
    );
  });

  it("keeps request-status incomplete until the request can be addressed", () => {
    const preview = clusterJoinRequestStatusPreview({
      clusterId: "not-a-cluster",
      operatorPubkeyHex: consensusPubkeyHex,
      bondLythoshi: "1",
    });

    expect(preview.status).toBe("incomplete");
    expect(preview.getRequestCalldata).toBe("");
  });

  it("prepares vote-status lookup from the candidate operator id", () => {
    const preview = clusterVoteAdmitStatusPreview({
      clusterId: "7",
      operatorIdHex,
      voterPubkeyHex: consensusPubkeyHex,
    });

    expect(preview.status).toBe("ready");
    expect(preview.operatorIdHex).toBe(operatorIdHex);
    expect(preview.getRequestCalldata.startsWith(GET_CLUSTER_JOIN_REQUEST_SELECTOR)).toBe(true);
    expect(preview.getRequestCalldata).toContain(operatorIdHex.slice(2));
  });

  it("requires requestClusterJoin cluster id, ML-DSA pubkey, and positive bond", () => {
    expect(isClusterJoinRequestInputComplete(undefined)).toBe(false);
    expect(
      isClusterJoinRequestInputComplete({
        clusterId: "7",
        operatorPubkeyHex: "0x" + "ab".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES - 1),
        bondLythoshi: "1",
      }),
    ).toBe(false);
    expect(
      isClusterJoinRequestInputComplete({
        clusterId: ((1n << 32n)).toString(),
        operatorPubkeyHex: consensusPubkeyHex,
        bondLythoshi: "1",
      }),
    ).toBe(false);
    expect(
      isClusterJoinRequestInputComplete({
        clusterId: "7",
        operatorPubkeyHex: consensusPubkeyHex,
        bondLythoshi: "0",
      }),
    ).toBe(false);
    expect(
      isClusterJoinRequestInputComplete({
        clusterId: "7",
        operatorPubkeyHex: consensusPubkeyHex,
        bondLythoshi: "1",
      }),
    ).toBe(true);
  });

  it("requires voteClusterAdmit cluster id, candidate id, and voter pubkey", () => {
    expect(isClusterVoteAdmitInputComplete(undefined)).toBe(false);
    expect(
      isClusterVoteAdmitInputComplete({
        clusterId: "7",
        operatorIdHex: "0x" + "11".repeat(31),
        voterPubkeyHex: consensusPubkeyHex,
      }),
    ).toBe(false);
    expect(
      isClusterVoteAdmitInputComplete({
        clusterId: "7",
        operatorIdHex,
        voterPubkeyHex: "0x" + "ab".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES + 1),
      }),
    ).toBe(false);
    expect(
      isClusterVoteAdmitInputComplete({
        clusterId: "7",
        operatorIdHex,
        voterPubkeyHex: consensusPubkeyHex,
      }),
    ).toBe(true);
  });
});
