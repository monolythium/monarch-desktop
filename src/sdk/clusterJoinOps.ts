// CJ-1 cluster-admission ABI helpers.
//
// These mirror the mono-core-sdk W1 helpers while Desktop still consumes the
// last published SDK package. Broadcast is guarded by a live
// getClusterJoinRequest preflight so current chains that do not expose CJ-1
// fail before signing or submitting.

import {
  addressToTypedBech32,
  nodeRegistryAddressHex,
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT,
  RpcClient,
} from "@monolythium/core-sdk";
import {
  pqm1MnemonicToMlDsa65Backend,
  submitTransactionWithPrivacy,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import {
  NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  operatorPubkeyHash,
} from "./operatorKeys";
import { clampPriorityTip, type RegisterFeeQuote } from "./register";

export const REQUEST_CLUSTER_JOIN_SELECTOR = "0xe1dd13bd";
export const VOTE_CLUSTER_ADMIT_SELECTOR = "0x20519d4f";
export const CANCEL_CLUSTER_JOIN_SELECTOR = "0x3e2d51c3";
export const EXPIRE_CLUSTER_JOIN_SELECTOR = "0xeeb96895";
export const GET_CLUSTER_JOIN_REQUEST_SELECTOR = "0x224de9bf";

export const DEFAULT_CLUSTER_JOIN_EXECUTION_UNIT_LIMIT =
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT;
export const CLUSTER_JOIN_REQUEST_TTL_EPOCHS = 6;

const MAX_UINT32 = (1n << 32n) - 1n;
const CLUSTER_JOIN_REQUEST_VIEW_WORDS = 8;
const BYTES_PER_WORD = 32;

export type ClusterJoinRequestStatus =
  | "none"
  | "open"
  | "admitted"
  | "cancelled"
  | "expired";

export interface ClusterJoinRequestView {
  owner: string;
  requestEpoch: string;
  snapshotThreshold: number;
  snapshotN: number;
  voteCount: number;
  status: ClusterJoinRequestStatus;
  statusCode: number;
  bondLythoshi: string;
  sealRosterPending: boolean;
  exists: boolean;
}

export type ClusterJoinReadClient = {
  call<T>(method: string, params?: unknown): Promise<T>;
};

export interface RequestClusterJoinCalldataArgs {
  clusterId: bigint | number | string;
  operatorPubkeyHex: string;
}

export interface VoteClusterAdmitCalldataArgs {
  clusterId: bigint | number | string;
  operatorIdHex: string;
  voterPubkeyHex: string;
}

export interface ClusterJoinByOperatorIdCalldataArgs {
  clusterId: bigint | number | string;
  operatorIdHex: string;
}

export interface SubmitRequestClusterJoinArgs {
  rpcUrl: string;
  mnemonic: string;
  clusterId: bigint | number | string;
  operatorPubkeyHex: string;
  bondLythoshi: bigint | number | string;
  executionUnitLimit?: bigint;
}

export interface SubmitVoteClusterAdmitArgs {
  rpcUrl: string;
  mnemonic: string;
  clusterId: bigint | number | string;
  operatorIdHex: string;
  voterPubkeyHex: string;
  executionUnitLimit?: bigint;
}

export interface ClusterJoinSubmitResult {
  txHash: string;
  clusterId: string;
  operatorIdHex: string;
  innerSighashHex: string;
  envelopeWireBytes: number;
}

function stripHex(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(value: string, label: string, expectedLen?: number): Uint8Array {
  const clean = stripHex(value.trim());
  if (clean.length % 2 !== 0) throw new Error(`${label}: odd hex length`);
  if (!/^[0-9a-fA-F]*$/u.test(clean)) throw new Error(`${label}: invalid hex`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  if (expectedLen !== undefined && out.length !== expectedLen) {
    throw new Error(`${label}: expected ${expectedLen} bytes, got ${out.length}`);
  }
  return out;
}

function normalizeHex(value: string, label: string): string {
  const clean = stripHex(value.trim());
  if (clean.length % 2 !== 0) throw new Error(`${label}: odd hex length`);
  if (!/^[0-9a-fA-F]*$/u.test(clean)) throw new Error(`${label}: invalid hex`);
  return clean.toLowerCase();
}

function wordToBigInt(wordHex: string): bigint {
  return BigInt(`0x${wordHex}`);
}

function wordToSafeNumber(wordHex: string, label: string): number {
  const parsed = wordToBigInt(wordHex);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label}: exceeds safe integer range`);
  }
  return Number(parsed);
}

function clusterJoinStatusFromCode(code: number): ClusterJoinRequestStatus {
  switch (code) {
    case 1:
      return "open";
    case 2:
      return "admitted";
    case 3:
      return "cancelled";
    case 4:
      return "expired";
    default:
      return "none";
  }
}

function parseUint32(value: bigint | number | string, label: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label}: expected safe integer`);
    parsed = BigInt(value);
  } else {
    const trimmed = value.trim();
    if (!/^\d+$/u.test(trimmed)) throw new Error(`${label}: expected decimal uint32`);
    parsed = BigInt(trimmed);
  }
  if (parsed < 0n || parsed > MAX_UINT32) {
    throw new Error(`${label}: out of uint32 range`);
  }
  return parsed;
}

function parseNonNegativeU256(value: bigint | number | string, label: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label}: expected safe integer`);
    parsed = BigInt(value);
  } else {
    const trimmed = value.trim();
    if (!/^\d+$/u.test(trimmed)) throw new Error(`${label}: expected decimal uint256`);
    parsed = BigInt(trimmed);
  }
  if (parsed < 0n || parsed >= 1n << 256n) {
    throw new Error(`${label}: out of uint256 range`);
  }
  return parsed;
}

function u256BE(value: bigint | number): Uint8Array {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n || v >= 1n << 256n) throw new Error("u256 out of range");
  const out = new Uint8Array(32);
  let n = v;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function padTo32(bytes: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil(bytes.length / 32) * 32;
  if (paddedLength === bytes.length) return bytes;
  const out = new Uint8Array(paddedLength);
  out.set(bytes);
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

export function encodeRequestClusterJoinCalldata(
  args: RequestClusterJoinCalldataArgs,
): string {
  const operatorPubkey = hexToBytes(
    args.operatorPubkeyHex,
    "operatorPubkey",
    NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  );
  const calldata = concat([
    hexToBytes(REQUEST_CLUSTER_JOIN_SELECTOR, "selector", 4),
    u256BE(parseUint32(args.clusterId, "clusterId")),
    u256BE(2n * 32n),
    u256BE(operatorPubkey.length),
    padTo32(operatorPubkey),
  ]);
  return bytesToHex(calldata);
}

export function encodeVoteClusterAdmitCalldata(
  args: VoteClusterAdmitCalldataArgs,
): string {
  const operatorId = hexToBytes(args.operatorIdHex, "operatorId", 32);
  const voterPubkey = hexToBytes(
    args.voterPubkeyHex,
    "voterPubkey",
    NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  );
  const calldata = concat([
    hexToBytes(VOTE_CLUSTER_ADMIT_SELECTOR, "selector", 4),
    u256BE(parseUint32(args.clusterId, "clusterId")),
    operatorId,
    u256BE(3n * 32n),
    u256BE(voterPubkey.length),
    padTo32(voterPubkey),
  ]);
  return bytesToHex(calldata);
}

export function encodeCancelClusterJoinCalldata(
  args: ClusterJoinByOperatorIdCalldataArgs,
): string {
  const calldata = concat([
    hexToBytes(CANCEL_CLUSTER_JOIN_SELECTOR, "selector", 4),
    u256BE(parseUint32(args.clusterId, "clusterId")),
    hexToBytes(args.operatorIdHex, "operatorId", 32),
  ]);
  return bytesToHex(calldata);
}

export function encodeExpireClusterJoinCalldata(
  args: ClusterJoinByOperatorIdCalldataArgs,
): string {
  const calldata = concat([
    hexToBytes(EXPIRE_CLUSTER_JOIN_SELECTOR, "selector", 4),
    u256BE(parseUint32(args.clusterId, "clusterId")),
    hexToBytes(args.operatorIdHex, "operatorId", 32),
  ]);
  return bytesToHex(calldata);
}

export function encodeGetClusterJoinRequestCalldata(
  args: ClusterJoinByOperatorIdCalldataArgs,
): string {
  const calldata = concat([
    hexToBytes(GET_CLUSTER_JOIN_REQUEST_SELECTOR, "selector", 4),
    u256BE(parseUint32(args.clusterId, "clusterId")),
    hexToBytes(args.operatorIdHex, "operatorId", 32),
  ]);
  return bytesToHex(calldata);
}

export function deriveClusterJoinOperatorIdHex(operatorPubkeyHex: string): string {
  const operatorPubkey = hexToBytes(
    operatorPubkeyHex,
    "operatorPubkey",
    NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  );
  return bytesToHex(operatorPubkeyHash(operatorPubkey));
}

export function decodeClusterJoinRequestView(value: string): ClusterJoinRequestView {
  const clean = normalizeHex(value, "clusterJoinRequestView");
  const expectedHexChars = CLUSTER_JOIN_REQUEST_VIEW_WORDS * BYTES_PER_WORD * 2;
  if (clean.length !== expectedHexChars) {
    throw new Error(
      `clusterJoinRequestView: expected ${CLUSTER_JOIN_REQUEST_VIEW_WORDS} ABI words, got ${clean.length / 64}`,
    );
  }
  const word = (index: number) => clean.slice(index * 64, (index + 1) * 64);
  const owner = `0x${word(0).slice(24)}`;
  const statusCode = wordToSafeNumber(word(5), "status");
  const status = clusterJoinStatusFromCode(statusCode);
  const bond = wordToBigInt(word(6));
  const sealRosterPending = wordToBigInt(word(7)) !== 0n;
  const zeroOwner = owner === "0x0000000000000000000000000000000000000000";

  return {
    owner,
    requestEpoch: wordToBigInt(word(1)).toString(),
    snapshotThreshold: wordToSafeNumber(word(2), "snapshotThreshold"),
    snapshotN: wordToSafeNumber(word(3), "snapshotN"),
    voteCount: wordToSafeNumber(word(4), "voteCount"),
    status,
    statusCode,
    bondLythoshi: bond.toString(),
    sealRosterPending,
    exists: status !== "none" || !zeroOwner || bond !== 0n,
  };
}

export async function readClusterJoinRequest(
  client: ClusterJoinReadClient,
  args: ClusterJoinByOperatorIdCalldataArgs,
): Promise<ClusterJoinRequestView> {
  const data = encodeGetClusterJoinRequestCalldata(args);
  const output = await client.call<string>("eth_call", [
    {
      to: nodeRegistryAddressHex(),
      data,
    },
    "latest",
  ]);
  return decodeClusterJoinRequestView(output);
}

async function preflightClusterJoinView(
  client: ClusterJoinReadClient,
  args: ClusterJoinByOperatorIdCalldataArgs,
): Promise<ClusterJoinRequestView> {
  try {
    return await readClusterJoinRequest(client, args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `CJ-1 getClusterJoinRequest is not exposed or failed on the connected chain: ${message}`,
    );
  }
}

export function buildRequestClusterJoinTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  clusterId: bigint | number | string;
  operatorPubkeyHex: string;
  bondLythoshi: bigint | number | string;
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
    gasLimit: args.executionUnitLimit ?? DEFAULT_CLUSTER_JOIN_EXECUTION_UNIT_LIMIT,
    to: nodeRegistryAddressHex(),
    value: parseNonNegativeU256(args.bondLythoshi, "bondLythoshi"),
    input: encodeRequestClusterJoinCalldata({
      clusterId: args.clusterId,
      operatorPubkeyHex: args.operatorPubkeyHex,
    }),
  };
}

export function buildVoteClusterAdmitTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  clusterId: bigint | number | string;
  operatorIdHex: string;
  voterPubkeyHex: string;
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
    gasLimit: args.executionUnitLimit ?? DEFAULT_CLUSTER_JOIN_EXECUTION_UNIT_LIMIT,
    to: nodeRegistryAddressHex(),
    value: 0n,
    input: encodeVoteClusterAdmitCalldata({
      clusterId: args.clusterId,
      operatorIdHex: args.operatorIdHex,
      voterPubkeyHex: args.voterPubkeyHex,
    }),
  };
}

export async function submitRequestClusterJoin(
  args: SubmitRequestClusterJoinArgs,
): Promise<ClusterJoinSubmitResult> {
  const rpc = new RpcClient(args.rpcUrl);
  const clusterId = parseUint32(args.clusterId, "clusterId");
  const operatorIdHex = deriveClusterJoinOperatorIdHex(args.operatorPubkeyHex);
  const existing = await preflightClusterJoinView(rpc, {
    clusterId,
    operatorIdHex,
  });
  if (existing.status === "open") {
    throw new Error("cluster join request is already open for this operator");
  }
  if (existing.status === "admitted") {
    throw new Error("operator is already admitted for this cluster request");
  }

  const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());
  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);
  const tx = buildRequestClusterJoinTxFields({
    chainId,
    nonce,
    fee,
    clusterId,
    operatorPubkeyHex: args.operatorPubkeyHex,
    bondLythoshi: args.bondLythoshi,
    executionUnitLimit: args.executionUnitLimit,
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
    clusterId: clusterId.toString(),
    operatorIdHex,
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}

export async function submitVoteClusterAdmit(
  args: SubmitVoteClusterAdmitArgs,
): Promise<ClusterJoinSubmitResult> {
  const rpc = new RpcClient(args.rpcUrl);
  const clusterId = parseUint32(args.clusterId, "clusterId");
  const operatorIdHex = bytesToHex(hexToBytes(args.operatorIdHex, "operatorId", 32));
  const existing = await preflightClusterJoinView(rpc, {
    clusterId,
    operatorIdHex,
  });
  if (!existing.exists || existing.status !== "open") {
    throw new Error("candidate cluster join request is not open for voting");
  }

  const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());
  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);
  const tx = buildVoteClusterAdmitTxFields({
    chainId,
    nonce,
    fee,
    clusterId,
    operatorIdHex,
    voterPubkeyHex: args.voterPubkeyHex,
    executionUnitLimit: args.executionUnitLimit,
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
    clusterId: clusterId.toString(),
    operatorIdHex,
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}
