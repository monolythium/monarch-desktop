// No-foundation cluster formation helpers.
//
// `formCluster(bytes,bytes,bytes)` forms the standard 7-active +
// 3-standby topology. The calldata carries the active pubkeys, standby
// pubkeys, and ten ML-DSA-65 consent signatures in roster order.

import { blake3 } from "@noble/hashes/blake3.js";
import {
  addressToTypedBech32,
  nodeRegistryAddressHex,
  RpcClient,
} from "@monolythium/core-sdk";
import {
  pqm1MnemonicToMlDsa65Backend,
  submitTransactionWithPrivacy,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { clampPriorityTip, type RegisterFeeQuote } from "./register";
import { NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES } from "./operatorKeys";

export const FORM_CLUSTER_SELECTOR = "0x961a4ced";
export const FORM_CLUSTER_ACTIVE_COUNT = 7;
export const FORM_CLUSTER_STANDBY_COUNT = 3;
export const FORM_CLUSTER_MEMBER_COUNT = FORM_CLUSTER_ACTIVE_COUNT + FORM_CLUSTER_STANDBY_COUNT;
export const FORM_CLUSTER_THRESHOLD = 7;
export const FORM_CLUSTER_SIGNATURE_BYTES = 3309;
export const FORM_CLUSTER_CONSENT_MESSAGE_DOMAIN =
  "PROTOCORE_NODE_REGISTRY_CLUSTER_FORM_V1\0";
export const DEFAULT_FORM_CLUSTER_EXECUTION_UNIT_LIMIT = 1_900_000n;

const MAX_UINT32 = (1n << 32n) - 1n;

export interface FormClusterCalldataArgs {
  activePubkeysHex: string;
  standbyPubkeysHex: string;
  signaturesHex: string;
}

export interface SubmitFormClusterArgs extends FormClusterCalldataArgs {
  rpcUrl: string;
  mnemonic: string;
  executionUnitLimit?: bigint;
}

export interface SubmitFormClusterResult {
  txHash: string;
  activeCount: number;
  standbyCount: number;
  signatureCount: number;
  calldataHex: string;
  consentMessageHex: string;
  innerSighashHex: string;
  envelopeWireBytes: number;
}

export interface FormClusterPreview {
  schemaVersion: number;
  capability: string;
  method: "formCluster" | string;
  ok: boolean;
  status: "ok" | "rejected" | string;
  reason?: string | null;
  message?: string | null;
  clusterId?: number;
  operatorId?: string;
  details?: Record<string, unknown>;
}

export type FormClusterReadClient = {
  call<T>(method: string, params?: unknown): Promise<T>;
};

function stripHex(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
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

function parseHexList(value: string, label: string, itemBytes: number): Uint8Array[] {
  const items = value
    .split(/[\s,]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return items.map((part, index) => hexToBytes(part, `${label}[${index}]`, itemBytes));
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

function padTo32(bytes: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil(bytes.length / 32) * 32;
  if (paddedLength === bytes.length) return bytes;
  const out = new Uint8Array(paddedLength);
  out.set(bytes);
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

function u32BE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > Number(MAX_UINT32)) {
    throw new Error("uint32 out of range");
  }
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function u16BE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error("uint16 out of range");
  }
  return Uint8Array.from([(value >>> 8) & 0xff, value & 0xff]);
}

function parseRoster(args: Pick<FormClusterCalldataArgs, "activePubkeysHex" | "standbyPubkeysHex">) {
  const activePubkeys = parseHexList(
    args.activePubkeysHex,
    "activePubkeys",
    NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  );
  const standbyPubkeys = parseHexList(
    args.standbyPubkeysHex,
    "standbyPubkeys",
    NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  );
  if (activePubkeys.length !== FORM_CLUSTER_ACTIVE_COUNT) {
    throw new Error(`activePubkeys: expected ${FORM_CLUSTER_ACTIVE_COUNT} pubkeys`);
  }
  if (standbyPubkeys.length !== FORM_CLUSTER_STANDBY_COUNT) {
    throw new Error(`standbyPubkeys: expected ${FORM_CLUSTER_STANDBY_COUNT} pubkeys`);
  }

  const seen = new Set<string>();
  for (const [index, pubkey] of [...activePubkeys, ...standbyPubkeys].entries()) {
    const hex = bytesToHex(pubkey);
    if (seen.has(hex)) throw new Error(`roster: duplicate pubkey at position ${index}`);
    seen.add(hex);
  }
  return {
    activePubkeys,
    standbyPubkeys,
    activePubkeysBytes: concat(activePubkeys),
    standbyPubkeysBytes: concat(standbyPubkeys),
  };
}

function previewError(preview: FormClusterPreview): Error {
  const reason = preview.reason ? `: ${preview.reason}` : "";
  const message = preview.message ? ` (${preview.message})` : "";
  return new Error(`formCluster preview rejected${reason}${message}`);
}

function assertPreviewOk(preview: FormClusterPreview): void {
  if (!preview.ok) throw previewError(preview);
}

export function formClusterConsentMessage(args: {
  activePubkeysHex: string;
  standbyPubkeysHex: string;
}): Uint8Array {
  const roster = parseRoster(args);
  return blake3(concat([
    new TextEncoder().encode(FORM_CLUSTER_CONSENT_MESSAGE_DOMAIN),
    u16BE(FORM_CLUSTER_ACTIVE_COUNT),
    u16BE(FORM_CLUSTER_STANDBY_COUNT),
    u16BE(FORM_CLUSTER_THRESHOLD),
    u32BE(roster.activePubkeysBytes.length),
    roster.activePubkeysBytes,
    u32BE(roster.standbyPubkeysBytes.length),
    roster.standbyPubkeysBytes,
  ]));
}

export function formClusterConsentMessageHex(args: {
  activePubkeysHex: string;
  standbyPubkeysHex: string;
}): string {
  return bytesToHex(formClusterConsentMessage(args));
}

export function signFormClusterConsent(args: {
  mnemonic: string;
  activePubkeysHex: string;
  standbyPubkeysHex: string;
}): string {
  const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
  const signature = backend.sign(formClusterConsentMessage(args));
  return bytesToHex(signature);
}

export function encodeFormClusterCalldata(args: FormClusterCalldataArgs): string {
  const roster = parseRoster(args);
  const signatures = parseHexList(args.signaturesHex, "signatures", FORM_CLUSTER_SIGNATURE_BYTES);
  if (signatures.length !== FORM_CLUSTER_MEMBER_COUNT) {
    throw new Error(`signatures: expected ${FORM_CLUSTER_MEMBER_COUNT} signatures`);
  }

  const activePadded = padTo32(roster.activePubkeysBytes);
  const standbyPadded = padTo32(roster.standbyPubkeysBytes);
  const signatureBytes = concat(signatures);
  const signaturesPadded = padTo32(signatureBytes);
  const activeOffset = 3n * 32n;
  const standbyOffset = activeOffset + 32n + BigInt(activePadded.length);
  const signaturesOffset = standbyOffset + 32n + BigInt(standbyPadded.length);

  return bytesToHex(concat([
    hexToBytes(FORM_CLUSTER_SELECTOR, "selector", 4),
    u256BE(activeOffset),
    u256BE(standbyOffset),
    u256BE(signaturesOffset),
    u256BE(roster.activePubkeysBytes.length),
    activePadded,
    u256BE(roster.standbyPubkeysBytes.length),
    standbyPadded,
    u256BE(signatureBytes.length),
    signaturesPadded,
  ]));
}

export function buildFormClusterTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  activePubkeysHex: string;
  standbyPubkeysHex: string;
  signaturesHex: string;
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
    gasLimit: args.executionUnitLimit ?? DEFAULT_FORM_CLUSTER_EXECUTION_UNIT_LIMIT,
    to: nodeRegistryAddressHex(),
    value: 0n,
    input: encodeFormClusterCalldata({
      activePubkeysHex: args.activePubkeysHex,
      standbyPubkeysHex: args.standbyPubkeysHex,
      signaturesHex: args.signaturesHex,
    }),
  };
}

export async function previewFormCluster(
  client: FormClusterReadClient,
  args: FormClusterCalldataArgs & { from: string },
): Promise<FormClusterPreview> {
  const roster = parseRoster(args);
  const signatures = parseHexList(args.signaturesHex, "signatures", FORM_CLUSTER_SIGNATURE_BYTES);
  if (signatures.length !== FORM_CLUSTER_MEMBER_COUNT) {
    throw new Error(`signatures: expected ${FORM_CLUSTER_MEMBER_COUNT} signatures`);
  }
  try {
    return await client.call<FormClusterPreview>("lyth_previewFormCluster", [{
      from: args.from,
      activePubkeys: roster.activePubkeys.map(bytesToHex),
      standbyPubkeys: roster.standbyPubkeys.map(bytesToHex),
      signatures: signatures.map(bytesToHex),
    }]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`formCluster preview is not exposed or failed on the connected chain: ${message}`);
  }
}

export async function submitFormCluster(
  args: SubmitFormClusterArgs,
): Promise<SubmitFormClusterResult> {
  const roster = parseRoster(args);
  const signatures = parseHexList(args.signaturesHex, "signatures", FORM_CLUSTER_SIGNATURE_BYTES);
  if (signatures.length !== FORM_CLUSTER_MEMBER_COUNT) {
    throw new Error(`signatures: expected ${FORM_CLUSTER_MEMBER_COUNT} signatures`);
  }

  const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
  const rpc = new RpcClient(args.rpcUrl);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());
  const preview = await previewFormCluster(rpc, {
    from: senderAddress,
    activePubkeysHex: args.activePubkeysHex,
    standbyPubkeysHex: args.standbyPubkeysHex,
    signaturesHex: args.signaturesHex,
  });
  assertPreviewOk(preview);
  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);
  const tx = buildFormClusterTxFields({
    chainId,
    nonce,
    fee,
    activePubkeysHex: args.activePubkeysHex,
    standbyPubkeysHex: args.standbyPubkeysHex,
    signaturesHex: args.signaturesHex,
    executionUnitLimit: args.executionUnitLimit,
  });
  const txInput = tx.input;
  if (typeof txInput !== "string") {
    throw new Error("formCluster tx input was not hex-encoded");
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
    activeCount: roster.activePubkeys.length,
    standbyCount: roster.standbyPubkeys.length,
    signatureCount: signatures.length,
    calldataHex: txInput,
    consentMessageHex: formClusterConsentMessageHex(args),
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}
