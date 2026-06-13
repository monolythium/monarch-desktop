import {
  addressToTypedBech32,
  PRECOMPILE_ADDRESSES,
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT,
} from "@monolythium/core-sdk";
import { makeRpcClient } from "./rpcTransport";
import {
  pqm1MnemonicToMlDsa65Backend,
  submitTransactionWithPrivacy,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { clampPriorityTip, type RegisterFeeQuote } from "./register";

export const CLUSTER_NAME_REGISTER_SELECTOR = "0x5694cb0a";
export const DEFAULT_CLUSTER_NAME_EXECUTION_UNIT_LIMIT =
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT;
export const CLUSTER_NAME_MIN_BYTES = 3;
export const CLUSTER_NAME_MAX_BYTES = 32;
export const CLUSTER_NAME_BASE_FEE_K_LYTHOSHI = 100_000_000_000_000n;
export const CLUSTER_NAME_RESERVED_NAMES = [
  "admin",
  "foundation",
  "genesis",
  "registry",
  "root",
  "system",
  "treasury",
] as const;

export interface SubmitClusterNameRegistrationArgs {
  rpcUrl: string;
  mnemonic: string;
  clusterId: string | number | bigint;
  name: string;
  executionUnitLimit?: bigint;
}

export interface SubmitClusterNameRegistrationResult {
  txHash: string;
  clusterId: string;
  name: string;
  nameBytes: number;
  feeLythoshi: string;
  calldataHex: string;
  innerSighashHex: string;
  envelopeWireBytes: number;
}

function bytesToHex(b: Uint8Array): string {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(s: string, label: string, expectedLen?: number): Uint8Array {
  const clean = s.trim().replace(/^0x/iu, "");
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

export function parseClusterNameId(value: string | number | bigint): bigint {
  const raw = typeof value === "bigint" ? value.toString() : String(value).trim();
  if (!/^[0-9]+$/u.test(raw)) throw new Error("clusterId: expected uint64");
  const parsed = BigInt(raw);
  if (parsed < 0n || parsed > 0xffff_ffff_ffff_ffffn) {
    throw new Error("clusterId: expected uint64");
  }
  return parsed;
}

export function normalizeClusterName(value: string): {
  name: string;
  bytes: Uint8Array;
} {
  const name = value.trim();
  const bytes = new TextEncoder().encode(name);
  if (bytes.length < CLUSTER_NAME_MIN_BYTES) {
    throw new Error(`name: expected at least ${CLUSTER_NAME_MIN_BYTES} lowercase letters`);
  }
  if (bytes.length > CLUSTER_NAME_MAX_BYTES) {
    throw new Error(`name: exceeds ${CLUSTER_NAME_MAX_BYTES} bytes`);
  }
  if (!/^[a-z]+$/u.test(name)) {
    throw new Error("name: use lowercase ASCII letters only");
  }
  if ((CLUSTER_NAME_RESERVED_NAMES as readonly string[]).includes(name)) {
    throw new Error("name: reserved by protocol policy");
  }
  return { name, bytes };
}

export function clusterNameAnnualFeeLythoshi(name: string): bigint {
  const { bytes } = normalizeClusterName(name);
  const factor = BigInt(CLUSTER_NAME_MAX_BYTES + 1 - bytes.length);
  return CLUSTER_NAME_BASE_FEE_K_LYTHOSHI * factor * factor;
}

export function encodeRegisterClusterNameCalldata(args: {
  name: string;
  clusterId: string | number | bigint;
}): string {
  const { bytes } = normalizeClusterName(args.name);
  const clusterId = parseClusterNameId(args.clusterId);
  const selector = hexToBytes(CLUSTER_NAME_REGISTER_SELECTOR, "selector", 4);
  const paddedName = padTo32(bytes);

  return bytesToHex(
    concat([
      selector,
      u256BE(2n * 32n),
      u256BE(clusterId),
      u256BE(BigInt(bytes.length)),
      paddedName,
    ]),
  );
}

export function buildRegisterClusterNameTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  clusterId: string | number | bigint;
  name: string;
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
    gasLimit: args.executionUnitLimit ?? DEFAULT_CLUSTER_NAME_EXECUTION_UNIT_LIMIT,
    to: PRECOMPILE_ADDRESSES.CLUSTER_NAME_REGISTRY.toLowerCase(),
    value: clusterNameAnnualFeeLythoshi(args.name),
    input: encodeRegisterClusterNameCalldata({
      clusterId: args.clusterId,
      name: args.name,
    }),
  };
}

export async function submitClusterNameRegistration(
  args: SubmitClusterNameRegistrationArgs,
): Promise<SubmitClusterNameRegistrationResult> {
  const normalized = normalizeClusterName(args.name);
  const clusterId = parseClusterNameId(args.clusterId);
  const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
  const rpc = makeRpcClient(args.rpcUrl);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());

  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);

  const tx = buildRegisterClusterNameTxFields({
    chainId,
    nonce,
    fee,
    clusterId,
    name: normalized.name,
    executionUnitLimit: args.executionUnitLimit,
  });
  const calldataHex = tx.input;
  if (typeof calldataHex !== "string") {
    throw new Error("cluster-name register tx input was not hex-encoded");
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
    clusterId: clusterId.toString(),
    name: normalized.name,
    nameBytes: normalized.bytes.length,
    feeLythoshi: tx.value.toString(),
    calldataHex,
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}
