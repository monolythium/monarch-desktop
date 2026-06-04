// Node-registry register flow (MD-REG-01).
//
// Encodes `register(bytes32,string,bytes32,uint32,uint32,bytes,bytes,bytes)`
// calldata, signs the inner ML-DSA-65 envelope, and submits it through the
// SDK 0.3.11 PLAINTEXT path (`submitTransactionWithPrivacy({ private: false })`
// -> `mesh_submitTx`). Plaintext is the working inclusion path on the live
// optional-encryption testnet (the node runs with
// `encrypted_mempool_required = false`): a plaintext tx confirms.
//
// Threshold-encrypted INCLUSION is NOT live yet (the Ferveo
// threshold-decrypt pipeline is a fast-follow), so the encrypted submit
// route (`private: true` -> `lyth_submitEncrypted`) is a PREVIEW that would
// admit an envelope that never confirms. The operator register flow never
// engages it — `private` defaults to `false` and the form has no toggle.
//
// Operator-self-signed: the register handler at
// `crates/economics/node-registry/src/ops.rs::register_op_host` does
// NOT gate on foundation-multisig. The caller's address derives from
// their own ML-DSA-65 pubkey; the bond is paid out of the same
// account.

import { RpcClient } from "@monolythium/core-sdk";
import {
  pqm1MnemonicToMlDsa65Backend,
  submitTransactionWithPrivacy,
} from "@monolythium/core-sdk/crypto";
import type { NativeEvmTxFields } from "@monolythium/core-sdk/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";

// `keccak256("register(bytes32,string,bytes32,uint32,uint32,bytes,bytes,bytes)")[0..4]`
// — mirrors `crates/economics/node-registry/src/abi.rs::sig::REGISTER`.
const REGISTER_SELECTOR = "f4896df2";

// Node-registry precompile (`crates/economics/node-registry/src/storage.rs`).
const NODE_REGISTRY_ADDRESS_HEX = "0x0000000000000000000000000000000000001005";

// Software-version constant the chain-side `register_op_host` expects
// for `0.1.x` operator builds (mirrors `SOFTWARE_VERSION = 1 << 16`
// in `crates/core/sdk/src/operator.rs`).
const DEFAULT_SOFTWARE_VERSION = 1 << 16;

// Register is a heavy op (peer-id + endpoint + caps + bls-pop slot writes
// plus the bond-escrow transfer). It measures ~151k execution units, so the
// default limit is the SDK 0.3.11 sane register default of 200k — comfortably
// above the metered cost without overpaying. Callers may override.
export const DEFAULT_REGISTER_EXECUTION_UNIT_LIMIT = 200_000n;

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
  /** 48-byte BLS12-381 minPK pubkey, hex-encoded (with or without `0x`). */
  blsPubkeyHex: string;
  /** 96-byte BLS proof-of-possession, hex-encoded. */
  blsPopHex: string;
  /** Bond in lythoshi (decimal string). Must be ≥ `MIN_BOND_LYTHOSHI`
   *  on a public-profile chain id. */
  bondLythoshi: string;
  /** Optional 32-byte peer id. Defaults to `keccak256(blsPubkey)`. */
  peerIdHex?: string;
  /** Optional 32-byte SPP-K hash. Zero hash is acceptable on testnet. */
  sppkHashHex?: string;
  /** Optional TPM quote bytes (empty for testnet — TPM verification
   *  is disabled when `tpm.ek_roots` is empty in genesis). */
  tpmQuoteHex?: string;
  /** Optional execution-unit limit override. Register measures ~151k;
   *  the default of 200k covers it. */
  executionUnitLimit?: bigint;
  /** PREVIEW ONLY — default `false` (plaintext). Threshold-encrypted
   *  INCLUSION is not live yet, so `true` would build an encrypted
   *  envelope that the node admits but never confirms. The operator
   *  register flow leaves this `false`; it exists only so the encrypted
   *  path can be smoke-tested once the threshold pipeline ships. */
  privatePreview?: boolean;
}

export interface RegisterResult {
  txHash: string;
  peerIdHex: string;
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
  blsPubkey: Uint8Array;
  blsPop: Uint8Array;
}): Uint8Array {
  assertUint32(args.capabilities, "capabilities");
  assertUint32(args.softwareVersion, "softwareVersion");

  const HEAD_WORDS = 8n;
  const endpointOffset = HEAD_WORDS * 32n;
  const endpointPadded = BigInt(Math.ceil(args.endpoint.length / 32) * 32);
  const tpmOffset = endpointOffset + 32n + endpointPadded;
  const tpmPadded = BigInt(Math.ceil(args.tpmQuote.length / 32) * 32);
  const blsPubkeyOffset = tpmOffset + 32n + tpmPadded;
  const blsPubkeyPadded = BigInt(Math.ceil(args.blsPubkey.length / 32) * 32);
  const blsPopOffset = blsPubkeyOffset + 32n + blsPubkeyPadded;

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
  // head[6]: bls_pubkey offset
  chunks.push(u256BE(blsPubkeyOffset));
  // head[7]: bls_pop offset
  chunks.push(u256BE(blsPopOffset));

  // tails: length-prefix + body padded to 32.
  chunks.push(u256BE(args.endpoint.length));
  chunks.push(padTo32(args.endpoint));
  chunks.push(u256BE(args.tpmQuote.length));
  chunks.push(padTo32(args.tpmQuote));
  chunks.push(u256BE(args.blsPubkey.length));
  chunks.push(padTo32(args.blsPubkey));
  chunks.push(u256BE(args.blsPop.length));
  chunks.push(padTo32(args.blsPop));

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

function keccak256(input: Uint8Array): Uint8Array {
  // Use @noble/hashes directly. The SDK already statically imports this
  // package for its PQM-1 / ML-DSA derivation; the direct dep keeps tsc
  // + the bundler resolving the import unambiguously (and in one chunk).
  return keccak_256(input);
}

/** Clamp the priority tip so it never exceeds the per-execution-unit
 *  price ceiling the node reports. This mirrors the SDK 0.3.11 fee
 *  guard (`priority_tip <= max_execution_unit_price`): a tip above the
 *  cap is wasted, and on some node builds it bounces the tx outright. */
export function clampPriorityTip(tip: bigint, maxPrice: bigint): bigint {
  return tip > maxPrice ? maxPrice : tip;
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

/** Pure builder for the register `NativeEvmTxFields` — calldata + SDK 0.3.11
 *  sane fee defaults. Kept side-effect-free so the fee/limit/clamp logic is
 *  unit-testable without a live node. Returns the peer id alongside so the
 *  caller can echo it without re-deriving. */
export function buildRegisterTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  endpoint: string;
  capabilities: number;
  blsPubkey: Uint8Array;
  blsPop: Uint8Array;
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
    blsPubkey: args.blsPubkey,
    blsPop: args.blsPop,
  });

  // Sane fee defaults (SDK 0.3.11): `maxFeePerGas` is the per-execution-unit
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
  const blsPubkey = hexToBytes(args.blsPubkeyHex, "blsPubkey", 48);
  const blsPop = hexToBytes(args.blsPopHex, "blsPop", 96);
  const peerId = args.peerIdHex
    ? hexToBytes(args.peerIdHex, "peerId", 32)
    : keccak256(blsPubkey);
  const sppkHash = args.sppkHashHex
    ? hexToBytes(args.sppkHashHex, "sppkHash", 32)
    : new Uint8Array(32);
  const tpmQuote = args.tpmQuoteHex
    ? hexToBytes(args.tpmQuoteHex, "tpmQuote")
    : new Uint8Array(0);

  const rpc = new RpcClient(args.rpcUrl);
  const senderHex = bytesToHex(backend.addressBytes());

  // Typed `lyth_*` reads via the SDK 0.3.11 RpcClient. `ethChainId`
  // reuses the eth-compat chain id; `lythGetTransactionCount` is the
  // native sender nonce; `lythExecutionUnitPrice` is the native fee.
  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderHex),
    rpc.lythExecutionUnitPrice(),
  ]);

  const { tx } = buildRegisterTxFields({
    chainId,
    nonce,
    fee,
    endpoint: args.endpoint,
    capabilities: args.capabilities,
    blsPubkey,
    blsPop,
    bondLythoshi: args.bondLythoshi,
    peerId,
    sppkHash,
    tpmQuote,
    executionUnitLimit: args.executionUnitLimit,
  });

  // DEFAULT PLAINTEXT (`private: false`) -> `mesh_submitTx`, the working
  // inclusion path. The returned hash is the node-echoed-and-validated
  // canonical native tx hash. `privatePreview` is never set by the
  // operator register flow (threshold-encrypted inclusion is a fast-follow).
  const txHash = await submitTransactionWithPrivacy({
    client: rpc,
    backend,
    tx,
    private: args.privatePreview === true,
  });

  // Recompute the canonical sighash locally for the result surface. The
  // backend's `signEvmTx` is deterministic over the same fields, so this
  // matches what was signed and submitted above.
  const signed = backend.signEvmTx(tx);
  return {
    txHash,
    peerIdHex: bytesToHex(peerId),
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}
