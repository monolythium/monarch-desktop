import { describe, expect, it } from "vitest";
import { OP_CATALOG } from "./catalog";
import { OP_KINDS } from "./types";

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
    expect(invite?.intro).toContain("submitPendingChange(Add)");
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
      confirmLabel: "Prepare formation",
      category: "cluster",
    });
    expect(form?.intro).toContain("7 active operators");
    expect(form?.effects).toContain(
      "Fails closed until node-registry exposes a signed cluster-formation primitive and Desktop has a submit helper.",
    );

    expect(request).toMatchObject({
      title: "Request cluster join",
      confirmLabel: "Sign join request",
      category: "cluster",
    });
    expect(request?.intro).toContain("requestClusterJoin(uint32,bytes)");
    expect(request?.effects).toContain(
      "Fails before signing on current chains that do not expose the CJ-1 cluster-vote precompile.",
    );

    expect(vote).toMatchObject({
      title: "Vote to admit operator",
      confirmLabel: "Sign admit vote",
      category: "cluster",
    });
    expect(vote?.intro).toContain("voteClusterAdmit(uint32,bytes32,bytes)");
    expect(vote?.effects).toContain(
      "Fails before signing on current chains that do not expose the CJ-1 cluster-vote precompile.",
    );
  });

  it("routes operator restore through the foundation operations signer", () => {
    const restore = OP_CATALOG.find((entry) => entry.kind === "operator-restore");

    expect(restore).toMatchObject({
      title: "Restore operator",
      confirmLabel: "Sign recovery tx",
    });
    expect(restore?.intro).toContain("recoverOperatorNode(bytes32)");
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
    expect(chatPeers?.intro).toContain("setChatBootstrapPeers(bytes32,bytes)");
    expect(chatPeers?.effects).toContain(
      "Builds setChatBootstrapPeers(peerId, peers) calldata against node-registry 0x1005.",
    );
  });

  it("routes cluster swap through a foundation Rotate pending-change", () => {
    const swap = OP_CATALOG.find((entry) => entry.kind === "cluster-swap");

    expect(swap).toMatchObject({
      title: "Cluster slot (foundation-coordinated)",
      confirmLabel: "Sign Rotate pending-change",
    });
    expect(swap?.intro).toContain("submitPendingChange(Rotate)");
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
    expect(rotate?.intro).toContain("attestDkgReshare(uint64,bytes,bytes)");
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
    expect(freeze?.intro).toContain("freezeAdmission(bytes32)");
    expect(emergency).toMatchObject({
      title: "Emergency key rotation",
      confirmLabel: "Sign emergencyKeyRotation",
      category: "emergency",
    });
    expect(emergency?.intro).toContain("emergencyKeyRotation(bytes,uint64,uint64)");
  });
});
