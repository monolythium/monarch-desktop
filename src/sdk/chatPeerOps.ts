// Operator chat bootstrap metadata submission helpers.
//
// `setChatBootstrapPeers(bytes32,bytes)` stores the bounded libp2p
// bootstrap peer list that Desktop discovers through
// `lyth_getOperatorNetworkMetadata(...).chat.bootstrapPeers`. The call is
// owner-gated by node-registry, so Desktop signs it with the operator
// mnemonic and sends a zero-value plaintext native tx.

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
import { clampPriorityTip, type RegisterFeeQuote } from "./register";

export const SET_CHAT_BOOTSTRAP_PEERS_SELECTOR = "0x360a2942";
export const DEFAULT_CHAT_BOOTSTRAP_PEERS_EXECUTION_UNIT_LIMIT =
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT;
export const CHAT_BOOTSTRAP_PEERS_MAX_BYTES = 256;

export interface SubmitChatBootstrapPeersArgs {
  rpcUrl: string;
  mnemonic: string;
  peerIdHex: string;
  peers: string | readonly string[];
  executionUnitLimit?: bigint;
}

export interface SubmitChatBootstrapPeersResult {
  txHash: string;
  peerIdHex: string;
  peerCount: number;
  peersWire: string;
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

export function peerIdHexToBytes(peerIdHex: string): Uint8Array {
  return hexToBytes(peerIdHex, "peerIdHex", 32);
}

export function parseChatPeerList(peers: string | readonly string[]): string[] {
  const raw = typeof peers === "string" ? peers : peers.join("\n");
  return raw
    .split(/[\s,]+/u)
    .map((peer) => peer.trim())
    .filter(Boolean);
}

export function normalizeChatBootstrapPeers(peers: string | readonly string[]): {
  peers: string[];
  wire: string;
  wireBytes: Uint8Array;
} {
  const normalized = parseChatPeerList(peers);
  if (normalized.length === 0) {
    throw new Error("peers: expected at least one libp2p multiaddr");
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const peer of normalized) {
    if (!isValidChatBootstrapPeer(peer)) {
      throw new Error(`peers: invalid libp2p multiaddr ${peer}`);
    }
    if (!seen.has(peer)) {
      seen.add(peer);
      deduped.push(peer);
    }
  }
  const wire = deduped.join("\n");
  const wireBytes = new TextEncoder().encode(wire);
  if (wireBytes.length > CHAT_BOOTSTRAP_PEERS_MAX_BYTES) {
    throw new Error(
      `peers: serialized list exceeds ${CHAT_BOOTSTRAP_PEERS_MAX_BYTES} bytes`,
    );
  }
  return { peers: deduped, wire, wireBytes };
}

export function isValidChatBootstrapPeer(peer: string): boolean {
  if (!peer.startsWith("/")) return false;
  if (!peer.includes("/p2p/")) return false;
  if (/[\s,]/u.test(peer)) return false;
  if (peer.split("/").filter(Boolean).length < 4) return false;
  for (const ch of peer) {
    const code = ch.charCodeAt(0);
    if (code > 0x7f || code === 0 || (code < 0x20 && ch !== "\n" && ch !== "\t")) {
      return false;
    }
  }
  return true;
}

export function encodeSetChatBootstrapPeersCalldata(args: {
  peerIdHex: string;
  peers: string | readonly string[];
}): string {
  const peerId = peerIdHexToBytes(args.peerIdHex);
  const { wireBytes } = normalizeChatBootstrapPeers(args.peers);
  const selector = hexToBytes(SET_CHAT_BOOTSTRAP_PEERS_SELECTOR, "selector", 4);
  const peersPadded = padTo32(wireBytes);

  const calldata = concat([
    selector,
    peerId,
    u256BE(2n * 32n),
    u256BE(wireBytes.length),
    peersPadded,
  ]);
  if ((calldata.length - 4) % 32 !== 0) {
    throw new Error(`setChatBootstrapPeers calldata not 32-aligned (len=${calldata.length - 4})`);
  }
  return bytesToHex(calldata);
}

export function buildSetChatBootstrapPeersTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  peerIdHex: string;
  peers: string | readonly string[];
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
      args.executionUnitLimit ?? DEFAULT_CHAT_BOOTSTRAP_PEERS_EXECUTION_UNIT_LIMIT,
    to: nodeRegistryAddressHex(),
    value: 0n,
    input: encodeSetChatBootstrapPeersCalldata({
      peerIdHex: args.peerIdHex,
      peers: args.peers,
    }),
  };
}

export async function submitChatBootstrapPeers(
  args: SubmitChatBootstrapPeersArgs,
): Promise<SubmitChatBootstrapPeersResult> {
  const peerId = peerIdHexToBytes(args.peerIdHex);
  const peers = normalizeChatBootstrapPeers(args.peers);
  const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
  const rpc = new RpcClient(args.rpcUrl);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());

  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);

  const tx = buildSetChatBootstrapPeersTxFields({
    chainId,
    nonce,
    fee,
    peerIdHex: bytesToHex(peerId),
    peers: peers.wire,
    executionUnitLimit: args.executionUnitLimit,
  });
  const calldataHex = tx.input;
  if (typeof calldataHex !== "string") {
    throw new Error("setChatBootstrapPeers tx input was not hex-encoded");
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
    peerCount: peers.peers.length,
    peersWire: peers.wire,
    calldataHex,
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}
