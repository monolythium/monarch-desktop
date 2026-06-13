// Foundation recovery operation submission helpers.
//
// `recoverOperatorNode(bytes32)` is the node-registry disaster-recovery
// executor alias for `unjail(bytes32)`. The chain gates this call to the
// configured foundation multisig address, so this helper is only used when a
// foundation operations signer mnemonic is present in the OS keychain.
// Ordinary operator installs fail closed before broadcast.

import {
  addressToTypedBech32,
  nodeRegistryAddressHex,
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT,
} from "@monolythium/core-sdk";
import { makeRpcClient } from "./rpcTransport";
import {
  pqm1MnemonicToMlDsa65Backend,
  submitTransactionWithPrivacy,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { clampPriorityTip, type RegisterFeeQuote } from "./register";

export const RECOVER_OPERATOR_NODE_SELECTOR = "0xe58729e6";
export const DEFAULT_RECOVER_OPERATOR_NODE_EXECUTION_UNIT_LIMIT =
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT;

export interface RecoverOperatorNodeArgs {
  rpcUrl: string;
  foundationMnemonic: string;
  peerIdHex: string;
  executionUnitLimit?: bigint;
}

export interface RecoverOperatorNodeResult {
  txHash: string;
  peerIdHex: string;
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

export function peerIdHexToBytes(peerIdHex: string): Uint8Array {
  const clean = stripHex(peerIdHex.trim());
  if (clean.length !== 64) {
    throw new Error(`peerIdHex: expected 32 bytes, got ${clean.length / 2}`);
  }
  if (!/^[0-9a-fA-F]{64}$/u.test(clean)) {
    throw new Error("peerIdHex: invalid hex");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function encodeRecoverOperatorNodeCalldata(peerIdHex: string): string {
  const selector = stripHex(RECOVER_OPERATOR_NODE_SELECTOR);
  const peerId = stripHex(bytesToHex(peerIdHexToBytes(peerIdHex)));
  return `0x${selector}${peerId}`;
}

export function buildRecoverOperatorNodeTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  peerIdHex: string;
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
    gasLimit:
      args.executionUnitLimit ?? DEFAULT_RECOVER_OPERATOR_NODE_EXECUTION_UNIT_LIMIT,
    to: nodeRegistryAddressHex(),
    value: 0n,
    input: encodeRecoverOperatorNodeCalldata(args.peerIdHex),
  };
}

export async function submitRecoverOperatorNode(
  args: RecoverOperatorNodeArgs,
): Promise<RecoverOperatorNodeResult> {
  const peerId = peerIdHexToBytes(args.peerIdHex);
  const backend = pqm1MnemonicToMlDsa65Backend(args.foundationMnemonic);
  const rpc = makeRpcClient(args.rpcUrl);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());

  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);

  const tx = buildRecoverOperatorNodeTxFields({
    chainId,
    nonce,
    fee,
    peerIdHex: bytesToHex(peerId),
    executionUnitLimit: args.executionUnitLimit,
  });
  const calldataHex = encodeRecoverOperatorNodeCalldata(bytesToHex(peerId));

  const txHash = await submitTransactionWithPrivacy({
    client: rpc,
    backend,
    tx,
    private: false,
  });

  const signed = backend.signEvmTx(tx);
  return {
    txHash,
    peerIdHex: bytesToHex(peerId),
    calldataHex,
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}
