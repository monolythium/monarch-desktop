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
  buildApplyForSeatTxFields as buildSdkApplyForSeatTxFields,
  buildVoteSeatAdmitTxFields as buildSdkVoteSeatAdmitTxFields,
  DEFAULT_SEAT_EXECUTION_UNIT_LIMIT,
  deriveSeatApplicationKey,
  encodeApplyForSeatCalldata,
  encodeVoteSeatAdmitCalldata,
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
