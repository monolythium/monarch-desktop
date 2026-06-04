// Delegation operation submission helpers.
//
// This covers the Operations drawer's `redelegate` action with the live
// delegation precompile ABI exported by @monolythium/core-sdk. Like the
// operator-register path, it uses the operator's PQM-1 mnemonic and the
// SDK plaintext native transaction submit path; encrypted inclusion is
// still a later protocol milestone.

import {
  delegationAddressHex,
  encodeRedelegateCalldata,
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT,
  RpcClient,
} from "@monolythium/core-sdk";
import {
  pqm1MnemonicToMlDsa65Backend,
  submitTransactionWithPrivacy,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { clampPriorityTip, type RegisterFeeQuote } from "./register";

export const DEFAULT_REDELEGATE_EXECUTION_UNIT_LIMIT = REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT;

export interface RedelegateArgs {
  rpcUrl: string;
  mnemonic: string;
  fromCluster: number;
  toCluster: number;
  weightBps: number;
  executionUnitLimit?: bigint;
}

export interface RedelegateResult {
  txHash: string;
  innerSighashHex: string;
  envelopeWireBytes: number;
}

function bytesToHex(b: Uint8Array): string {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function assertClusterId(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${label}: expected uint32 cluster id`);
  }
}

function assertWeightBps(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error("weightBps: expected integer 1..10000");
  }
}

function assertRedelegateInput(args: {
  fromCluster: number;
  toCluster: number;
  weightBps: number;
}): void {
  assertClusterId(args.fromCluster, "fromCluster");
  assertClusterId(args.toCluster, "toCluster");
  if (args.fromCluster === args.toCluster) {
    throw new Error("toCluster must differ from fromCluster");
  }
  assertWeightBps(args.weightBps);
}

export function buildRedelegateTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  fromCluster: number;
  toCluster: number;
  weightBps: number;
  executionUnitLimit?: bigint;
}): NativeEvmTxFields {
  assertRedelegateInput(args);

  const maxExecutionUnitPrice = BigInt(args.fee.executionUnitPriceLythoshi);
  const suggestedTip = BigInt(args.fee.priorityTipLythoshi);
  const priorityTip = clampPriorityTip(suggestedTip, maxExecutionUnitPrice);

  return {
    chainId: args.chainId,
    nonce: args.nonce,
    maxFeePerGas: maxExecutionUnitPrice,
    maxPriorityFeePerGas: priorityTip,
    gasLimit: args.executionUnitLimit ?? DEFAULT_REDELEGATE_EXECUTION_UNIT_LIMIT,
    to: delegationAddressHex(),
    value: 0n,
    input: encodeRedelegateCalldata(args.fromCluster, args.toCluster, args.weightBps),
  };
}

export async function submitRedelegate(args: RedelegateArgs): Promise<RedelegateResult> {
  assertRedelegateInput(args);
  const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
  const rpc = new RpcClient(args.rpcUrl);
  const senderHex = bytesToHex(backend.addressBytes());

  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderHex),
    rpc.lythExecutionUnitPrice(),
  ]);

  const tx = buildRedelegateTxFields({
    chainId,
    nonce,
    fee,
    fromCluster: args.fromCluster,
    toCluster: args.toCluster,
    weightBps: args.weightBps,
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
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}
