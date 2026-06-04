import { describe, expect, it } from "vitest";
import {
  isEmergencyKeyRotationInputComplete,
  isFreezeAdmissionInputComplete,
} from "./IncidentExecutorForm";
import { NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES } from "../sdk/operatorKeys";

describe("incident executor forms", () => {
  it("validates freezeAdmission input", () => {
    expect(
      isFreezeAdmissionInputComplete({ reasonHashHex: "0x" + "ab".repeat(32) }),
    ).toBe(true);
    expect(
      isFreezeAdmissionInputComplete({ reasonHashHex: "0x" + "ab".repeat(31) }),
    ).toBe(false);
  });

  it("validates emergencyKeyRotation input", () => {
    expect(
      isEmergencyKeyRotationInputComplete({
        targetPubkeyHex: "0x" + "cd".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES),
        effectiveEpoch: "42",
        intentId: "7",
      }),
    ).toBe(true);
    expect(
      isEmergencyKeyRotationInputComplete({
        targetPubkeyHex: "0x" + "cd".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES),
        effectiveEpoch: "0",
        intentId: "7",
      }),
    ).toBe(false);
    expect(
      isEmergencyKeyRotationInputComplete({
        targetPubkeyHex: "0x" + "cd".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES - 1),
        effectiveEpoch: "42",
        intentId: "7",
      }),
    ).toBe(false);
  });
});
