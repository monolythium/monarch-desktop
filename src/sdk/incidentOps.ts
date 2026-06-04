// Foundation incident-response executor submission helpers.
//
// `freezeAdmission(bytes32)` and
// `emergencyKeyRotation(bytes,uint64,uint64)` live on node-registry
// 0x1005. Desktop submits both only with the foundation operations
// signer stored in the OS keychain.

import {
  nodeRegistryAddressHex,
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT,
  RpcClient,
} from "@monolythium/core-sdk";
import {
  pqm1MnemonicToMlDsa65Backend,
  submitTransactionWithPrivacy,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { clampPriorityTip, type RegisterFeeQuote } from "./register";

export const FREEZE_ADMISSION_SELECTOR = "0x7a2605cd";
export const EMERGENCY_KEY_ROTATION_SELECTOR = "0x0aeeafbf";
export const DEFAULT_INCIDENT_EXECUTION_UNIT_LIMIT =
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT;
export const MAX_INCIDENT_INTENT_ID = (1n << 56n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

export interface SubmitFreezeAdmissionArgs {
  rpcUrl: string;
  foundationMnemonic: string;
  reasonHashHex: string;
  executionUnitLimit?: bigint;
}

export interface SubmitFreezeAdmissionResult {
  txHash: string;
  reasonHashHex: string;
  calldataHex: string;
  innerSighashHex: string;
  envelopeWireBytes: number;
}

export interface SubmitEmergencyKeyRotationArgs {
  rpcUrl: string;
  foundationMnemonic: string;
  targetPubkeyHex: string;
  effectiveEpoch: bigint | number | string;
  intentId: bigint | number | string;
  executionUnitLimit?: bigint;
}

export interface SubmitEmergencyKeyRotationResult {
  txHash: string;
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
  if (value === undefined || value === "") throw new Error(`${label}: expected uint64`);
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

export function encodeFreezeAdmissionCalldata(reasonHashHex: string): string {
  const selector = hexToBytes(FREEZE_ADMISSION_SELECTOR, "selector", 4);
  const reasonHash = hexToBytes(reasonHashHex, "reasonHashHex", 32);
  return bytesToHex(concat([selector, reasonHash]));
}

export function encodeEmergencyKeyRotationCalldata(args: {
  targetPubkeyHex: string;
  effectiveEpoch: bigint | number | string;
  intentId: bigint | number | string;
}): string {
  const selector = hexToBytes(EMERGENCY_KEY_ROTATION_SELECTOR, "selector", 4);
  const targetPubkey = hexToBytes(args.targetPubkeyHex, "targetPubkeyHex", 48);
  const effectiveEpoch = parseUint64(args.effectiveEpoch, "effectiveEpoch");
  if (effectiveEpoch === 0n) {
    throw new Error("effectiveEpoch: must be greater than zero");
  }
  const intentId = parseUint64(args.intentId, "intentId");
  if (intentId > MAX_INCIDENT_INTENT_ID) {
    throw new Error("intentId: exceeds 2^56-1");
  }
  const pubkeyTail = new Uint8Array(32);
  pubkeyTail.set(targetPubkey.slice(32, 48), 0);
  const calldata = concat([
    selector,
    u256BE(0x60n),
    u256BE(effectiveEpoch),
    u256BE(intentId),
    u256BE(48n),
    targetPubkey.slice(0, 32),
    pubkeyTail,
  ]);
  if ((calldata.length - 4) % 32 !== 0) {
    throw new Error(`emergencyKeyRotation calldata not 32-aligned (len=${calldata.length - 4})`);
  }
  return bytesToHex(calldata);
}

export function buildFreezeAdmissionTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  reasonHashHex: string;
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
    gasLimit: args.executionUnitLimit ?? DEFAULT_INCIDENT_EXECUTION_UNIT_LIMIT,
    to: nodeRegistryAddressHex(),
    value: 0n,
    input: encodeFreezeAdmissionCalldata(args.reasonHashHex),
  };
}

export function buildEmergencyKeyRotationTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  targetPubkeyHex: string;
  effectiveEpoch: bigint | number | string;
  intentId: bigint | number | string;
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
    gasLimit: args.executionUnitLimit ?? DEFAULT_INCIDENT_EXECUTION_UNIT_LIMIT,
    to: nodeRegistryAddressHex(),
    value: 0n,
    input: encodeEmergencyKeyRotationCalldata({
      targetPubkeyHex: args.targetPubkeyHex,
      effectiveEpoch: args.effectiveEpoch,
      intentId: args.intentId,
    }),
  };
}

export async function submitFreezeAdmission(
  args: SubmitFreezeAdmissionArgs,
): Promise<SubmitFreezeAdmissionResult> {
  const reasonHash = hexToBytes(args.reasonHashHex, "reasonHashHex", 32);
  const backend = pqm1MnemonicToMlDsa65Backend(args.foundationMnemonic);
  const rpc = new RpcClient(args.rpcUrl);
  const senderHex = bytesToHex(backend.addressBytes());
  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderHex),
    rpc.lythExecutionUnitPrice(),
  ]);
  const tx = buildFreezeAdmissionTxFields({
    chainId,
    nonce,
    fee,
    reasonHashHex: bytesToHex(reasonHash),
    executionUnitLimit: args.executionUnitLimit,
  });
  const calldataHex = encodeFreezeAdmissionCalldata(bytesToHex(reasonHash));
  const txHash = await submitTransactionWithPrivacy({
    client: rpc,
    backend,
    tx,
    private: false,
  });
  const signed = backend.signEvmTx(tx);
  return {
    txHash,
    reasonHashHex: bytesToHex(reasonHash),
    calldataHex,
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}

export async function submitEmergencyKeyRotation(
  args: SubmitEmergencyKeyRotationArgs,
): Promise<SubmitEmergencyKeyRotationResult> {
  const targetPubkey = hexToBytes(args.targetPubkeyHex, "targetPubkeyHex", 48);
  const effectiveEpoch = parseUint64(args.effectiveEpoch, "effectiveEpoch");
  const intentId = parseUint64(args.intentId, "intentId");
  const backend = pqm1MnemonicToMlDsa65Backend(args.foundationMnemonic);
  const rpc = new RpcClient(args.rpcUrl);
  const senderHex = bytesToHex(backend.addressBytes());
  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderHex),
    rpc.lythExecutionUnitPrice(),
  ]);
  const tx = buildEmergencyKeyRotationTxFields({
    chainId,
    nonce,
    fee,
    targetPubkeyHex: bytesToHex(targetPubkey),
    effectiveEpoch,
    intentId,
    executionUnitLimit: args.executionUnitLimit,
  });
  const calldataHex = encodeEmergencyKeyRotationCalldata({
    targetPubkeyHex: bytesToHex(targetPubkey),
    effectiveEpoch,
    intentId,
  });
  const txHash = await submitTransactionWithPrivacy({
    client: rpc,
    backend,
    tx,
    private: false,
  });
  const signed = backend.signEvmTx(tx);
  return {
    txHash,
    targetPubkeyHex: bytesToHex(targetPubkey),
    effectiveEpoch: effectiveEpoch.toString(),
    intentId: intentId.toString(),
    calldataHex,
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}
