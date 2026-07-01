// L6 open-seat marketplace transaction helpers.
//
// Wraps the published SDK seat encoders/builders into the same mnemonic ->
// backend -> build -> sign -> submit shape Desktop already uses for the CJ-1
// cluster-join ops (`clusterJoinOps.ts`). A cluster advertises a vacancy
// (`advertiseSeat`), an operator applies by escrowing the full self-bond
// (`applyForSeat`, payable), and active members vote 7-of-10 to admit
// (`voteSeatAdmit`). Admission terminates in the pre-existing signed-consent
// path — these helpers add discovery + intent, no new consensus surface.
//
// IMPORTANT economic note: `applyForSeat` escrows the FULL operator self-bond
// up front — `max(min_self_bond_floor, seat.minBond)`, defaulting to the
// 5,000 LYTH floor — and rejects an under-funded applicant on chain
// (`SeatBondTooLow`). The escrow is refundable if the applicant withdraws
// before admission; on admission the chain simply retains the already-escrowed
// bond. There is no separate 100-LYTH application escrow (that pre-audit
// behaviour was removed in node-registry audit fix #150/#153).

import {
  addressToTypedBech32,
  buildAdvertiseSeatTxFields as buildSdkAdvertiseSeatTxFields,
  buildApplyForSeatTxFields as buildSdkApplyForSeatTxFields,
  buildCloseSeatTxFields as buildSdkCloseSeatTxFields,
  buildVoteSeatAdmitTxFields as buildSdkVoteSeatAdmitTxFields,
  buildWithdrawSeatApplicationTxFields as buildSdkWithdrawSeatApplicationTxFields,
  DEFAULT_SEAT_EXECUTION_UNIT_LIMIT,
  deriveSeatApplicationKey,
  encodeAdvertiseSeatCalldata,
  encodeApplyForSeatCalldata,
  encodeCloseSeatCalldata,
  encodeVoteSeatAdmitCalldata,
  encodeWithdrawSeatApplicationCalldata,
  NODE_REGISTRY_MIN_SELF_BOND_LYTHOSHI,
  NODE_REGISTRY_SEAT_KIND_ACTIVE,
  NODE_REGISTRY_SEAT_KIND_STANDBY,
  resolveSeatExecutionFee,
  SEAT_KINDS,
  seatKindToByte,
  type ExecutionUnitPriceResponse,
  type SeatKind,
} from "@monolythium/core-sdk";
import {
  mnemonicToMlDsa65Backend,
  submitTransaction,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { makeRpcClient } from "./rpcTransport";

export {
  DEFAULT_SEAT_EXECUTION_UNIT_LIMIT,
  NODE_REGISTRY_MIN_SELF_BOND_LYTHOSHI,
  NODE_REGISTRY_SEAT_KIND_ACTIVE,
  NODE_REGISTRY_SEAT_KIND_STANDBY,
  SEAT_KINDS,
  seatKindToByte,
};
export type { SeatKind };

const MAX_UINT32 = (1n << 32n) - 1n;

export interface ApplyForSeatCalldataArgs {
  clusterId: bigint | number | string;
  seatId: bigint | number | string;
  operatorPubkeyHex: string;
}

export interface VoteSeatAdmitCalldataArgs {
  clusterId: bigint | number | string;
  appKeyHex: string;
  voterPubkeyHex: string;
}

export interface SubmitApplyForSeatArgs {
  rpcUrl: string;
  mnemonic: string;
  clusterId: bigint | number | string;
  seatId: bigint | number | string;
  operatorPubkeyHex: string;
  /**
   * Self-bond to escrow at apply, in lythoshi. Defaults to the operator
   * self-bond floor (5,000 LYTH). The chain requires
   * `max(min_self_bond_floor, seat.minBond)`, so when the targeted seat's
   * advertised `minBond` exceeds the floor, pass that larger amount here or
   * the application reverts (`SeatBondTooLow`).
   */
  selfBondLythoshi?: bigint | number | string;
  executionUnitLimit?: bigint;
}

export interface SubmitVoteSeatAdmitArgs {
  rpcUrl: string;
  mnemonic: string;
  clusterId: bigint | number | string;
  appKeyHex: string;
  voterPubkeyHex: string;
  executionUnitLimit?: bigint;
}

export interface SeatSubmitResult {
  txHash: string;
  clusterId: string;
  appKeyHex: string;
  innerSighashHex: string;
  envelopeWireBytes: number;
}

export interface ApplyForSeatSubmitResult extends SeatSubmitResult {
  seatId: string;
  selfBondLythoshi: string;
}

function stripHex(value: string): string {
  return value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
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
  if (parsed < 0n || parsed > MAX_UINT32) throw new Error(`${label}: out of uint32 range`);
  return parsed;
}

export function deriveSeatApplicationKeyHex(operatorPubkeyHex: string): string {
  return deriveSeatApplicationKey(operatorPubkeyHex);
}

export function encodeApplyForSeatCalldataHex(args: ApplyForSeatCalldataArgs): string {
  return encodeApplyForSeatCalldata({
    clusterId: args.clusterId,
    seatId: args.seatId,
    operatorPubkey: args.operatorPubkeyHex,
  });
}

export function encodeVoteSeatAdmitCalldataHex(args: VoteSeatAdmitCalldataArgs): string {
  return encodeVoteSeatAdmitCalldata({
    clusterId: args.clusterId,
    appKey: args.appKeyHex,
    voterPubkey: args.voterPubkeyHex,
  });
}

export function buildApplyForSeatTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: ExecutionUnitPriceResponse;
  clusterId: bigint | number | string;
  seatId: bigint | number | string;
  operatorPubkeyHex: string;
  selfBondLythoshi?: bigint | number | string;
  executionUnitLimit?: bigint;
}): NativeEvmTxFields {
  return buildSdkApplyForSeatTxFields({
    chainId: args.chainId,
    nonce: args.nonce,
    fee: resolveSeatExecutionFee(args.fee, {
      executionUnitLimit: args.executionUnitLimit ?? DEFAULT_SEAT_EXECUTION_UNIT_LIMIT,
    }),
    clusterId: args.clusterId,
    seatId: args.seatId,
    operatorPubkey: args.operatorPubkeyHex,
    selfBondLythoshi: args.selfBondLythoshi,
  });
}

export function buildVoteSeatAdmitTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: ExecutionUnitPriceResponse;
  clusterId: bigint | number | string;
  appKeyHex: string;
  voterPubkeyHex: string;
  executionUnitLimit?: bigint;
}): NativeEvmTxFields {
  return buildSdkVoteSeatAdmitTxFields({
    chainId: args.chainId,
    nonce: args.nonce,
    fee: resolveSeatExecutionFee(args.fee, {
      executionUnitLimit: args.executionUnitLimit ?? DEFAULT_SEAT_EXECUTION_UNIT_LIMIT,
    }),
    clusterId: args.clusterId,
    appKey: args.appKeyHex,
    voterPubkey: args.voterPubkeyHex,
  });
}

export async function submitApplyForSeat(
  args: SubmitApplyForSeatArgs,
): Promise<ApplyForSeatSubmitResult> {
  const rpc = makeRpcClient(args.rpcUrl);
  const clusterId = parseUint32(args.clusterId, "clusterId");
  const seatId = parseUint32(args.seatId, "seatId");
  const appKeyHex = deriveSeatApplicationKeyHex(args.operatorPubkeyHex);
  const selfBondLythoshi = args.selfBondLythoshi ?? NODE_REGISTRY_MIN_SELF_BOND_LYTHOSHI;
  const backend = mnemonicToMlDsa65Backend(args.mnemonic);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());

  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);
  const tx = buildApplyForSeatTxFields({
    chainId,
    nonce,
    fee,
    clusterId,
    seatId,
    operatorPubkeyHex: args.operatorPubkeyHex,
    selfBondLythoshi,
    executionUnitLimit: args.executionUnitLimit,
  });
  // v2 runs a plaintext mempool — the seat application is a public action,
  // signed and submitted in the clear (the LythiumSeal encrypted mempool was
  // removed at the v2 re-genesis, DEC-029).
  const txHash = await submitTransaction({ client: rpc, backend, tx });
  const signed = backend.signEvmTx(tx);
  return {
    txHash,
    clusterId: clusterId.toString(),
    seatId: seatId.toString(),
    appKeyHex,
    selfBondLythoshi: BigInt(selfBondLythoshi).toString(),
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}

// ---- advertiseSeat / withdrawSeatApplication / closeSeat -------------
//
// The three remaining L6 selectors, wrapped in the same
// mnemonic -> backend -> build -> sign -> submit shape. A cluster member
// advertises a vacancy (`advertiseSeat`, non-payable), an applicant rescinds
// a pending application and reclaims the escrowed self-bond
// (`withdrawSeatApplication`, non-payable), and an advertiser closes a stale
// listing (`closeSeat`, non-payable). None move native value: apply is the
// only payable selector; withdraw refunds the already-escrowed bond on chain.

export interface AdvertiseSeatCalldataArgs {
  clusterId: bigint | number | string;
  kind: SeatKind | number;
  seatCount: bigint | number | string;
  minBondLythoshi: bigint | number | string;
  capabilityMask: number;
  termsHashHex: string;
}

export interface WithdrawSeatApplicationCalldataArgs {
  clusterId: bigint | number | string;
  appKeyHex: string;
}

export interface CloseSeatCalldataArgs {
  clusterId: bigint | number | string;
  seatId: bigint | number | string;
}

export interface SubmitAdvertiseSeatArgs {
  rpcUrl: string;
  mnemonic: string;
  clusterId: bigint | number | string;
  kind: SeatKind | number;
  seatCount: bigint | number | string;
  minBondLythoshi: bigint | number | string;
  capabilityMask: number;
  termsHashHex: string;
  executionUnitLimit?: bigint;
}

export interface SubmitWithdrawSeatApplicationArgs {
  rpcUrl: string;
  mnemonic: string;
  clusterId: bigint | number | string;
  appKeyHex: string;
  executionUnitLimit?: bigint;
}

export interface SubmitCloseSeatArgs {
  rpcUrl: string;
  mnemonic: string;
  clusterId: bigint | number | string;
  seatId: bigint | number | string;
  executionUnitLimit?: bigint;
}

export interface AdvertiseSeatSubmitResult {
  txHash: string;
  clusterId: string;
  seatCount: string;
  minBondLythoshi: string;
  innerSighashHex: string;
  envelopeWireBytes: number;
}

export interface WithdrawSeatApplicationSubmitResult {
  txHash: string;
  clusterId: string;
  appKeyHex: string;
  innerSighashHex: string;
  envelopeWireBytes: number;
}

export interface CloseSeatSubmitResult {
  txHash: string;
  clusterId: string;
  seatId: string;
  innerSighashHex: string;
  envelopeWireBytes: number;
}

export function encodeAdvertiseSeatCalldataHex(args: AdvertiseSeatCalldataArgs): string {
  return encodeAdvertiseSeatCalldata({
    clusterId: args.clusterId,
    kind: args.kind,
    seatCount: args.seatCount,
    minBondLythoshi: args.minBondLythoshi,
    capabilityMask: args.capabilityMask,
    termsHash: args.termsHashHex,
  });
}

export function encodeWithdrawSeatApplicationCalldataHex(
  args: WithdrawSeatApplicationCalldataArgs,
): string {
  return encodeWithdrawSeatApplicationCalldata({
    clusterId: args.clusterId,
    appKey: args.appKeyHex,
  });
}

export function encodeCloseSeatCalldataHex(args: CloseSeatCalldataArgs): string {
  return encodeCloseSeatCalldata({ clusterId: args.clusterId, seatId: args.seatId });
}

export function buildAdvertiseSeatTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: ExecutionUnitPriceResponse;
  clusterId: bigint | number | string;
  kind: SeatKind | number;
  seatCount: bigint | number | string;
  minBondLythoshi: bigint | number | string;
  capabilityMask: number;
  termsHashHex: string;
  executionUnitLimit?: bigint;
}): NativeEvmTxFields {
  return buildSdkAdvertiseSeatTxFields({
    chainId: args.chainId,
    nonce: args.nonce,
    fee: resolveSeatExecutionFee(args.fee, {
      executionUnitLimit: args.executionUnitLimit ?? DEFAULT_SEAT_EXECUTION_UNIT_LIMIT,
    }),
    clusterId: args.clusterId,
    kind: args.kind,
    seatCount: args.seatCount,
    minBondLythoshi: args.minBondLythoshi,
    capabilityMask: args.capabilityMask,
    termsHash: args.termsHashHex,
  });
}

export function buildWithdrawSeatApplicationTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: ExecutionUnitPriceResponse;
  clusterId: bigint | number | string;
  appKeyHex: string;
  executionUnitLimit?: bigint;
}): NativeEvmTxFields {
  return buildSdkWithdrawSeatApplicationTxFields({
    chainId: args.chainId,
    nonce: args.nonce,
    fee: resolveSeatExecutionFee(args.fee, {
      executionUnitLimit: args.executionUnitLimit ?? DEFAULT_SEAT_EXECUTION_UNIT_LIMIT,
    }),
    clusterId: args.clusterId,
    appKey: args.appKeyHex,
  });
}

export function buildCloseSeatTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: ExecutionUnitPriceResponse;
  clusterId: bigint | number | string;
  seatId: bigint | number | string;
  executionUnitLimit?: bigint;
}): NativeEvmTxFields {
  return buildSdkCloseSeatTxFields({
    chainId: args.chainId,
    nonce: args.nonce,
    fee: resolveSeatExecutionFee(args.fee, {
      executionUnitLimit: args.executionUnitLimit ?? DEFAULT_SEAT_EXECUTION_UNIT_LIMIT,
    }),
    clusterId: args.clusterId,
    seatId: args.seatId,
  });
}

export async function submitAdvertiseSeat(
  args: SubmitAdvertiseSeatArgs,
): Promise<AdvertiseSeatSubmitResult> {
  const rpc = makeRpcClient(args.rpcUrl);
  const clusterId = parseUint32(args.clusterId, "clusterId");
  const seatCount = parseUint32(args.seatCount, "seatCount");
  const termsHashHex = bytesToHex(hexToBytes(args.termsHashHex, "termsHash", 32));
  const backend = mnemonicToMlDsa65Backend(args.mnemonic);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());

  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);
  const tx = buildAdvertiseSeatTxFields({
    chainId,
    nonce,
    fee,
    clusterId,
    kind: args.kind,
    seatCount,
    minBondLythoshi: args.minBondLythoshi,
    capabilityMask: args.capabilityMask,
    termsHashHex,
    executionUnitLimit: args.executionUnitLimit,
  });
  const txHash = await submitTransaction({ client: rpc, backend, tx });
  const signed = backend.signEvmTx(tx);
  return {
    txHash,
    clusterId: clusterId.toString(),
    seatCount: seatCount.toString(),
    minBondLythoshi: BigInt(args.minBondLythoshi).toString(),
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}

export async function submitWithdrawSeatApplication(
  args: SubmitWithdrawSeatApplicationArgs,
): Promise<WithdrawSeatApplicationSubmitResult> {
  const rpc = makeRpcClient(args.rpcUrl);
  const clusterId = parseUint32(args.clusterId, "clusterId");
  const appKeyHex = bytesToHex(hexToBytes(args.appKeyHex, "appKey", 32));
  const backend = mnemonicToMlDsa65Backend(args.mnemonic);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());

  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);
  const tx = buildWithdrawSeatApplicationTxFields({
    chainId,
    nonce,
    fee,
    clusterId,
    appKeyHex,
    executionUnitLimit: args.executionUnitLimit,
  });
  const txHash = await submitTransaction({ client: rpc, backend, tx });
  const signed = backend.signEvmTx(tx);
  return {
    txHash,
    clusterId: clusterId.toString(),
    appKeyHex,
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}

export async function submitCloseSeat(args: SubmitCloseSeatArgs): Promise<CloseSeatSubmitResult> {
  const rpc = makeRpcClient(args.rpcUrl);
  const clusterId = parseUint32(args.clusterId, "clusterId");
  const seatId = parseUint32(args.seatId, "seatId");
  const backend = mnemonicToMlDsa65Backend(args.mnemonic);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());

  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);
  const tx = buildCloseSeatTxFields({
    chainId,
    nonce,
    fee,
    clusterId,
    seatId,
    executionUnitLimit: args.executionUnitLimit,
  });
  const txHash = await submitTransaction({ client: rpc, backend, tx });
  const signed = backend.signEvmTx(tx);
  return {
    txHash,
    clusterId: clusterId.toString(),
    seatId: seatId.toString(),
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}

export async function submitVoteSeatAdmit(
  args: SubmitVoteSeatAdmitArgs,
): Promise<SeatSubmitResult> {
  const rpc = makeRpcClient(args.rpcUrl);
  const clusterId = parseUint32(args.clusterId, "clusterId");
  const appKeyHex = bytesToHex(hexToBytes(args.appKeyHex, "appKey", 32));
  const backend = mnemonicToMlDsa65Backend(args.mnemonic);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());

  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);
  const tx = buildVoteSeatAdmitTxFields({
    chainId,
    nonce,
    fee,
    clusterId,
    appKeyHex,
    voterPubkeyHex: args.voterPubkeyHex,
    executionUnitLimit: args.executionUnitLimit,
  });
  const txHash = await submitTransaction({ client: rpc, backend, tx });
  const signed = backend.signEvmTx(tx);
  return {
    txHash,
    clusterId: clusterId.toString(),
    appKeyHex,
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}
