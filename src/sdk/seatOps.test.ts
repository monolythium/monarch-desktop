import { describe, expect, it } from "vitest";
import {
  encodeAdvertiseSeatCalldataHex,
  encodeApplyForSeatCalldataHex,
  encodeCloseSeatCalldataHex,
  encodeVoteSeatAdmitCalldataHex,
  encodeWithdrawSeatApplicationCalldataHex,
} from "./seatOps";

const CONSENSUS_PUBKEY_HEX = `0x${"11".repeat(1952)}`;
const APP_KEY_HEX = `0x${"ab".repeat(32)}`;
const TERMS_HASH_HEX = `0x${"cd".repeat(32)}`;
const FIVE_K = (5_000n * 10n ** 18n).toString();

function selector(calldata: string): string {
  return calldata.slice(0, 10);
}

describe("open-seat calldata encoders", () => {
  it("encodes advertiseSeat calldata (deterministic, selector-prefixed)", () => {
    const args = {
      clusterId: 7,
      kind: "active" as const,
      seatCount: 1,
      minBondLythoshi: FIVE_K,
      capabilityMask: 1,
      termsHashHex: TERMS_HASH_HEX,
    };
    const calldata = encodeAdvertiseSeatCalldataHex({ ...args, kind: 0 });
    expect(calldata).toMatch(/^0x[0-9a-f]+$/u);
    expect(encodeAdvertiseSeatCalldataHex({ ...args, kind: 0 })).toBe(calldata);
    // The advertise head carries six words plus the selector.
    expect(calldata.length).toBe(2 + 8 + 6 * 64);
  });

  it("encodes withdrawSeatApplication calldata", () => {
    const calldata = encodeWithdrawSeatApplicationCalldataHex({
      clusterId: 7,
      appKeyHex: APP_KEY_HEX,
    });
    expect(calldata).toMatch(/^0x[0-9a-f]+$/u);
    // clusterId + appKey (bytes32) = two words after the selector.
    expect(calldata.length).toBe(2 + 8 + 2 * 64);
  });

  it("encodes closeSeat calldata", () => {
    const calldata = encodeCloseSeatCalldataHex({ clusterId: 7, seatId: 3 });
    expect(calldata).toMatch(/^0x[0-9a-f]+$/u);
    // clusterId + seatId = two words after the selector.
    expect(calldata.length).toBe(2 + 8 + 2 * 64);
  });

  it("gives each open-seat selector a distinct 4-byte prefix", () => {
    const selectors = new Set([
      selector(encodeApplyForSeatCalldataHex({ clusterId: 7, seatId: 0, operatorPubkeyHex: CONSENSUS_PUBKEY_HEX })),
      selector(encodeVoteSeatAdmitCalldataHex({ clusterId: 7, appKeyHex: APP_KEY_HEX, voterPubkeyHex: CONSENSUS_PUBKEY_HEX })),
      selector(encodeAdvertiseSeatCalldataHex({ clusterId: 7, kind: 0, seatCount: 1, minBondLythoshi: FIVE_K, capabilityMask: 1, termsHashHex: TERMS_HASH_HEX })),
      selector(encodeWithdrawSeatApplicationCalldataHex({ clusterId: 7, appKeyHex: APP_KEY_HEX })),
      selector(encodeCloseSeatCalldataHex({ clusterId: 7, seatId: 0 })),
    ]);
    // Five distinct selectors for the five marketplace verbs.
    expect(selectors.size).toBe(5);
  });
});
