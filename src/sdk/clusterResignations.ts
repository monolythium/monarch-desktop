import { type ClusterResignationRow } from "@monolythium/core-sdk";
import { makeRpcClient } from "./rpcTransport";
import {
  ML_DSA_65_PUBLIC_KEY_LEN,
  ML_DSA_65_SIGNATURE_LEN,
  pqm1MnemonicToMlDsa65Backend,
} from "@monolythium/core-sdk/crypto";

export type ClusterResignationSummary = {
  total: number;
  pending: number;
  wirePending: number;
  applied: number;
  expedited: number;
};

export type ClusterResignationTone = "ok" | "warn" | "info";

export function clusterResignationSummary(
  rows: readonly ClusterResignationRow[] | null | undefined,
): ClusterResignationSummary {
  const safeRows = rows ?? [];
  return {
    total: safeRows.length,
    pending: safeRows.filter((row) => row.status === "pending").length,
    wirePending: safeRows.filter((row) => row.status === "wire_pending").length,
    applied: safeRows.filter((row) => row.status === "applied").length,
    expedited: safeRows.filter((row) => row.expedited).length,
  };
}

export function resignationStatusTone(status: string): ClusterResignationTone {
  switch (status) {
    case "applied":
      return "ok";
    case "wire_pending":
      return "info";
    default:
      return "warn";
  }
}

export function formatResignationHeight(
  value: bigint | number | string | undefined,
): string {
  if (value === undefined) return "not submitted";
  try {
    return BigInt(value).toLocaleString();
  } catch {
    return "not submitted";
  }
}

// --- submit (Q120 cluster resignation) ------------------------------
//
// Mirrors the mono-core CLI `operator resign` / `build_cluster_resignation_tx`
// path: a `ClusterResignationTx` is a native, non-account protocol-maintenance
// frame keyed solely by the resigning operator's ML-DSA-65 consensus pubkey —
// the runtime resolves the operator's cluster from on-chain membership, so no
// cluster id is part of the signed payload. The operator's PQM-1 mnemonic
// derives that same 1952-byte consensus key (see `deriveOperatorConsensusPubkeyHex`
// in `register.ts`), so Desktop signs the resignation with `backend.sign(...)`
// exactly like register's possession proof.
//
// Canonical wire frame (`crates/execution/tx/src/{tx,cluster_resignation}.rs`):
//
//   0x05 (TX_KIND_CLUSTER_RESIGNATION)
//     || operator[1952 ML-DSA-65 pk]
//     || nonce_be[8 u64]
//     || flags[1]
//     || signature[3309 ML-DSA-65]
//
// Signing pre-image (`ClusterResignationTx::signing_preimage`):
//
//   0x05 || operator[1952] || nonce_be[8] || flags[1]
//
// The hex frame is submitted to `lyth_submitClusterResignation([txHex])`, which
// returns the tx hash. `flags` bit `0x01` requests a foundation expedite; the
// CLI never sets it and the executor still enforces the actual authority, so
// Desktop defaults it off.

/** `TX_KIND_CLUSTER_RESIGNATION` — first byte of the canonical frame. */
export const TX_KIND_CLUSTER_RESIGNATION = 0x05;

/** `flags` bit-0: operator requests a foundation expedite (Q105). The
 *  executor still enforces the foundation authority check. */
export const FLAG_EXPEDITE_REQUESTED = 0x01;

/** Fixed-width payload (everything after the kind tag): pubkey + u64
 *  nonce + u8 flags + signature. Changing this is a wire-format break. */
export const CLUSTER_RESIGNATION_PAYLOAD_LEN =
  ML_DSA_65_PUBLIC_KEY_LEN + 8 + 1 + ML_DSA_65_SIGNATURE_LEN;

const MAX_UINT64 = (1n << 64n) - 1n;

export interface SubmitClusterResignationArgs {
  rpcUrl: string;
  mnemonic: string;
  /** Operator-local resignation nonce. Must be strictly greater than the
   *  operator's last accepted resignation nonce (the CLI defaults to 1). */
  nonce: bigint | number | string;
  /** Request a foundation expedite (sets `FLAG_EXPEDITE_REQUESTED`). The
   *  executor enforces the actual foundation authority; defaults to false. */
  expedite?: boolean;
}

export interface ClusterResignationSubmitResult {
  txHash: string;
  operatorPubkeyHex: string;
  nonce: string;
  flags: number;
  signingPreimageHex: string;
  rawTxHex: string;
  rawTxBytes: number;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function parseUint64(value: bigint | number | string, label: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label}: expected safe integer`);
    parsed = BigInt(value);
  } else {
    const trimmed = value.trim();
    if (!/^\d+$/u.test(trimmed)) throw new Error(`${label}: expected decimal uint64`);
    parsed = BigInt(trimmed);
  }
  if (parsed < 0n || parsed > MAX_UINT64) {
    throw new Error(`${label}: out of uint64 range`);
  }
  return parsed;
}

function u64BE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Canonical `ClusterResignationTx::signing_preimage`:
 *  `0x05 || operator[1952] || nonce_be[8] || flags[1]`. */
export function clusterResignationSigningPreimage(args: {
  operatorPubkey: Uint8Array;
  nonce: bigint;
  flags: number;
}): Uint8Array {
  if (args.operatorPubkey.length !== ML_DSA_65_PUBLIC_KEY_LEN) {
    throw new Error(
      `operator pubkey: expected ${ML_DSA_65_PUBLIC_KEY_LEN} bytes, got ${args.operatorPubkey.length}`,
    );
  }
  const out = new Uint8Array(1 + ML_DSA_65_PUBLIC_KEY_LEN + 8 + 1);
  out[0] = TX_KIND_CLUSTER_RESIGNATION;
  out.set(args.operatorPubkey, 1);
  out.set(u64BE(args.nonce), 1 + ML_DSA_65_PUBLIC_KEY_LEN);
  out[1 + ML_DSA_65_PUBLIC_KEY_LEN + 8] = args.flags & 0xff;
  return out;
}

/** Encode the full canonical `Tx::ClusterResignation` wire frame:
 *  `0x05 || operator[1952] || nonce_be[8] || flags[1] || signature[3309]`. */
export function encodeClusterResignationTx(args: {
  operatorPubkey: Uint8Array;
  nonce: bigint;
  flags: number;
  signature: Uint8Array;
}): Uint8Array {
  if (args.operatorPubkey.length !== ML_DSA_65_PUBLIC_KEY_LEN) {
    throw new Error(
      `operator pubkey: expected ${ML_DSA_65_PUBLIC_KEY_LEN} bytes, got ${args.operatorPubkey.length}`,
    );
  }
  if (args.signature.length !== ML_DSA_65_SIGNATURE_LEN) {
    throw new Error(
      `signature: expected ${ML_DSA_65_SIGNATURE_LEN} bytes, got ${args.signature.length}`,
    );
  }
  const out = new Uint8Array(1 + CLUSTER_RESIGNATION_PAYLOAD_LEN);
  let off = 0;
  out[off] = TX_KIND_CLUSTER_RESIGNATION;
  off += 1;
  out.set(args.operatorPubkey, off);
  off += ML_DSA_65_PUBLIC_KEY_LEN;
  out.set(u64BE(args.nonce), off);
  off += 8;
  out[off] = args.flags & 0xff;
  off += 1;
  out.set(args.signature, off);
  return out;
}

/**
 * Build, sign, and submit a `ClusterResignationTx` from the operator's
 * PQM-1 mnemonic. Returns the submitted tx hash plus the canonical frame
 * bytes for the local audit trail. The operator's cluster is resolved
 * on-chain from membership — there is no cluster id in the signed payload.
 */
export async function submitClusterResignation(
  args: SubmitClusterResignationArgs,
): Promise<ClusterResignationSubmitResult> {
  const rpc = makeRpcClient(args.rpcUrl);
  const nonce = parseUint64(args.nonce, "nonce");
  const flags = args.expedite ? FLAG_EXPEDITE_REQUESTED : 0;
  const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
  const operatorPubkey = backend.publicKey();

  const preimage = clusterResignationSigningPreimage({
    operatorPubkey,
    nonce,
    flags,
  });
  const signature = backend.sign(preimage);
  const raw = encodeClusterResignationTx({
    operatorPubkey,
    nonce,
    flags,
    signature,
  });
  const rawTxHex = bytesToHex(raw);

  const txHash = await rpc.call<string>("lyth_submitClusterResignation", [rawTxHex]);

  return {
    txHash,
    operatorPubkeyHex: bytesToHex(operatorPubkey),
    nonce: nonce.toString(),
    flags,
    signingPreimageHex: bytesToHex(preimage),
    rawTxHex,
    rawTxBytes: raw.length,
  };
}
