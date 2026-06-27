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

export const SET_OPERATOR_DISPLAY_SELECTOR = "0x7a2ac986";
export const DEFAULT_OPERATOR_DISPLAY_EXECUTION_UNIT_LIMIT =
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT;
export const OPERATOR_MONIKER_MAX_BYTES = 128;
export const OPERATOR_ALIAS_MAX_BYTES = 64;

export interface SubmitOperatorDisplayArgs {
  rpcUrl: string;
  mnemonic: string;
  peerIdHex: string;
  moniker: string;
  alias: string;
  executionUnitLimit?: bigint;
}

export interface SubmitOperatorDisplayResult {
  txHash: string;
  peerIdHex: string;
  monikerBytes: number;
  aliasBytes: number;
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

export function operatorDisplayPeerIdHexToBytes(peerIdHex: string): Uint8Array {
  return hexToBytes(peerIdHex, "peerIdHex", 32);
}

export function normalizeOperatorDisplayField(
  value: string,
  maxBytes: number,
  label: string,
): Uint8Array {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code !== undefined && ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f))) {
      throw new Error(`${label}: control characters are not allowed`);
    }
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > maxBytes) {
    throw new Error(`${label}: exceeds ${maxBytes} UTF-8 bytes`);
  }
  return bytes;
}

export function normalizeOperatorDisplay(args: { moniker: string; alias: string }): {
  monikerBytes: Uint8Array;
  aliasBytes: Uint8Array;
} {
  return {
    monikerBytes: normalizeOperatorDisplayField(
      args.moniker,
      OPERATOR_MONIKER_MAX_BYTES,
      "moniker",
    ),
    aliasBytes: normalizeOperatorDisplayField(args.alias, OPERATOR_ALIAS_MAX_BYTES, "alias"),
  };
}

export function encodeSetOperatorDisplayCalldata(args: {
  peerIdHex: string;
  moniker: string;
  alias: string;
}): string {
  const peerId = operatorDisplayPeerIdHexToBytes(args.peerIdHex);
  const { monikerBytes, aliasBytes } = normalizeOperatorDisplay(args);
  const selector = hexToBytes(SET_OPERATOR_DISPLAY_SELECTOR, "selector", 4);
  const monikerPadded = padTo32(monikerBytes);
  const aliasPadded = padTo32(aliasBytes);
  const monikerOffset = 3n * 32n;
  const aliasOffset = monikerOffset + 32n + BigInt(monikerPadded.length);

  const calldata = concat([
    selector,
    peerId,
    u256BE(monikerOffset),
    u256BE(aliasOffset),
    u256BE(monikerBytes.length),
    monikerPadded,
    u256BE(aliasBytes.length),
    aliasPadded,
  ]);
  if ((calldata.length - 4) % 32 !== 0) {
    throw new Error(`setOperatorDisplay calldata not 32-aligned (len=${calldata.length - 4})`);
  }
  return bytesToHex(calldata);
}

export function buildSetOperatorDisplayTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  peerIdHex: string;
  moniker: string;
  alias: string;
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
    gasLimit: args.executionUnitLimit ?? DEFAULT_OPERATOR_DISPLAY_EXECUTION_UNIT_LIMIT,
    to: nodeRegistryAddressHex(),
    value: 0n,
    input: encodeSetOperatorDisplayCalldata({
      peerIdHex: args.peerIdHex,
      moniker: args.moniker,
      alias: args.alias,
    }),
  };
}

export async function submitOperatorDisplay(
  args: SubmitOperatorDisplayArgs,
): Promise<SubmitOperatorDisplayResult> {
  const peerId = operatorDisplayPeerIdHexToBytes(args.peerIdHex);
  const normalized = normalizeOperatorDisplay(args);
  const backend = mnemonicToMlDsa65Backend(args.mnemonic);
  const rpc = makeRpcClient(args.rpcUrl);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());

  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);

  const tx = buildSetOperatorDisplayTxFields({
    chainId,
    nonce,
    fee,
    peerIdHex: bytesToHex(peerId),
    moniker: args.moniker,
    alias: args.alias,
    executionUnitLimit: args.executionUnitLimit,
  });
  const calldataHex = tx.input;
  if (typeof calldataHex !== "string") {
    throw new Error("setOperatorDisplay tx input was not hex-encoded");
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
    peerIdHex: bytesToHex(peerId),
    monikerBytes: normalized.monikerBytes.length,
    aliasBytes: normalized.aliasBytes.length,
    calldataHex,
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}
