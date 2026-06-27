// CJ-1 cluster-admission ABI helpers.
//
// These keep Desktop's UI-facing CJ-1 shapes aligned with the published SDK
// ABI semantics. Broadcast is guarded by native lyth_* onboarding previews so
// public RPC does not need to expose broad eth_call simulation.

import {
  addressToTypedBech32,
  buildRequestClusterJoinTxFields as buildSdkRequestClusterJoinTxFields,
  buildVoteClusterAdmitTxFields as buildSdkVoteClusterAdmitTxFields,
  clusterJoinRequestExists,
  decodeClusterJoinRequest as decodeSdkClusterJoinRequest,
  deriveClusterJoinOperatorId,
  encodeCancelClusterJoinCalldata as encodeSdkCancelClusterJoinCalldata,
  encodeExpireClusterJoinCalldata as encodeSdkExpireClusterJoinCalldata,
  encodeGetClusterJoinRequestCalldata as encodeSdkGetClusterJoinRequestCalldata,
  encodeRequestClusterJoinCalldata as encodeSdkRequestClusterJoinCalldata,
  encodeVoteClusterAdmitCalldata as encodeSdkVoteClusterAdmitCalldata,
  NODE_REGISTRY_SELECTORS,
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT,
  type ClusterJoinRequestView as SdkClusterJoinRequestView,
} from "@monolythium/core-sdk";
import { makeRpcClient } from "./rpcTransport";
import {
  MempoolClass,
  mnemonicToMlDsa65Backend,
  submitTransactionWithPrivacy,
  type ClusterSealKeysSource,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { resolveTestnetClusterSealKeysSource } from "./clusterSeal";
import { clampPriorityTip, type RegisterFeeQuote } from "./register";

export const REQUEST_CLUSTER_JOIN_SELECTOR = NODE_REGISTRY_SELECTORS.requestClusterJoin;
export const VOTE_CLUSTER_ADMIT_SELECTOR = NODE_REGISTRY_SELECTORS.voteClusterAdmit;
export const CANCEL_CLUSTER_JOIN_SELECTOR = NODE_REGISTRY_SELECTORS.cancelClusterJoin;
export const EXPIRE_CLUSTER_JOIN_SELECTOR = NODE_REGISTRY_SELECTORS.expireClusterJoin;
export const GET_CLUSTER_JOIN_REQUEST_SELECTOR = NODE_REGISTRY_SELECTORS.getClusterJoinRequest;

export const DEFAULT_CLUSTER_JOIN_EXECUTION_UNIT_LIMIT =
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT;
export const CLUSTER_JOIN_REQUEST_TTL_EPOCHS = 6;

const MAX_UINT32 = (1n << 32n) - 1n;

export type ClusterJoinRequestStatus =
  | "none"
  | "open"
  | "admitted"
  | "cancelled"
  | "expired"
  | "unknown";

export interface ClusterJoinRequestView {
  owner: string | null;
  requestEpoch: string;
  requestNonce?: string;
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

export interface OperatorOnboardingPreview {
  schemaVersion: number;
  capability: string;
  method: string;
  ok: boolean;
  status: "ok" | "rejected" | string;
  reason?: string | null;
  message?: string | null;
  clusterId?: number;
  operatorId?: string;
  details?: Record<string, unknown>;
}

interface NativeClusterJoinRequestEnvelope {
  schemaVersion: number;
  capability: string;
  method: "getClusterJoinRequest";
  clusterId: number;
  operatorId: string;
  request: {
    exists: boolean;
    owner: string | null;
    requestEpoch: string;
    requestNonce?: string;
    snapshotThreshold: number;
    snapshotN: number;
    voteCount: number;
    status: ClusterJoinRequestStatus;
    statusCode: number;
    bondLythoshi: string;
    sealRosterPending: boolean;
  };
}

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
  private?: boolean;
  clusterSealKeysSource?: ClusterSealKeysSource;
}

export interface SubmitVoteClusterAdmitArgs {
  rpcUrl: string;
  mnemonic: string;
  clusterId: bigint | number | string;
  operatorIdHex: string;
  voterPubkeyHex: string;
  executionUnitLimit?: bigint;
  private?: boolean;
  clusterSealKeysSource?: ClusterSealKeysSource;
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

export function encodeRequestClusterJoinCalldata(
  args: RequestClusterJoinCalldataArgs,
): string {
  return encodeSdkRequestClusterJoinCalldata({
    clusterId: args.clusterId,
    operatorPubkey: args.operatorPubkeyHex,
  });
}

export function encodeVoteClusterAdmitCalldata(
  args: VoteClusterAdmitCalldataArgs,
): string {
  return encodeSdkVoteClusterAdmitCalldata({
    clusterId: args.clusterId,
    operatorId: args.operatorIdHex,
    voterPubkey: args.voterPubkeyHex,
  });
}

export function encodeCancelClusterJoinCalldata(
  args: ClusterJoinByOperatorIdCalldataArgs,
): string {
  return encodeSdkCancelClusterJoinCalldata({
    clusterId: args.clusterId,
    operatorId: args.operatorIdHex,
  });
}

export function encodeExpireClusterJoinCalldata(
  args: ClusterJoinByOperatorIdCalldataArgs,
): string {
  return encodeSdkExpireClusterJoinCalldata({
    clusterId: args.clusterId,
    operatorId: args.operatorIdHex,
  });
}

export function encodeGetClusterJoinRequestCalldata(
  args: ClusterJoinByOperatorIdCalldataArgs,
): string {
  return encodeSdkGetClusterJoinRequestCalldata({
    clusterId: args.clusterId,
    operatorId: args.operatorIdHex,
  });
}

export function deriveClusterJoinOperatorIdHex(operatorPubkeyHex: string): string {
  return deriveClusterJoinOperatorId(operatorPubkeyHex);
}

export function decodeClusterJoinRequestView(value: string): ClusterJoinRequestView {
  const decoded = decodeSdkClusterJoinRequest(value);
  return adaptClusterJoinRequestView(decoded);
}

function adaptClusterJoinRequestView(view: SdkClusterJoinRequestView): ClusterJoinRequestView {
  return {
    owner: view.owner,
    requestEpoch: view.requestEpoch.toString(),
    snapshotThreshold: view.snapshotThreshold,
    snapshotN: view.snapshotN,
    voteCount: view.voteCount,
    status: view.status,
    statusCode: view.statusCode,
    bondLythoshi: view.bondLythoshi.toString(),
    sealRosterPending: view.sealRosterPending,
    exists: clusterJoinRequestExists(view),
  };
}

function adaptNativeClusterJoinRequestView(
  view: NativeClusterJoinRequestEnvelope["request"],
): ClusterJoinRequestView {
  return {
    owner: view.owner,
    requestEpoch: view.requestEpoch,
    requestNonce: view.requestNonce,
    snapshotThreshold: view.snapshotThreshold,
    snapshotN: view.snapshotN,
    voteCount: view.voteCount,
    status: view.status,
    statusCode: view.statusCode,
    bondLythoshi: view.bondLythoshi,
    sealRosterPending: view.sealRosterPending,
    exists: view.exists,
  };
}

function previewError(action: string, preview: OperatorOnboardingPreview): Error {
  const reason = preview.reason ? `: ${preview.reason}` : "";
  const message = preview.message ? ` (${preview.message})` : "";
  return new Error(`${action} preview rejected${reason}${message}`);
}

function assertPreviewOk(action: string, preview: OperatorOnboardingPreview): void {
  if (!preview.ok) throw previewError(action, preview);
}

export async function readClusterJoinRequest(
  client: ClusterJoinReadClient,
  args: ClusterJoinByOperatorIdCalldataArgs,
): Promise<ClusterJoinRequestView> {
  const clusterId = parseUint32(args.clusterId, "clusterId");
  const operatorIdHex = bytesToHex(hexToBytes(args.operatorIdHex, "operatorId", 32));
  const envelope = await client.call<NativeClusterJoinRequestEnvelope>("lyth_getClusterJoinRequest", [
    Number(clusterId),
    operatorIdHex,
  ]);
  return adaptNativeClusterJoinRequestView(envelope.request);
}

export async function previewRequestClusterJoin(
  client: ClusterJoinReadClient,
  args: {
    from: string;
    clusterId: bigint | number | string;
    operatorPubkeyHex: string;
    bondLythoshi: bigint | number | string;
  },
): Promise<OperatorOnboardingPreview> {
  const clusterId = parseUint32(args.clusterId, "clusterId");
  try {
    return await client.call<OperatorOnboardingPreview>("lyth_previewRequestClusterJoin", [{
      from: args.from,
      clusterId: Number(clusterId),
      operatorPubkey: args.operatorPubkeyHex,
      bondLythoshi: args.bondLythoshi.toString(),
    }]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Join-request preview is unavailable from the connected node: ${message}`);
  }
}

export async function previewVoteClusterAdmit(
  client: ClusterJoinReadClient,
  args: {
    from: string;
    clusterId: bigint | number | string;
    operatorIdHex: string;
    voterPubkeyHex: string;
  },
): Promise<OperatorOnboardingPreview> {
  const clusterId = parseUint32(args.clusterId, "clusterId");
  const operatorIdHex = bytesToHex(hexToBytes(args.operatorIdHex, "operatorId", 32));
  try {
    return await client.call<OperatorOnboardingPreview>("lyth_previewVoteClusterAdmit", [{
      from: args.from,
      clusterId: Number(clusterId),
      operatorId: operatorIdHex,
      voterPubkey: args.voterPubkeyHex,
    }]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Admission-vote preview is unavailable from the connected node: ${message}`);
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

  return buildSdkRequestClusterJoinTxFields({
    chainId: args.chainId,
    nonce: args.nonce,
    fee: {
      maxFeePerGas: maxExecutionUnitPrice,
      maxPriorityFeePerGas: priorityTip,
      gasLimit: args.executionUnitLimit ?? DEFAULT_CLUSTER_JOIN_EXECUTION_UNIT_LIMIT,
    },
    clusterId: args.clusterId,
    operatorPubkey: args.operatorPubkeyHex,
    bondLythoshi: args.bondLythoshi,
  });
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

  return buildSdkVoteClusterAdmitTxFields({
    chainId: args.chainId,
    nonce: args.nonce,
    fee: {
      maxFeePerGas: maxExecutionUnitPrice,
      maxPriorityFeePerGas: priorityTip,
      gasLimit: args.executionUnitLimit ?? DEFAULT_CLUSTER_JOIN_EXECUTION_UNIT_LIMIT,
    },
    clusterId: args.clusterId,
    operatorId: args.operatorIdHex,
    voterPubkey: args.voterPubkeyHex,
  });
}

export async function submitRequestClusterJoin(
  args: SubmitRequestClusterJoinArgs,
): Promise<ClusterJoinSubmitResult> {
  const rpc = makeRpcClient(args.rpcUrl);
  const clusterId = parseUint32(args.clusterId, "clusterId");
  const operatorIdHex = deriveClusterJoinOperatorIdHex(args.operatorPubkeyHex);
  const backend = mnemonicToMlDsa65Backend(args.mnemonic);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());
  const preview = await previewRequestClusterJoin(rpc, {
    from: senderAddress,
    clusterId,
    operatorPubkeyHex: args.operatorPubkeyHex,
    bondLythoshi: args.bondLythoshi,
  });
  assertPreviewOk("requestClusterJoin", preview);

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
  // Plaintext by default — CJ-1 admission is public, and a not-yet-member's
  // sealed envelope cannot be decrypted by the cluster (-32047). Opt-in seal.
  const privateSubmit = args.private === true;
  const clusterSealKeysSource = privateSubmit
    ? args.clusterSealKeysSource ?? (await resolveTestnetClusterSealKeysSource())
    : undefined;
  const txHash = await submitTransactionWithPrivacy({
    client: rpc,
    backend,
    tx,
    private: privateSubmit,
    clusterId: Number(clusterId),
    clusterSealKeysSource,
    class: MempoolClass.ContractCall,
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
  const rpc = makeRpcClient(args.rpcUrl);
  const clusterId = parseUint32(args.clusterId, "clusterId");
  const operatorIdHex = bytesToHex(hexToBytes(args.operatorIdHex, "operatorId", 32));
  const backend = mnemonicToMlDsa65Backend(args.mnemonic);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());
  const preview = await previewVoteClusterAdmit(rpc, {
    from: senderAddress,
    clusterId,
    operatorIdHex,
    voterPubkeyHex: args.voterPubkeyHex,
  });
  assertPreviewOk("voteClusterAdmit", preview);

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
  // Plaintext by default — CJ-1 admission is public, and a not-yet-member's
  // sealed envelope cannot be decrypted by the cluster (-32047). Opt-in seal.
  const privateSubmit = args.private === true;
  const clusterSealKeysSource = privateSubmit
    ? args.clusterSealKeysSource ?? (await resolveTestnetClusterSealKeysSource())
    : undefined;
  const txHash = await submitTransactionWithPrivacy({
    client: rpc,
    backend,
    tx,
    private: privateSubmit,
    clusterId: Number(clusterId),
    clusterSealKeysSource,
    class: MempoolClass.ContractCall,
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
