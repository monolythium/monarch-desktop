import { describe, expect, it, vi } from "vitest";

vi.mock("../sdk", async () => {
  const actual = await vi.importActual<typeof import("../sdk")>("../sdk");
  return {
    ...actual,
    keychainGet: vi.fn(),
    talosOperatorSealEk: vi.fn(),
  };
});

import { OPERATOR_SEAL_EK_BYTES } from "../sdk";
import { isOperatorSealKeyInputComplete } from "./OperatorSealKeyForm";

describe("operator seal key form validation", () => {
  it("requires a 32-byte peer id and non-zero ML-KEM EK", () => {
    expect(isOperatorSealKeyInputComplete(undefined)).toBe(false);
    expect(
      isOperatorSealKeyInputComplete({
        peerIdHex: "0x" + "11".repeat(31),
        sealEkHex: "0x" + "22".repeat(OPERATOR_SEAL_EK_BYTES),
      }),
    ).toBe(false);
    expect(
      isOperatorSealKeyInputComplete({
        peerIdHex: "0x" + "11".repeat(32),
        sealEkHex: "0x" + "22".repeat(OPERATOR_SEAL_EK_BYTES - 1),
      }),
    ).toBe(false);
    expect(
      isOperatorSealKeyInputComplete({
        peerIdHex: "0x" + "11".repeat(32),
        sealEkHex: "0x" + "00".repeat(OPERATOR_SEAL_EK_BYTES),
      }),
    ).toBe(false);
    expect(
      isOperatorSealKeyInputComplete({
        peerIdHex: "0x" + "11".repeat(32),
        sealEkHex: "0x" + "22".repeat(OPERATOR_SEAL_EK_BYTES),
      }),
    ).toBe(true);
  });
});
