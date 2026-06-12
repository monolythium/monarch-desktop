import { describe, expect, it } from "vitest";
import {
  decodePendingCharter,
  encodeClusterCharter,
  encodeGetPendingCharterCalldata,
  encodeUpdateCharterCalldata,
  updateCharterMessageHex,
} from "@monolythium/core-sdk";
import {
  CHARTER_COOLDOWN_EPOCHS,
  UPDATE_CHARTER_THRESHOLD,
  clusterCharterSlotHex,
  decodeCharterDraftHex,
  encodeCharterDraftHex,
  encodeUpdateCharterCalldataHex,
  readActiveCharter,
  readPendingCharter,
  reduceCharterAmendment,
  updateCharterConsentDigestHex,
  type CollectedCharterConsent,
} from "./charterAmendmentOps";

function hexToBytes(h: string): Uint8Array {
  const clean = h.replace(/^0x/u, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const PUBKEY_BYTES = 1952;
const SIG_BYTES = 3309;
const pubkey = (fill: number) => `0x${fill.toString(16).padStart(2, "0").repeat(PUBKEY_BYTES)}`;
const signature = (fill: number) => `0x${fill.toString(16).padStart(2, "0").repeat(SIG_BYTES)}`;

const EQUAL_CHARTER_HEX = bytesToHex(
  encodeClusterCharter({ memberShareBps: Array(10).fill(1000), delegatorShareBps: 5000, expiresMs: 0 }),
);

describe("constants mirror the SDK", () => {
  it("threshold is 7-of-10 and cooldown is 2 epochs", () => {
    expect(UPDATE_CHARTER_THRESHOLD).toBe(7);
    expect(CHARTER_COOLDOWN_EPOCHS).toBe(2);
  });
});

describe("clusterCharterSlotHex — matches mono-core slot_cluster_charter", () => {
  // Pinned against the mono-core `slot_cluster_charter(ClusterId(0), …)`
  // output (keccak256(0x31 ‖ clusterId_be32 ‖ subkind)).
  it("derives the presence (0x00) and member-shares (0x01) slots for cluster 0", () => {
    expect(clusterCharterSlotHex(0, 0x00)).toBe(
      "0x410370419e072185e04e52891edd441c0981d67f338eb41f371fe23060eea9ab",
    );
    expect(clusterCharterSlotHex(0, 0x01)).toBe(
      "0x4f2dcc59541f667a11b31beeecaf1f342439b7ed6f1d12d64d2f9ff0b920b9d5",
    );
  });

  it("binds the cluster id (distinct clusters get distinct slots)", () => {
    expect(clusterCharterSlotHex(1, 0x00)).not.toBe(clusterCharterSlotHex(0, 0x00));
    expect(clusterCharterSlotHex(7, 0x00)).not.toBe(clusterCharterSlotHex(7, 0x01));
  });
});

describe("encodeCharterDraftHex / decodeCharterDraftHex", () => {
  it("encodes a 30-byte charter with expiry pinned to 0 (amendments have no consent expiry)", () => {
    const hex = encodeCharterDraftHex({
      memberShareRows: Array(10).fill("1000"),
      delegatorShareBps: 5000,
    });
    expect(hex).toBe(EQUAL_CHARTER_HEX);
    expect(hexToBytes(hex)).toHaveLength(30);
    // last 8 bytes (expiry) are zero
    expect(hex.slice(-16)).toBe("0".repeat(16));
  });

  it("applies the share/floor guardrails before encoding", () => {
    expect(() =>
      encodeCharterDraftHex({ memberShareRows: Array(10).fill("999"), delegatorShareBps: 5000 }),
    ).toThrow(/sum to exactly 10000/u);
    expect(() =>
      encodeCharterDraftHex({ memberShareRows: Array(10).fill("1000"), delegatorShareBps: 1999 }),
    ).toThrow(/floor/u);
  });

  it("round-trips member + delegator shares", () => {
    const rows = ["3000", "1000", "1000", "1000", "1000", "1000", "1000", "400", "300", "300"];
    const hex = encodeCharterDraftHex({ memberShareRows: rows, delegatorShareBps: 2500 });
    const decoded = decodeCharterDraftHex(hex);
    expect(decoded.memberShareBps).toEqual(rows.map((r) => Number.parseInt(r, 10)));
    expect(decoded.delegatorShareBps).toBe(2500);
  });
});

describe("updateCharterConsentDigestHex — byte-identical to the SDK", () => {
  it("matches updateCharterMessageHex and binds the cluster id", () => {
    expect(updateCharterConsentDigestHex(7, EQUAL_CHARTER_HEX)).toBe(
      updateCharterMessageHex(7, hexToBytes(EQUAL_CHARTER_HEX)),
    );
    // pinned value from the SDK (independent of this wrapper)
    expect(updateCharterConsentDigestHex(7, EQUAL_CHARTER_HEX)).toBe(
      "0x7bc512062c8323b7a785cd073dfe85ae906a468c72f5484491161be30232b2b4",
    );
    expect(updateCharterConsentDigestHex(9, EQUAL_CHARTER_HEX)).not.toBe(
      updateCharterConsentDigestHex(7, EQUAL_CHARTER_HEX),
    );
  });
});

describe("encodeUpdateCharterCalldataHex — byte-identical to the SDK", () => {
  it("matches encodeUpdateCharterCalldata for a 7-signer amendment", () => {
    const signerPubkeysHex = [0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17].map(pubkey);
    const signaturesHex = [0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27].map(signature);
    const got = encodeUpdateCharterCalldataHex({
      clusterId: 7,
      charterHex: EQUAL_CHARTER_HEX,
      signerPubkeysHex,
      signaturesHex,
    });
    const want = encodeUpdateCharterCalldata({
      clusterId: 7,
      charter: hexToBytes(EQUAL_CHARTER_HEX),
      signerPubkeys: signerPubkeysHex.map(hexToBytes),
      signatures: signaturesHex.map(hexToBytes),
    });
    expect(got).toBe(want);
    expect(got.slice(0, 10)).toBe("0x9f1b8bbf"); // updateCharter selector
  });

  it("rejects mismatched signer/signature counts before the SDK encoder", () => {
    expect(() =>
      encodeUpdateCharterCalldataHex({
        clusterId: 7,
        charterHex: EQUAL_CHARTER_HEX,
        signerPubkeysHex: [pubkey(0x11)],
        signaturesHex: [signature(0x21), signature(0x22)],
      }),
    ).toThrow(/counts must match/u);
  });
});

describe("readActiveCharter — decodes node-registry storage", () => {
  // Build the two storage words the on-chain encoder writes:
  //   presence = delegator_bps + 1 (right-aligned)
  //   shares   = 10×u16 BE at bytes [12..32]
  function presenceWord(delegatorBps: number): string {
    return `0x${(delegatorBps + 1).toString(16).padStart(64, "0")}`;
  }
  function sharesWord(shares: number[]): string {
    const buf = new Uint8Array(32);
    for (let i = 0; i < 10; i += 1) {
      const bps = shares[i] ?? 0;
      buf[12 + 2 * i] = (bps >> 8) & 0xff;
      buf[13 + 2 * i] = bps & 0xff;
    }
    return bytesToHex(buf);
  }

  it("returns null when the presence slot is zero (legacy default split)", async () => {
    const client = {
      ethGetStorageAt: async () => ({ value: "0x" + "0".repeat(64) }),
    };
    expect(await readActiveCharter(client, 0)).toBeNull();
  });

  it("decodes the delegator share and the ten member shares", async () => {
    const shares = [3000, 1000, 1000, 1000, 1000, 1000, 1000, 400, 300, 300];
    const client = {
      ethGetStorageAt: async (_addr: string, slot: string) => {
        if (slot === clusterCharterSlotHex(7, 0x00)) return { value: presenceWord(2500) };
        if (slot === clusterCharterSlotHex(7, 0x01)) return { value: sharesWord(shares) };
        throw new Error(`unexpected slot ${slot}`);
      },
    };
    const charter = await readActiveCharter(client, 7);
    expect(charter).not.toBeNull();
    expect(charter!.delegatorShareBps).toBe(2500);
    expect(charter!.memberShareBps).toEqual(shares);
  });
});

describe("readPendingCharter — uses the getPendingCharter view", () => {
  it("encodes the call and decodes the SDK return", async () => {
    // Round-trip a present pending charter through the SDK's own encoder
    // path: build the return tuple the chain produces, then assert our
    // reader decodes it via decodePendingCharter.
    const calls: { to: string; data: string }[] = [];
    // A real getPendingCharter return for a present amendment, produced by
    // the SDK decode path expectations (5-word head + bytes tail).
    const head = (present: boolean, delegator: number, epoch: bigint, signers: number) => {
      const w = (n: bigint) => n.toString(16).padStart(64, "0");
      return (
        w(present ? 1n : 0n) +
        w(BigInt(delegator)) +
        w(epoch) +
        w(BigInt(signers)) +
        w(5n * 32n) // bytes offset
      );
    };
    const packedShares = (() => {
      const buf = new Uint8Array(32);
      for (let i = 0; i < 10; i += 1) {
        buf[12 + 2 * i] = (1000 >> 8) & 0xff;
        buf[13 + 2 * i] = 1000 & 0xff;
      }
      let s = "";
      for (const x of buf) s += x.toString(16).padStart(2, "0");
      return s;
    })();
    const lenWord = (32).toString(16).padStart(64, "0");
    const returnData = `0x${head(true, 5000, 12n, 7)}${lenWord}${packedShares}`;
    const client = {
      ethCall: async (req: { to: string; data: string }) => {
        calls.push(req);
        return returnData;
      },
    };
    const view = await readPendingCharter(client, 9);
    expect(calls[0]?.data).toBe(encodeGetPendingCharterCalldata(9));
    // sanity: our reader's view equals the SDK decoder's view
    expect(view).toEqual(decodePendingCharter(returnData));
    expect(view.present).toBe(true);
    expect(view.delegatorShareBps).toBe(5000);
    expect(view.effectiveEpoch).toBe(12n);
    expect(view.signerCount).toBe(7);
    expect(view.memberShareBps).toHaveLength(10);
  });

  it("reports present=false when no amendment is pending", async () => {
    const w = (n: bigint) => n.toString(16).padStart(64, "0");
    const returnData = `0x${w(0n)}${w(0n)}${w(0n)}${w(0n)}${w(0n)}`;
    const client = { ethCall: async () => returnData };
    const view = await readPendingCharter(client, 1);
    expect(view.present).toBe(false);
  });
});

describe("reduceCharterAmendment — collection + threshold", () => {
  const consent = (pubFill: number, sigFill: number): CollectedCharterConsent => ({
    signerPubkeyHex: pubkey(pubFill),
    signatureHex: signature(sigFill),
  });

  it("is not ready below the 7-signer threshold", () => {
    const out = reduceCharterAmendment([consent(0x11, 0x21), consent(0x12, 0x22)]);
    expect(out.signatureCount).toBe(2);
    expect(out.threshold).toBe(7);
    expect(out.ready).toBe(false);
    expect(out.reason).toMatch(/2 of 7/u);
  });

  it("is ready at exactly 7 distinct, well-formed consents", () => {
    const out = reduceCharterAmendment(
      [0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17].map((f, i) => consent(f, 0x20 + i)),
    );
    expect(out.signatureCount).toBe(7);
    expect(out.ready).toBe(true);
    expect(out.reason).toBeNull();
    expect(out.signerPubkeysHex).toHaveLength(7);
    expect(out.signaturesHex).toHaveLength(7);
  });

  it("de-duplicates by signer pubkey (a member signing twice counts once)", () => {
    const out = reduceCharterAmendment([
      consent(0x11, 0x21),
      consent(0x11, 0x99), // same signer, different sig
      consent(0x12, 0x22),
    ]);
    expect(out.signatureCount).toBe(2);
    // first signature for the signer wins
    expect(out.signaturesHex[0]).toBe(signature(0x21));
  });

  it("drops malformed pubkeys / signatures", () => {
    const out = reduceCharterAmendment([
      { signerPubkeyHex: "0xdeadbeef", signatureHex: signature(0x21) },
      { signerPubkeyHex: pubkey(0x12), signatureHex: "0x00" },
      consent(0x13, 0x23),
    ]);
    expect(out.signatureCount).toBe(1);
    expect(out.signerPubkeysHex[0]).toBe(pubkey(0x13));
  });
});
