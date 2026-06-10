import { describe, expect, it } from "vitest";
import type { ClusterResignationRow } from "@monolythium/core-sdk";
import {
  ML_DSA_65_PUBLIC_KEY_LEN,
  ML_DSA_65_SIGNATURE_LEN,
} from "@monolythium/core-sdk/crypto";
import {
  clusterResignationSigningPreimage,
  clusterResignationSummary,
  encodeClusterResignationTx,
  formatResignationHeight,
  resignationStatusTone,
  CLUSTER_RESIGNATION_PAYLOAD_LEN,
  FLAG_EXPEDITE_REQUESTED,
  TX_KIND_CLUSTER_RESIGNATION,
} from "./clusterResignations";

const rows: ClusterResignationRow[] = [
  {
    operator: "0x" + "11".repeat(48),
    status: "wire_pending",
    nonce: 1n,
    expedited: true,
  },
  {
    operator: "0x" + "22".repeat(48),
    status: "pending",
    submitted_at_height: 100n,
    effective_at_height: 120n,
    nonce: 2n,
    expedited: false,
  },
  {
    operator: "0x" + "33".repeat(48),
    status: "applied",
    submitted_at_height: 90n,
    effective_at_height: 110n,
    nonce: 3n,
    expedited: false,
  },
];

describe("cluster resignation helpers", () => {
  it("summarizes pending, wire-pending, applied, and expedited rows", () => {
    expect(clusterResignationSummary(rows)).toEqual({
      total: 3,
      pending: 1,
      wirePending: 1,
      applied: 1,
      expedited: 1,
    });
  });

  it("maps resignation statuses to UI tones", () => {
    expect(resignationStatusTone("applied")).toBe("ok");
    expect(resignationStatusTone("wire_pending")).toBe("info");
    expect(resignationStatusTone("pending")).toBe("warn");
  });

  it("formats optional heights without showing fabricated values", () => {
    expect(formatResignationHeight(120n)).toBe("120");
    expect(formatResignationHeight(undefined)).toBe("not submitted");
  });
});

describe("cluster resignation wire format", () => {
  const operatorPubkey = new Uint8Array(ML_DSA_65_PUBLIC_KEY_LEN).fill(0xab);
  const signature = new Uint8Array(ML_DSA_65_SIGNATURE_LEN).fill(0xcd);

  it("matches the payload length declared by the CLI/runtime", () => {
    // ML-DSA-65 pubkey (1952) + u64 nonce (8) + u8 flags (1) + ML-DSA-65 sig (3309).
    expect(CLUSTER_RESIGNATION_PAYLOAD_LEN).toBe(
      ML_DSA_65_PUBLIC_KEY_LEN + 8 + 1 + ML_DSA_65_SIGNATURE_LEN,
    );
    expect(TX_KIND_CLUSTER_RESIGNATION).toBe(0x05);
    expect(FLAG_EXPEDITE_REQUESTED).toBe(0x01);
  });

  it("builds the canonical signing pre-image (kind || operator || nonce_be || flags)", () => {
    const pre = clusterResignationSigningPreimage({
      operatorPubkey,
      nonce: 7n,
      flags: FLAG_EXPEDITE_REQUESTED,
    });
    expect(pre.length).toBe(1 + ML_DSA_65_PUBLIC_KEY_LEN + 8 + 1);
    expect(pre[0]).toBe(TX_KIND_CLUSTER_RESIGNATION);
    expect(pre.slice(1, 1 + ML_DSA_65_PUBLIC_KEY_LEN)).toEqual(operatorPubkey);
    // nonce 7 as big-endian u64.
    expect(Array.from(pre.slice(1 + ML_DSA_65_PUBLIC_KEY_LEN, 1 + ML_DSA_65_PUBLIC_KEY_LEN + 8))).toEqual([
      0, 0, 0, 0, 0, 0, 0, 7,
    ]);
    expect(pre[1 + ML_DSA_65_PUBLIC_KEY_LEN + 8]).toBe(FLAG_EXPEDITE_REQUESTED);
  });

  it("encodes the full frame (0x05 || operator || nonce_be || flags || signature)", () => {
    const raw = encodeClusterResignationTx({
      operatorPubkey,
      nonce: 1n,
      flags: 0,
      signature,
    });
    expect(raw.length).toBe(1 + CLUSTER_RESIGNATION_PAYLOAD_LEN);
    expect(raw[0]).toBe(TX_KIND_CLUSTER_RESIGNATION);
    let off = 1;
    expect(raw.slice(off, off + ML_DSA_65_PUBLIC_KEY_LEN)).toEqual(operatorPubkey);
    off += ML_DSA_65_PUBLIC_KEY_LEN;
    expect(Array.from(raw.slice(off, off + 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    off += 8;
    expect(raw[off]).toBe(0);
    off += 1;
    expect(raw.slice(off, off + ML_DSA_65_SIGNATURE_LEN)).toEqual(signature);
  });

  it("rejects mis-sized pubkey and signature", () => {
    expect(() =>
      encodeClusterResignationTx({
        operatorPubkey: new Uint8Array(10),
        nonce: 1n,
        flags: 0,
        signature,
      }),
    ).toThrow(/operator pubkey/);
    expect(() =>
      encodeClusterResignationTx({
        operatorPubkey,
        nonce: 1n,
        flags: 0,
        signature: new Uint8Array(10),
      }),
    ).toThrow(/signature/);
  });
});
