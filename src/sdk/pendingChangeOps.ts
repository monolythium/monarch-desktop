// Foundation pending-change submission helpers.
//
// `submitPendingChange(uint8,bytes,uint64,uint64)` is the node-registry
// roster-lifecycle executor for foundation-coordinated Add / Remove /
// Rotate operations. Desktop wraps it in the same native plaintext tx path
// used for register and recovery, and only calls it when the foundation
// signer is present in the OS keychain.

import {
  addressToTypedBech32,
  nodeRegistryAddressHex,
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT,
} from "@monolythium/core-sdk";
import { makeRpcClient } from "./rpcTransport";
import {
  mnemonicToMlDsa65Backend,
  submitTransactionWithPrivacy,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { clampPriorityTip, type RegisterFeeQuote } from "./register";
import { NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES } from "./operatorKeys";

export const SUBMIT_PENDING_CHANGE_SELECTOR = "0x7d09426c";
export const DEFAULT_PENDING_CHANGE_EXECUTION_UNIT_LIMIT =
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT;
export const MAX_PENDING_CHANGE_INTENT_ID = (1n << 56n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

export type PendingChangeKind = "add" | "remove" | "rotate";

export const PENDING_CHANGE_KIND_CODES: Record<PendingChangeKind, number> = {
  add: 1,
  remove: 2,
  rotate: 3,
};

const PENDING_CHANGE_KIND_LABELS: Record<number, PendingChangeKind> = {
  1: "add",
  2: "remove",
  3: "rotate",
};

export interface SubmitPendingChangeArgs {
  rpcUrl: string;
  foundationMnemonic: string;
  kind: PendingChangeKind | number;
  targetPubkeyHex: string;
  effectiveEpoch: bigint | number | string;
  intentId?: bigint | number | string;
  executionUnitLimit?: bigint;
}

export interface SubmitPendingChangeResult {
  txHash: string;
  kind: PendingChangeKind;
  kindCode: number;
  targetPubkeyHex: string;
  effectiveEpoch: string;
  intentId: string;
  calldataHex: string;
  innerSighashHex: string;
  envelopeWireBytes: number;
}

function stripHex(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

function bytesToHex(b: Uint8Array): string {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(s: string, label: string, expectedLen?: number): Uint8Array {
  const clean = stripHex(s.trim());
  if (clean.length % 2 !== 0) throw new Error(`${label}: odd hex length`);
  if (!/^[0-9a-fA-F]*$/u.test(clean)) throw new Error(`${label}: invalid hex`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  if (expectedLen !== undefined && out.length !== expectedLen) {
    throw new Error(`${label}: expected ${expectedLen} bytes, got ${out.length}`);
  }
  return out;
}

function parseUint64(value: bigint | number | string | undefined, label: string): bigint {
  if (value === undefined || value === "") {
    throw new Error(`${label}: expected uint64`);
  }
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

function u256BE(value: bigint | number): Uint8Array {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n || v >= 1n << 256n) throw new Error("u256 out of range");
  const out = new Uint8Array(32);
  let n = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function padTo32(buf: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil(buf.length / 32) * 32;
  if (paddedLength === buf.length) return buf;
  const out = new Uint8Array(paddedLength);
  out.set(buf);
  return out;
}

export function normalizePendingChangeKind(
  kind: PendingChangeKind | number,
): { kind: PendingChangeKind; kindCode: number } {
  if (typeof kind === "number") {
    const label = PENDING_CHANGE_KIND_LABELS[kind];
    if (!label) throw new Error(`kind: unknown pending-change kind ${kind}`);
    return { kind: label, kindCode: kind };
  }
  const kindCode = PENDING_CHANGE_KIND_CODES[kind];
  if (!kindCode) throw new Error(`kind: unknown pending-change kind ${kind}`);
  return { kind, kindCode };
}

export function encodeSubmitPendingChangeCalldata(args: {
  kind: PendingChangeKind | number;
  targetPubkeyHex: string;
  effectiveEpoch: bigint | number | string;
  intentId?: bigint | number | string;
}): string {
  const { kind, kindCode } = normalizePendingChangeKind(args.kind);
  const targetPubkey = hexToBytes(
    args.targetPubkeyHex,
    "targetPubkey",
    NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  );
  const effectiveEpoch = parseUint64(args.effectiveEpoch, "effectiveEpoch");
  if (effectiveEpoch === 0n) {
    throw new Error("effectiveEpoch: must be greater than zero");
  }
  const intentId = parseUint64(args.intentId ?? 0n, "intentId");
  if (intentId > MAX_PENDING_CHANGE_INTENT_ID) {
    throw new Error("intentId: exceeds 2^56-1");
  }
  if (kind !== "rotate" && intentId !== 0n) {
    throw new Error("intentId: only rotate pending changes may carry a non-zero intent id");
  }

  const selector = hexToBytes(SUBMIT_PENDING_CHANGE_SELECTOR, "selector", 4);
  const pubkeyPadded = padTo32(targetPubkey);

  const calldata = concat([
    selector,
    u256BE(kindCode),
    u256BE(0x80n),
    u256BE(effectiveEpoch),
    u256BE(intentId),
    u256BE(targetPubkey.length),
    pubkeyPadded,
  ]);
  if ((calldata.length - 4) % 32 !== 0) {
    throw new Error(`submitPendingChange calldata not 32-aligned (len=${calldata.length - 4})`);
  }
  return bytesToHex(calldata);
}

export function buildSubmitPendingChangeTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  kind: PendingChangeKind | number;
  targetPubkeyHex: string;
  effectiveEpoch: bigint | number | string;
  intentId?: bigint | number | string;
  executionUnitLimit?: bigint;
}): NativeEvmTxFields {
  const maxExecutionUnitPrice = BigInt(args.fee.executionUnitPriceLythoshi);
  const suggestedTip = BigInt(args.fee.priorityTipLythoshi);
  const priorityTip = clampPriorityTip(suggestedTip, maxExecutionUnitPrice);

  return {
    chainId: args.chainId,
    nonce: args.nonce,
    maxFeePerGas: maxExecutionUnitPrice,
    maxPriorityFeePerGas: priorityTip,
    gasLimit: args.executionUnitLimit ?? DEFAULT_PENDING_CHANGE_EXECUTION_UNIT_LIMIT,
    to: nodeRegistryAddressHex(),
    value: 0n,
    input: encodeSubmitPendingChangeCalldata({
      kind: args.kind,
      targetPubkeyHex: args.targetPubkeyHex,
      effectiveEpoch: args.effectiveEpoch,
      intentId: args.intentId,
    }),
  };
}

export async function submitPendingChange(
  args: SubmitPendingChangeArgs,
): Promise<SubmitPendingChangeResult> {
  const { kind, kindCode } = normalizePendingChangeKind(args.kind);
  const targetPubkey = hexToBytes(
    args.targetPubkeyHex,
    "targetPubkey",
    NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  );
  const effectiveEpoch = parseUint64(args.effectiveEpoch, "effectiveEpoch");
  const intentId = parseUint64(args.intentId ?? 0n, "intentId");
  const backend = mnemonicToMlDsa65Backend(args.foundationMnemonic);
  const rpc = makeRpcClient(args.rpcUrl);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());

  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);

  const tx = buildSubmitPendingChangeTxFields({
    chainId,
    nonce,
    fee,
    kind,
    targetPubkeyHex: bytesToHex(targetPubkey),
    effectiveEpoch,
    intentId,
    executionUnitLimit: args.executionUnitLimit,
  });
  const calldataHex = tx.input;
  if (typeof calldataHex !== "string") {
    throw new Error("submitPendingChange tx input was not hex-encoded");
  }

  const txHash = await submitTransactionWithPrivacy({
    client: rpc,
    backend,
    tx,
    private: false,
  });

  const signed = backend.signEvmTx(tx);
  return {
    txHash,
    kind,
    kindCode,
    targetPubkeyHex: bytesToHex(targetPubkey),
    effectiveEpoch: effectiveEpoch.toString(),
    intentId: intentId.toString(),
    calldataHex,
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}
