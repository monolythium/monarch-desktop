import { describe, expect, it } from "vitest";
import { isDkgReshareAttestationInputComplete } from "./DkgReshareAttestationForm";

function key(byte: number): string {
  return byte.toString(16).padStart(2, "0").repeat(48);
}

const keysHex = "0x" + [1, 2, 3, 4, 5].map(key).join("");
const sigHex = "0x" + "cc".repeat(96);

describe("DKG re-share attestation input validation", () => {
  it("requires a non-zero bounded intent id, 5-7 unique pubkeys, and a 96-byte signature", () => {
    expect(isDkgReshareAttestationInputComplete(undefined)).toBe(false);
    expect(
      isDkgReshareAttestationInputComplete({
        intentId: "0",
        blsPublicKeysHex: keysHex,
        thresholdSigHex: sigHex,
      }),
    ).toBe(false);
    expect(
      isDkgReshareAttestationInputComplete({
        intentId: (1n << 56n).toString(),
        blsPublicKeysHex: keysHex,
        thresholdSigHex: sigHex,
      }),
    ).toBe(false);
    expect(
      isDkgReshareAttestationInputComplete({
        intentId: "7",
        blsPublicKeysHex: "0x" + [1, 2, 3, 4].map(key).join(""),
        thresholdSigHex: sigHex,
      }),
    ).toBe(false);
    expect(
      isDkgReshareAttestationInputComplete({
        intentId: "7",
        blsPublicKeysHex: "0x" + [1, 1, 2, 3, 4].map(key).join(""),
        thresholdSigHex: sigHex,
      }),
    ).toBe(false);
    expect(
      isDkgReshareAttestationInputComplete({
        intentId: "7",
        blsPublicKeysHex: keysHex,
        thresholdSigHex: "0x" + "cc".repeat(95),
      }),
    ).toBe(false);
    expect(
      isDkgReshareAttestationInputComplete({
        intentId: "7",
        blsPublicKeysHex: keysHex,
        thresholdSigHex: sigHex,
      }),
    ).toBe(true);
  });
});
