import { describe, expect, it } from "vitest";
import { OP_BANDS, OP_CATALOG, actionBadge, bandHeading } from "./catalog";
import type { OpCategory } from "./catalog";
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
      "Preflights formCluster through eth_call, then signs with the active operator's recovery phrase on compatible runtimes.",
    );

    expect(request).toMatchObject({
      title: "Request cluster join",
      confirmLabel: "Approve join request",
      category: "cluster",
    });
    expect(prose(request)).toContain("requestClusterJoin(uint32,bytes)");
    expect(request?.effects).toContain(
      "Attaches the bond as native value and publishes your consensus pubkey for voting.",
    );

    expect(vote).toMatchObject({
      title: "Vote to admit operator",
      confirmLabel: "Sign admit vote",
      category: "cluster",
    });
    expect(prose(vote)).toContain("pending admission request");
    expect(vote?.effects).toContain(
      "Fails before signing if the candidate request is missing, closed, or already admitted.",
    );
  });

  it("surfaces the full open-seat marketplace verb set", () => {
    const apply = OP_CATALOG.find((e) => e.kind === "seat-apply");
    const vote = OP_CATALOG.find((e) => e.kind === "seat-vote-admit");
    const advertise = OP_CATALOG.find((e) => e.kind === "seat-advertise");
    const withdraw = OP_CATALOG.find((e) => e.kind === "seat-withdraw-application");
    const close = OP_CATALOG.find((e) => e.kind === "seat-close");

    for (const entry of [apply, vote, advertise, withdraw, close]) {
      expect(entry?.category).toBe("cluster");
    }

    expect(advertise).toMatchObject({
      title: "Advertise an open seat",
      confirmLabel: "Sign seat advertisement",
    });
    expect(prose(advertise)).toContain("advertiseSeat(uint32,uint8,uint32,uint128,uint32,bytes32)");

    expect(withdraw).toMatchObject({
      title: "Withdraw a seat application",
      confirmLabel: "Sign application withdrawal",
    });
    expect(prose(withdraw)).toContain("withdrawSeatApplication(uint32,bytes32)");
    expect(withdraw?.effects).toContain("Refunds the full self-bond you escrowed at apply.");

    expect(close).toMatchObject({
      title: "Close an advertised seat",
      confirmLabel: "Sign seat close",
    });
    expect(prose(close)).toContain("closeSeat(uint32,uint32)");
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
      confirmLabel: "Approve name update",
    });
    expect(prose(display)).toContain("public name and short alias");
    expect(display?.effects).toContain(
      "Updates the public name and alias shown in Monoscan and Monarch Desktop.",
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

  it("surfaces protocore log management ops in the system category", () => {
    const retention = OP_CATALOG.find((entry) => entry.kind === "set-log-retention");
    const cleanup = OP_CATALOG.find((entry) => entry.kind === "clean-protocore-logs");

    expect(retention).toMatchObject({
      title: "Set log retention",
      category: "system",
      destructive: false,
    });
    expect(prose(retention)).toContain("PROTOCORE_LOG_MAX_BYTES");
    expect(retention?.effects).toContain(
      "Applied in NoReboot mode — the node is not cycled.",
    );

    expect(cleanup).toMatchObject({
      title: "Clean up logs",
      category: "system",
      destructive: true,
      confirmLabel: "Apply retention & restart",
    });
    // HONEST: the cleanup op never claims a file truncate Talos cannot do.
    expect(cleanup?.intro.toLowerCase()).toContain("no file-truncate");
  });

  it("keeps intros plain-language — spec prose lives in technical details", () => {
    const specTokens = /\b0x1[0-9a-fA-F]{3}\b|\(bytes|\(uint|bytes32|uint64|ML-DSA|ML-KEM/u;
    for (const entry of OP_CATALOG) {
      expect(specTokens.test(entry.intro), `${entry.kind} intro leaks spec prose`).toBe(false);
    }
  });

  describe("action-number bands", () => {
    const EXPECTED_RANGES: Record<OpCategory, [number, number]> = {
      system: [1, 20],
      cluster: [21, 40],
      keys: [41, 60],
      treasury: [61, 80],
      emergency: [81, 100],
    };

    it("declares the documented band ranges", () => {
      for (const [category, [min, max]] of Object.entries(EXPECTED_RANGES) as [
        OpCategory,
        [number, number],
      ][]) {
        expect(OP_BANDS[category].min, `${category} min`).toBe(min);
        expect(OP_BANDS[category].max, `${category} max`).toBe(max);
      }
    });

    it("gives every op a number inside its category's band", () => {
      for (const entry of OP_CATALOG) {
        const [min, max] = EXPECTED_RANGES[entry.category];
        expect(
          entry.actionNumber >= min && entry.actionNumber <= max,
          `${entry.kind} (#${entry.actionNumber}) must be within ${entry.category} band ${min}–${max}`,
        ).toBe(true);
        expect(Number.isInteger(entry.actionNumber), `${entry.kind} number must be an integer`).toBe(true);
      }
    });

    it("uses every action number at most once", () => {
      const numbers = OP_CATALOG.map((entry) => entry.actionNumber);
      expect(new Set(numbers).size, "action numbers must be unique").toBe(numbers.length);
    });

    it("assigns numbers sequentially within each band, in catalog order", () => {
      const byBand = new Map<OpCategory, number[]>();
      for (const entry of OP_CATALOG) {
        const list = byBand.get(entry.category) ?? [];
        list.push(entry.actionNumber);
        byBand.set(entry.category, list);
      }
      for (const [category, numbers] of byBand) {
        const min = OP_BANDS[category].min;
        const expected = numbers.map((_, i) => min + i);
        expect(numbers, `${category} numbers run sequentially from ${min}`).toEqual(expected);
      }
    });

    it("formats badges and band headings", () => {
      const register = OP_CATALOG.find((entry) => entry.kind === "operator-register");
      expect(register?.actionNumber).toBe(21);
      expect(actionBadge({ actionNumber: 49 })).toBe("#49");
      expect(bandHeading("system")).toBe("Node operations · 1–20");
      expect(bandHeading("emergency")).toBe("Recovery · 81–100");
    });

  });
});
