// Node-registry register flow (MD-REG-01).
//
// Encodes `register(bytes32,string,bytes32,uint32,uint32,bytes,bytes,bytes)`
// calldata, derives the ML-DSA-65 consensus key and possession signature
// from the operator PQM-1 mnemonic, signs the inner ML-DSA-65 envelope, and
// submits it through the sealed private native tx path
// (`submitTransactionWithPrivacy({ private: true })` -> `lyth_submitEncrypted`).
//
// Operator-self-signed: the register handler at
// `crates/economics/node-registry/src/ops.rs::register_op_host` does
// NOT gate on foundation-multisig. The caller's address derives from
// their own ML-DSA-65 pubkey; the bond is paid out of the same
// account.

import { addressToTypedBech32, RpcClient } from "@monolythium/core-sdk";
import {
  MempoolClass,
  pqm1MnemonicToMlDsa65Backend,
  submitTransactionWithPrivacy,
} from "@monolythium/core-sdk/crypto";
import type { ClusterSealKeysSource, NativeEvmTxFields } from "@monolythium/core-sdk/crypto";
import { resolveTestnetClusterSealKeysSource } from "./clusterSeal";
import {
  NODE_REGISTRY_CONSENSUS_POP_BYTES,
  NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  operatorPubkeyHash,
  registerPopMessage,
} from "./operatorKeys";

// `keccak256("register(bytes32,string,bytes32,uint32,uint32,bytes,bytes,bytes)")[0..4]`
// — mirrors `crates/economics/node-registry/src/abi.rs::sig::REGISTER`.
const REGISTER_SELECTOR = "f4896df2";

// Node-registry precompile (`crates/economics/node-registry/src/storage.rs`).
const NODE_REGISTRY_ADDRESS_HEX = "0x0000000000000000000000000000000000001005";

// Software-version constant the chain-side `register_op_host` expects
// for `0.1.x` operator builds (mirrors `SOFTWARE_VERSION = 1 << 16`
// in `crates/core/sdk/src/operator.rs`).
const DEFAULT_SOFTWARE_VERSION = 1 << 16;

// Register carries large PQ key/proof payloads and pays the sealed-submit
// intrinsic floor. Mirror the SDK registry default with public-preview
// headroom; callers may override.
export const DEFAULT_REGISTER_EXECUTION_UNIT_LIMIT = 1_000_000n;

// Operator-supplied fields the form collects.
export interface RegisterArgs {
  /** Foundation RPC endpoint, e.g. `https://rpc.monolythium.com`. */
  rpcUrl: string;
  /** PQM-1 mnemonic that signs the register tx. The same mnemonic
   *  funds the bond from the wallet's native balance. */
  mnemonic: string;
  /** Operator's public RPC endpoint advertised in the registry. */
  endpoint: string;
  /** Capability bitmask — OR of `NODE_REGISTRY_CAPABILITIES`. */
  capabilities: number;
  /** Bond in lythoshi (decimal string). Must be ≥ `MIN_BOND_LYTHOSHI`
   *  on a public-profile chain id. */
  bondLythoshi: string;
  /** Optional 32-byte peer id. Defaults to `BLAKE3(consensus_pubkey)`. */
  peerIdHex?: string;
  /** Optional 32-byte SPP-K hash. Zero hash is acceptable on testnet. */
  sppkHashHex?: string;
  /** Optional TPM quote bytes (empty for testnet — TPM verification
   *  is disabled when `tpm.ek_roots` is empty in genesis). */
  tpmQuoteHex?: string;
  /** Optional execution-unit limit override. The default mirrors the SDK
   *  registry write ceiling with public-preview headroom. */
  executionUnitLimit?: bigint;
  /** Optional test escape hatch. Default is sealed private submission because
   *  the public testnet rejects plaintext mempool entries. Set to `false`
   *  only against local chains that still allow `mesh_submitTx`. */
  privatePreview?: boolean;
  /** Optional pre-resolved cluster seal roster. If omitted on testnet, Desktop
   *  resolves it from the pinned chain-registry genesis. */
  clusterSealKeysSource?: ClusterSealKeysSource;
}

export interface RegisterResult {
  txHash: string;
  peerIdHex: string;
  consensusPubkeyHex: string;
  innerSighashHex: string;
  envelopeWireBytes: number;
}

function stripHex(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

function hexToBytes(s: string, label: string, expectedLen?: number): Uint8Array {
  const clean = stripHex(s.trim());
  if (clean.length % 2 !== 0) throw new Error(`${label}: odd hex length`);
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error(`${label}: invalid hex`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  if (expectedLen !== undefined && out.length !== expectedLen) {
    throw new Error(`${label}: expected ${expectedLen} bytes, got ${out.length}`);
  }
  return out;
}

function assertUint32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${label}: expected uint32`);
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
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
  const padded = Math.ceil(buf.length / 32) * 32;
  if (padded === buf.length) return buf;
  const out = new Uint8Array(padded);
  out.set(buf);
  return out;
}

function assertBytesLen(bytes: Uint8Array, label: string, expectedLen: number): void {
  if (bytes.length !== expectedLen) {
    throw new Error(`${label}: expected ${expectedLen} bytes, got ${bytes.length}`);
  }
}

/** ABI-encode the `register(...)` calldata in the layout the chain
 *  decoder (`register_op` in `node-registry/src/ops.rs`) expects.
 *  Mirrors `protocore_sdk::operator::encode_register_calldata`. */
function encodeRegisterCalldata(args: {
  peerId: Uint8Array;
  endpoint: Uint8Array;
  sppkHash: Uint8Array;
  capabilities: number;
  softwareVersion: number;
  tpmQuote: Uint8Array;
  consensusPubkey: Uint8Array;
  consensusPop: Uint8Array;
}): Uint8Array {
  assertUint32(args.capabilities, "capabilities");
  assertUint32(args.softwareVersion, "softwareVersion");

  const HEAD_WORDS = 8n;
  const endpointOffset = HEAD_WORDS * 32n;
  const endpointPadded = BigInt(Math.ceil(args.endpoint.length / 32) * 32);
  const tpmOffset = endpointOffset + 32n + endpointPadded;
  const tpmPadded = BigInt(Math.ceil(args.tpmQuote.length / 32) * 32);
  const consensusPubkeyOffset = tpmOffset + 32n + tpmPadded;
  const consensusPubkeyPadded = BigInt(Math.ceil(args.consensusPubkey.length / 32) * 32);
  const consensusPopOffset = consensusPubkeyOffset + 32n + consensusPubkeyPadded;

  const chunks: Uint8Array[] = [];
  chunks.push(hexToBytes(REGISTER_SELECTOR, "selector", 4));

  // head[0]: peer_id (32 bytes)
  chunks.push(args.peerId);
  // head[1]: endpoint offset
  chunks.push(u256BE(endpointOffset));
  // head[2]: sppk_hash
  chunks.push(args.sppkHash);
  // head[3]: capabilities
  chunks.push(u256BE(args.capabilities));
  // head[4]: software_version
  chunks.push(u256BE(args.softwareVersion));
  // head[5]: tpm_quote offset
  chunks.push(u256BE(tpmOffset));
  // head[6]: consensus_pubkey offset
  chunks.push(u256BE(consensusPubkeyOffset));
  // head[7]: consensus possession proof offset
  chunks.push(u256BE(consensusPopOffset));

  // tails: length-prefix + body padded to 32.
  chunks.push(u256BE(args.endpoint.length));
  chunks.push(padTo32(args.endpoint));
  chunks.push(u256BE(args.tpmQuote.length));
  chunks.push(padTo32(args.tpmQuote));
  chunks.push(u256BE(args.consensusPubkey.length));
  chunks.push(padTo32(args.consensusPubkey));
  chunks.push(u256BE(args.consensusPop.length));
  chunks.push(padTo32(args.consensusPop));

  // Total length sanity check — should be 32-aligned past the selector.
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  if ((total - 4) % 32 !== 0) {
    throw new Error(`register calldata not 32-aligned (len=${total - 4})`);
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Clamp the priority tip so it never exceeds the per-execution-unit
 *  price ceiling the node reports. This mirrors the SDK fee
 *  guard (`priority_tip <= max_execution_unit_price`): a tip above the
 *  cap is wasted, and on some node builds it bounces the tx outright. */
export function clampPriorityTip(tip: bigint, maxPrice: bigint): bigint {
  return tip > maxPrice ? maxPrice : tip;
}

export function deriveOperatorConsensusPubkeyHex(mnemonic: string): string {
  const backend = pqm1MnemonicToMlDsa65Backend(mnemonic);
  const consensusPubkey = backend.publicKey();
  assertBytesLen(consensusPubkey, "consensusPubkey", NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES);
  return bytesToHex(consensusPubkey);
}

/** The on-chain fee quote the register submit uses, as returned by
 *  `lyth_executionUnitPrice` (`ExecutionUnitPriceResponse`). Only the
 *  two fields the fee defaults need are pulled out for the pure builder. */
export interface RegisterFeeQuote {
  /** Per-execution-unit price ceiling (`maxFeePerGas`). */
  executionUnitPriceLythoshi: string;
  /** Node-suggested priority tip (clamped to the ceiling). */
  priorityTipLythoshi: string;
}

/** Pure builder for the register `NativeEvmTxFields` — calldata + SDK
 *  sane fee defaults. Kept side-effect-free so the fee/limit/clamp logic is
 *  unit-testable without a live node. Returns the peer id alongside so the
 *  caller can echo it without re-deriving. */
export function buildRegisterTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  endpoint: string;
  capabilities: number;
  consensusPubkey: Uint8Array;
  consensusPop: Uint8Array;
  bondLythoshi: string;
  peerId: Uint8Array;
  sppkHash: Uint8Array;
  tpmQuote: Uint8Array;
  executionUnitLimit?: bigint;
}): { tx: NativeEvmTxFields; peerId: Uint8Array } {
  const calldata = encodeRegisterCalldata({
    peerId: args.peerId,
    endpoint: new TextEncoder().encode(args.endpoint),
    sppkHash: args.sppkHash,
    capabilities: args.capabilities,
    softwareVersion: DEFAULT_SOFTWARE_VERSION,
    tpmQuote: args.tpmQuote,
    consensusPubkey: args.consensusPubkey,
    consensusPop: args.consensusPop,
  });

  // Sane fee defaults: `maxFeePerGas` is the per-execution-unit
  // price ceiling; the priority tip is clamped to that ceiling so a register
  // tx never carries a tip above what the chain will charge.
  const maxExecutionUnitPrice = BigInt(args.fee.executionUnitPriceLythoshi);
  const suggestedTip = BigInt(args.fee.priorityTipLythoshi);
  const priorityTip = clampPriorityTip(suggestedTip, maxExecutionUnitPrice);

  const tx: NativeEvmTxFields = {
    chainId: args.chainId,
    nonce: args.nonce,
    maxFeePerGas: maxExecutionUnitPrice,
    maxPriorityFeePerGas: priorityTip,
    gasLimit: args.executionUnitLimit ?? DEFAULT_REGISTER_EXECUTION_UNIT_LIMIT,
    to: NODE_REGISTRY_ADDRESS_HEX,
    value: BigInt(args.bondLythoshi),
    input: bytesToHex(calldata),
  };
  return { tx, peerId: args.peerId };
}

export async function submitRegister(args: RegisterArgs): Promise<RegisterResult> {
  const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
  const consensusPubkey = backend.publicKey();
  assertBytesLen(consensusPubkey, "consensusPubkey", NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES);
  const consensusPop = backend.sign(registerPopMessage(consensusPubkey));
  assertBytesLen(consensusPop, "consensusPop", NODE_REGISTRY_CONSENSUS_POP_BYTES);
  const peerId = args.peerIdHex
    ? hexToBytes(args.peerIdHex, "peerId", 32)
    : operatorPubkeyHash(consensusPubkey);
  const sppkHash = args.sppkHashHex
    ? hexToBytes(args.sppkHashHex, "sppkHash", 32)
    : new Uint8Array(32);
  const tpmQuote = args.tpmQuoteHex
    ? hexToBytes(args.tpmQuoteHex, "tpmQuote")
    : new Uint8Array(0);

  const rpc = new RpcClient(args.rpcUrl);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());

  // Typed `lyth_*` reads via the SDK RpcClient. `ethChainId`
  // reuses the eth-compat chain id; `lythGetTransactionCount` is the
  // native sender nonce; `lythExecutionUnitPrice` is the native fee.
  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);

  const { tx } = buildRegisterTxFields({
    chainId,
    nonce,
    fee,
    endpoint: args.endpoint,
    capabilities: args.capabilities,
    consensusPubkey,
    consensusPop,
    bondLythoshi: args.bondLythoshi,
    peerId,
    sppkHash,
    tpmQuote,
    executionUnitLimit: args.executionUnitLimit,
  });

  const privateSubmit = args.privatePreview !== false;
  const clusterSealKeysSource = privateSubmit
    ? args.clusterSealKeysSource ?? (await resolveTestnetClusterSealKeysSource())
    : undefined;

  const txHash = await submitTransactionWithPrivacy({
    client: rpc,
    backend,
    tx,
    private: privateSubmit,
    clusterId: clusterSealKeysSource?.clusterId ?? 0,
    clusterSealKeysSource,
    class: MempoolClass.ContractCall,
  });

  // Recompute the canonical sighash locally for the result surface. The
  // backend's `signEvmTx` is deterministic over the same fields, so this
  // matches what was signed and submitted above.
  const signed = backend.signEvmTx(tx);
  return {
    txHash,
    peerIdHex: bytesToHex(peerId),
    consensusPubkeyHex: bytesToHex(consensusPubkey),
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}
