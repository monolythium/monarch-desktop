import { describe, expect, it } from "vitest";
import { OP_CATALOG } from "./catalog";
import { OP_KINDS } from "./types";

/** Intro + demoted technical-details prose, so executor-signature
 *  assertions keep holding after the plain-language intro rewrite. */
function prose(entry: (typeof OP_CATALOG)[number] | undefined): string {
  return `${entry?.intro ?? ""} ${entry?.technical ?? ""}`;
}

describe("operation catalog", () => {
  it("surfaces every known operation kind", () => {
    const catalogKinds = OP_CATALOG.map((entry) => entry.kind).sort();
    const knownKinds = [...OP_KINDS].sort();

    expect(catalogKinds).toEqual(knownKinds);
  });

  it("routes cluster invite through the foundation pending-change signer", () => {
    const invite = OP_CATALOG.find((entry) => entry.kind === "cluster-accept-invite");

    expect(invite).toMatchObject({
      title: "Accept cluster invite",
      confirmLabel: "Sign Add pending-change",
    });
    expect(prose(invite)).toContain("submitPendingChange(Add)");
    expect(invite?.effects).toContain(
      "Builds submitPendingChange(kind=Add, targetPubkey, effectiveEpoch, intentId=0).",
    );
  });

  it("surfaces CJ-1 self-service cluster admission verbs", () => {
    const form = OP_CATALOG.find((entry) => entry.kind === "cluster-form");
    const request = OP_CATALOG.find((entry) => entry.kind === "cluster-request-join");
    const vote = OP_CATALOG.find((entry) => entry.kind === "cluster-vote-admit");

    expect(form).toMatchObject({
      title: "Form cluster",
      confirmLabel: "Sign formation",
      category: "cluster",
    });
    expect(prose(form)).toContain("formCluster(bytes,bytes,bytes)");
    expect(form?.effects).toContain(
      "Preflights formCluster through eth_call, then signs with the active operator's PQM-1 mnemonic on compatible runtimes.",
    );

    expect(request).toMatchObject({
      title: "Request cluster join",
      confirmLabel: "Sign join request",
      category: "cluster",
    });
    expect(prose(request)).toContain("requestClusterJoin(uint32,bytes)");
    expect(request?.effects).toContain(
      "Fails before signing if the operator's public LythiumSeal EK has not been published.",
    );

    expect(vote).toMatchObject({
      title: "Vote to admit operator",
      confirmLabel: "Sign admit vote",
      category: "cluster",
    });
    expect(prose(vote)).toContain("voteClusterAdmit(uint32,bytes32,bytes)");
    expect(vote?.effects).toContain(
      "Fails before signing if the candidate request is missing, closed, or already admitted.",
    );
  });

  it("routes operator restore through the foundation operations signer", () => {
    const restore = OP_CATALOG.find((entry) => entry.kind === "operator-restore");

    expect(restore).toMatchObject({
      title: "Restore operator",
      confirmLabel: "Sign recovery tx",
    });
    expect(prose(restore)).toContain("recoverOperatorNode(bytes32)");
    expect(restore?.effects).toContain(
      "Builds recoverOperatorNode(peerId) calldata against node-registry 0x1005.",
    );
  });

  it("routes chat peer publication through an operator metadata tx", () => {
    const chatPeers = OP_CATALOG.find((entry) => entry.kind === "chat-bootstrap-peers");

    expect(chatPeers).toMatchObject({
      title: "Publish chat peers",
      confirmLabel: "Sign chat metadata tx",
    });
    expect(prose(chatPeers)).toContain("setChatBootstrapPeers(bytes32,bytes)");
    expect(chatPeers?.effects).toContain(
      "Builds setChatBootstrapPeers(peerId, peers) calldata against node-registry 0x1005.",
    );
  });

  it("routes operator display metadata through an operator metadata tx", () => {
    const display = OP_CATALOG.find((entry) => entry.kind === "operator-display");

    expect(display).toMatchObject({
      title: "Set operator name",
      confirmLabel: "Sign display metadata tx",
    });
    expect(prose(display)).toContain("setOperatorDisplay(bytes32,string,string)");
    expect(display?.effects).toContain(
      "Builds setOperatorDisplay(peerId, moniker, alias) calldata against node-registry 0x1005.",
    );
  });

  it("routes operator seal key publication through an operator registry tx", () => {
    const sealKey = OP_CATALOG.find((entry) => entry.kind === "operator-seal-key");

    expect(sealKey).toMatchObject({
      title: "Publish seal key",
      confirmLabel: "Sign seal key tx",
    });
    expect(prose(sealKey)).toContain("publishOperatorSealKey(bytes32,bytes)");
    expect(sealKey?.effects).toContain(
      "Builds publishOperatorSealKey(peerId, sealEk) calldata against node-registry 0x1005.",
    );
  });

  it("routes cluster naming through the cluster-name registry", () => {
    const clusterName = OP_CATALOG.find((entry) => entry.kind === "cluster-name-register");

    expect(clusterName).toMatchObject({
      title: "Set cluster name",
      confirmLabel: "Sign cluster name tx",
      category: "cluster",
    });
    expect(prose(clusterName)).toContain("register(string,uint64)");
    expect(clusterName?.effects).toContain(
      "Builds register(name, clusterId) calldata against cluster-name registry 0x1104.",
    );
  });

  it("routes cluster swap through a foundation Rotate pending-change", () => {
    const swap = OP_CATALOG.find((entry) => entry.kind === "cluster-swap");

    expect(swap).toMatchObject({
      title: "Cluster slot change",
      confirmLabel: "Sign Rotate pending-change",
    });
    expect(prose(swap)).toContain("submitPendingChange(Rotate)");
    expect(swap?.effects).toContain(
      "Builds submitPendingChange(kind=Rotate, targetPubkey, effectiveEpoch, intentId).",
    );
  });

  it("routes key rotation through an operator DKG attestation tx", () => {
    const rotate = OP_CATALOG.find((entry) => entry.kind === "rotate-keys");

    expect(rotate).toMatchObject({
      title: "Rotate signing share",
      confirmLabel: "Sign DKG attestation",
    });
    expect(prose(rotate)).toContain("attestDkgReshare(uint64,bytes,bytes)");
    expect(rotate?.effects).toContain(
      "Builds attestDkgReshare(intentId, consensusPublicKeys, attestationSigs) calldata against node-registry 0x1005.",
    );
  });

  it("routes incident executors through foundation-signed transactions", () => {
    const freeze = OP_CATALOG.find((entry) => entry.kind === "freeze-admission");
    const emergency = OP_CATALOG.find((entry) => entry.kind === "emergency-key-rotation");

    expect(freeze).toMatchObject({
      title: "Freeze admission",
      confirmLabel: "Sign freezeAdmission",
      category: "emergency",
    });
    expect(prose(freeze)).toContain("freezeAdmission(bytes32)");
    expect(emergency).toMatchObject({
      title: "Emergency key rotation",
      confirmLabel: "Sign emergencyKeyRotation",
      category: "emergency",
    });
    expect(prose(emergency)).toContain("emergencyKeyRotation(bytes,uint64,uint64)");
  });

  it("keeps intros plain-language — spec prose lives in technical details", () => {
    const specTokens = /\b0x1[0-9a-fA-F]{3}\b|\(bytes|\(uint|bytes32|uint64|ML-DSA|ML-KEM|PQM-1/u;
    for (const entry of OP_CATALOG) {
      expect(specTokens.test(entry.intro), `${entry.kind} intro leaks spec prose`).toBe(false);
    }
  });
});
