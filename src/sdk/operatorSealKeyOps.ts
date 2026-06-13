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

export const PUBLISH_OPERATOR_SEAL_KEY_SELECTOR = "0x0490b9a8";
export const GET_OPERATOR_SEAL_KEY_SELECTOR = "0xfcbb69a6";
export const OPERATOR_SEAL_EK_BYTES = 1_184;
export const DEFAULT_OPERATOR_SEAL_KEY_EXECUTION_UNIT_LIMIT =
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT;

export interface SubmitOperatorSealKeyArgs {
  rpcUrl: string;
  mnemonic: string;
  peerIdHex: string;
  sealEkHex: string;
  executionUnitLimit?: bigint;
}

export interface SubmitOperatorSealKeyResult {
  txHash: string;
  peerIdHex: string;
  sealEkBytes: number;
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
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  if (expectedLen !== undefined && out.length !== expectedLen) {
    throw new Error(`${label}: expected ${expectedLen} bytes, got ${out.length}`);
  }
  return out;
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

function padTo32(buf: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil(buf.length / 32) * 32;
  if (paddedLength === buf.length) return buf;
  const out = new Uint8Array(paddedLength);
  out.set(buf);
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

export function operatorSealKeyPeerIdHexToBytes(peerIdHex: string): Uint8Array {
  return hexToBytes(peerIdHex, "peerIdHex", 32);
}

export function operatorSealEkHexToBytes(sealEkHex: string): Uint8Array {
  const bytes = hexToBytes(sealEkHex, "sealEkHex", OPERATOR_SEAL_EK_BYTES);
  if (bytes.every((byte) => byte === 0)) {
    throw new Error("sealEkHex: all-zero EK is not allowed");
  }
  return bytes;
}

export function normalizeOperatorSealKey(args: {
  peerIdHex: string;
  sealEkHex: string;
}): {
  peerIdBytes: Uint8Array;
  sealEkBytes: Uint8Array;
} {
  return {
    peerIdBytes: operatorSealKeyPeerIdHexToBytes(args.peerIdHex),
    sealEkBytes: operatorSealEkHexToBytes(args.sealEkHex),
  };
}

export function encodePublishOperatorSealKeyCalldata(args: {
  peerIdHex: string;
  sealEkHex: string;
}): string {
  const { peerIdBytes, sealEkBytes } = normalizeOperatorSealKey(args);
  const selector = hexToBytes(PUBLISH_OPERATOR_SEAL_KEY_SELECTOR, "selector", 4);
  const sealEkPadded = padTo32(sealEkBytes);
  const calldata = concat([
    selector,
    peerIdBytes,
    u256BE(2n * 32n),
    u256BE(sealEkBytes.length),
    sealEkPadded,
  ]);
  if ((calldata.length - 4) % 32 !== 0) {
    throw new Error(`publishOperatorSealKey calldata not 32-aligned (len=${calldata.length - 4})`);
  }
  return bytesToHex(calldata);
}

export function encodeGetOperatorSealKeyCalldata(args: { operatorIdHex: string }): string {
  return bytesToHex(
    concat([
      hexToBytes(GET_OPERATOR_SEAL_KEY_SELECTOR, "selector", 4),
      operatorSealKeyPeerIdHexToBytes(args.operatorIdHex),
    ]),
  );
}

export function buildPublishOperatorSealKeyTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  peerIdHex: string;
  sealEkHex: string;
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
    gasLimit: args.executionUnitLimit ?? DEFAULT_OPERATOR_SEAL_KEY_EXECUTION_UNIT_LIMIT,
    to: nodeRegistryAddressHex(),
    value: 0n,
    input: encodePublishOperatorSealKeyCalldata({
      peerIdHex: args.peerIdHex,
      sealEkHex: args.sealEkHex,
    }),
  };
}

export async function submitOperatorSealKey(
  args: SubmitOperatorSealKeyArgs,
): Promise<SubmitOperatorSealKeyResult> {
  const normalized = normalizeOperatorSealKey(args);
  const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
  const rpc = makeRpcClient(args.rpcUrl);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());

  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);

  const tx = buildPublishOperatorSealKeyTxFields({
    chainId,
    nonce,
    fee,
    peerIdHex: bytesToHex(normalized.peerIdBytes),
    sealEkHex: bytesToHex(normalized.sealEkBytes),
    executionUnitLimit: args.executionUnitLimit,
  });
  const calldataHex = tx.input;
  if (typeof calldataHex !== "string") {
    throw new Error("publishOperatorSealKey tx input was not hex-encoded");
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
    peerIdHex: bytesToHex(normalized.peerIdBytes),
    sealEkBytes: normalized.sealEkBytes.length,
    calldataHex,
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}
