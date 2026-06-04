import { describe, expect, it } from "vitest";
import { isDkgReshareAttestationInputComplete } from "./DkgReshareAttestationForm";
import {
  DKG_RESHARE_ATTESTATION_SIG_BYTES,
  DKG_RESHARE_CONSENSUS_PUBKEY_BYTES,
} from "../sdk/dkgReshareOps";

function key(byte: number): string {
  return byte.toString(16).padStart(2, "0").repeat(DKG_RESHARE_CONSENSUS_PUBKEY_BYTES);
}

const keysHex = "0x" + [1, 2, 3, 4, 5].map(key).join("");
const sigHex = "0x" + "cc".repeat(5 * DKG_RESHARE_ATTESTATION_SIG_BYTES);

describe("DKG re-share attestation input validation", () => {
  it("requires a non-zero bounded intent id, 5-7 unique pubkeys, and one signature per signer", () => {
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
        thresholdSigHex: "0x" + "cc".repeat(5 * DKG_RESHARE_ATTESTATION_SIG_BYTES - 1),
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
