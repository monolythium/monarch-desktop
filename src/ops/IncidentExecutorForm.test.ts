import { describe, expect, it } from "vitest";
import {
  isEmergencyKeyRotationInputComplete,
  isFreezeAdmissionInputComplete,
} from "./IncidentExecutorForm";

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
        targetPubkeyHex: "0x" + "cd".repeat(48),
        effectiveEpoch: "42",
        intentId: "7",
      }),
    ).toBe(true);
    expect(
      isEmergencyKeyRotationInputComplete({
        targetPubkeyHex: "0x" + "cd".repeat(48),
        effectiveEpoch: "0",
        intentId: "7",
      }),
    ).toBe(false);
    expect(
      isEmergencyKeyRotationInputComplete({
        targetPubkeyHex: "0x" + "cd".repeat(47),
        effectiveEpoch: "42",
        intentId: "7",
      }),
    ).toBe(false);
  });
});
