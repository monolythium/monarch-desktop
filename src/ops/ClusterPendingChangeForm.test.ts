import { describe, expect, it } from "vitest";
import {
  isPendingChangeInputComplete,
  pendingChangeKindForOp,
} from "./ClusterPendingChangeForm";
import { NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES } from "../sdk/operatorKeys";

const pubkeyHex = "0x" + "ab".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES);

describe("cluster pending-change input validation", () => {
  it("maps cluster verbs to node-registry pending-change kinds", () => {
    expect(pendingChangeKindForOp("cluster-accept-invite")).toBe("add");
    expect(pendingChangeKindForOp("cluster-swap")).toBe("rotate");
    expect(pendingChangeKindForOp("operator-register")).toBeNull();
  });

  it("requires Add invite inputs with zero intent id", () => {
    expect(isPendingChangeInputComplete("cluster-accept-invite", undefined)).toBe(false);
    expect(
      isPendingChangeInputComplete("cluster-accept-invite", {
        kind: "add",
        targetPubkeyHex: "0x" + "ab".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES - 1),
        effectiveEpoch: "12",
        intentId: "0",
      }),
    ).toBe(false);
    expect(
      isPendingChangeInputComplete("cluster-accept-invite", {
        kind: "add",
        targetPubkeyHex: pubkeyHex,
        effectiveEpoch: "0",
        intentId: "0",
      }),
    ).toBe(false);
    expect(
      isPendingChangeInputComplete("cluster-accept-invite", {
        kind: "add",
        targetPubkeyHex: pubkeyHex,
        effectiveEpoch: "12",
        intentId: "1",
      }),
    ).toBe(false);
    expect(
      isPendingChangeInputComplete("cluster-accept-invite", {
        kind: "add",
        targetPubkeyHex: pubkeyHex,
        effectiveEpoch: "12",
        intentId: "0",
      }),
    ).toBe(true);
  });

  it("requires Rotate swap inputs with a bounded non-zero intent id", () => {
    expect(
      isPendingChangeInputComplete("cluster-swap", {
        kind: "rotate",
        targetPubkeyHex: pubkeyHex,
        effectiveEpoch: "12",
        intentId: "0",
      }),
    ).toBe(false);
    expect(
      isPendingChangeInputComplete("cluster-swap", {
        kind: "rotate",
        targetPubkeyHex: pubkeyHex,
        effectiveEpoch: "12",
        intentId: ((1n << 56n)).toString(),
      }),
    ).toBe(false);
    expect(
      isPendingChangeInputComplete("cluster-swap", {
        kind: "rotate",
        targetPubkeyHex: pubkeyHex,
        effectiveEpoch: "12",
        intentId: "99",
      }),
    ).toBe(true);
  });
});
