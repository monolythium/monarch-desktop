// No-foundation cluster formation helpers.
//
// `formCluster(bytes,bytes,bytes)` forms the standard 7-active +
// 3-standby topology. The calldata carries the active pubkeys, standby
// pubkeys, and ten ML-DSA-65 consent signatures in roster order.
//
// V2 (`formCluster(bytes,bytes,bytes,bytes)`, selector 0xdc4cc1cc)
// additionally carries the 30-byte economics CHARTER: 10×u16 BE
// member_share_bps (active 0..7 then standby 7..10, sum 10,000) ‖
// u16 BE delegator_share_bps in [2,000, 10,000] ‖ u64 BE expires_ms.
// With a charter present the ten consent signatures verify over the
// V2 digest (`formClusterMessageV2`, fresh domain), which commits to
// the charter bytes — nobody can be bound to terms they did not sign.
// Without a charter every path below stays byte-identical V1.

import { blake3 } from "@noble/hashes/blake3.js";
import {
  addressToTypedBech32,
  encodeClusterCharter,
  encodeFormClusterV2Calldata,
  formClusterMessageV2,
  NODE_REGISTRY_CLUSTER_CHARTER_BYTES,
  NODE_REGISTRY_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS,
  NODE_REGISTRY_CLUSTER_CHARTER_SHARE_DENOM_BPS,
  NODE_REGISTRY_SELECTORS,
  nodeRegistryAddressHex,
  type ClusterCharterArgs,
} from "@monolythium/core-sdk";
import { makeRpcClient } from "./rpcTransport";
import {
  pqm1MnemonicToMlDsa65Backend,
  submitTransactionWithPrivacy,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { clampPriorityTip, type RegisterFeeQuote } from "./register";
import { NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES } from "./operatorKeys";

export const FORM_CLUSTER_SELECTOR = "0x961a4ced";
/** `formCluster(bytes,bytes,bytes,bytes)` — the charter-bearing V2 selector. */
export const FORM_CLUSTER_V2_SELECTOR: string = NODE_REGISTRY_SELECTORS.formClusterV2;
export const FORM_CLUSTER_ACTIVE_COUNT = 7;
export const FORM_CLUSTER_STANDBY_COUNT = 3;
export const FORM_CLUSTER_MEMBER_COUNT = FORM_CLUSTER_ACTIVE_COUNT + FORM_CLUSTER_STANDBY_COUNT;
export const FORM_CLUSTER_THRESHOLD = 7;
export const FORM_CLUSTER_SIGNATURE_BYTES = 3309;
export const FORM_CLUSTER_CONSENT_MESSAGE_DOMAIN =
  "PROTOCORE_NODE_REGISTRY_CLUSTER_FORM_V1\0";
export const FORM_CLUSTER_CONSENT_MESSAGE_DOMAIN_V2 =
  "PROTOCORE_NODE_REGISTRY_CLUSTER_FORM_V2\0";
/** Fixed width of the V2 charter wire payload (mono-core `CLUSTER_CHARTER_LEN`). */
export const FORM_CLUSTER_CHARTER_BYTES: number = NODE_REGISTRY_CLUSTER_CHARTER_BYTES;
/** Basis-point denominator the ten charter member shares must sum to. */
export const FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS: number =
  NODE_REGISTRY_CLUSTER_CHARTER_SHARE_DENOM_BPS;
/** Protocol floor for a charter's delegator share (Law §6.8). */
export const FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS: number =
  NODE_REGISTRY_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS;
export const DEFAULT_FORM_CLUSTER_EXECUTION_UNIT_LIMIT = 1_900_000n;

const MAX_UINT32 = (1n << 32n) - 1n;

export interface FormClusterCalldataArgs {
  activePubkeysHex: string;
  standbyPubkeysHex: string;
  signaturesHex: string;
  /** Optional 30-byte V2 charter (0x hex). Present → V2 selector +
   *  V2 consent digest; absent → V1, byte-identical to before. */
  charterHex?: string;
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

// ---- charter (V2 economics) -----------------------------------------

export type ClusterCharterErrorCode =
  | "length"
  | "share-sum"
  | "delegator-floor"
  | "delegator-ceiling"
  | "expired";

/** Typed client-side charter rejection — mirrors the on-chain
 *  `decode_cluster_charter` checks so a malformed charter fails before
 *  a nonce is burned. */
export class ClusterCharterError extends Error {
  readonly code: ClusterCharterErrorCode;

  constructor(code: ClusterCharterErrorCode, message: string) {
    super(message);
    this.name = "ClusterCharterError";
    this.code = code;
  }
}

export type DecodedClusterCharter = {
  /** Ten per-member shares in bps, member-declaration order
   *  (active 0..7 then standby 7..10). */
  memberShareBps: number[];
  delegatorShareBps: number;
  /** Consent expiry, unix ms. */
  expiresMs: number;
};

/** Decode the 30-byte charter wire payload. Throws `ClusterCharterError`
 *  ("length") when the payload is not exactly 30 bytes. */
export function decodeClusterCharterHex(charterHex: string): DecodedClusterCharter {
  const bytes = hexToBytes(charterHex, "charter");
  if (bytes.length !== FORM_CLUSTER_CHARTER_BYTES) {
    throw new ClusterCharterError(
      "length",
      `charter: expected exactly ${FORM_CLUSTER_CHARTER_BYTES} bytes, got ${bytes.length}`,
    );
  }
  const u16At = (offset: number): number => ((bytes[offset]! << 8) | bytes[offset + 1]!) >>> 0;
  const memberShareBps = Array.from({ length: FORM_CLUSTER_MEMBER_COUNT }, (_, index) =>
    u16At(index * 2),
  );
  const delegatorShareBps = u16At(FORM_CLUSTER_MEMBER_COUNT * 2);
  let expires = 0n;
  for (let i = FORM_CLUSTER_MEMBER_COUNT * 2 + 2; i < FORM_CLUSTER_CHARTER_BYTES; i += 1) {
    expires = (expires << 8n) | BigInt(bytes[i]!);
  }
  return { memberShareBps, delegatorShareBps, expiresMs: Number(expires) };
}

/** Decode + validate a charter client-side: 30 bytes, member shares sum
 *  to exactly 10,000 bps, delegator share within [2,000, 10,000], and —
 *  when `nowMs` is given — the consent expiry still in the future.
 *  Throws `ClusterCharterError` with a stable `code` per violation. */
export function validateClusterCharterHex(
  charterHex: string,
  opts?: { nowMs?: number },
): DecodedClusterCharter {
  const charter = decodeClusterCharterHex(charterHex);
  const shareSum = charter.memberShareBps.reduce((sum, bps) => sum + bps, 0);
  if (shareSum !== FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS) {
    throw new ClusterCharterError(
      "share-sum",
      `charter member shares must sum to exactly ${FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS} bps, got ${shareSum}`,
    );
  }
  if (charter.delegatorShareBps < FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS) {
    throw new ClusterCharterError(
      "delegator-floor",
      `charter delegator share ${charter.delegatorShareBps} bps is below the protocol floor of ${FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS} bps`,
    );
  }
  if (charter.delegatorShareBps > FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS) {
    throw new ClusterCharterError(
      "delegator-ceiling",
      `charter delegator share ${charter.delegatorShareBps} bps exceeds the ${FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS} bps ceiling`,
    );
  }
  if (opts?.nowMs !== undefined && charter.expiresMs <= opts.nowMs) {
    throw new ClusterCharterError(
      "expired",
      `charter consent expiry ${new Date(charter.expiresMs).toISOString()} is not in the future`,
    );
  }
  return charter;
}

/** Encode charter terms to the 30-byte wire payload as 0x hex — thin
 *  wrapper over the core-sdk `encodeClusterCharter` (byte-identical to
 *  the Rust SDK + the on-chain decoder). */
export function encodeClusterCharterHex(args: ClusterCharterArgs): string {
  return bytesToHex(encodeClusterCharter(args));
}

function previewError(preview: FormClusterPreview): Error {
  const reason = preview.reason ? `: ${preview.reason}` : "";
  const message = preview.message ? ` (${preview.message})` : "";
  return new Error(`formCluster preview rejected${reason}${message}`);
}

function assertPreviewOk(preview: FormClusterPreview): void {
  if (!preview.ok) throw previewError(preview);
}

/** Roster consent digest. Without `charterHex` this is the original
 *  byte-identical V1 BLAKE3 layout; with a 30-byte charter it is the
 *  core-sdk `formClusterMessageV2` (fresh domain, charter committed). */
export function formClusterConsentMessage(args: {
  activePubkeysHex: string;
  standbyPubkeysHex: string;
  charterHex?: string;
}): Uint8Array {
  const roster = parseRoster(args);
  if (args.charterHex) {
    const charter = hexToBytes(args.charterHex.trim(), "charter");
    if (charter.length !== FORM_CLUSTER_CHARTER_BYTES) {
      throw new ClusterCharterError(
        "length",
        `charter: expected exactly ${FORM_CLUSTER_CHARTER_BYTES} bytes, got ${charter.length}`,
      );
    }
    return formClusterMessageV2(roster.activePubkeysBytes, roster.standbyPubkeysBytes, charter);
  }
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
  charterHex?: string;
}): string {
  return bytesToHex(formClusterConsentMessage(args));
}

export function signFormClusterConsent(args: {
  mnemonic: string;
  activePubkeysHex: string;
  standbyPubkeysHex: string;
  charterHex?: string;
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

  if (args.charterHex) {
    // V2 — structural charter validation first (length, share sum,
    // delegator band), then the core-sdk encoder (byte-identical to the
    // Rust SDK `encode_form_cluster_v2_calldata`).
    validateClusterCharterHex(args.charterHex);
    return encodeFormClusterV2Calldata({
      activePubkeys: roster.activePubkeysBytes,
      standbyPubkeys: roster.standbyPubkeysBytes,
      signatures: concat(signatures),
      charter: hexToBytes(args.charterHex.trim(), "charter", FORM_CLUSTER_CHARTER_BYTES),
    });
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
  charterHex?: string;
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
      charterHex: args.charterHex,
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
  const params: {
    from: string;
    activePubkeys: string[];
    standbyPubkeys: string[];
    signatures: string[];
    charter?: string;
  } = {
    from: args.from,
    activePubkeys: roster.activePubkeys.map(bytesToHex),
    standbyPubkeys: roster.standbyPubkeys.map(bytesToHex),
    signatures: signatures.map(bytesToHex),
  };
  if (args.charterHex) {
    validateClusterCharterHex(args.charterHex);
    params.charter = bytesToHex(
      hexToBytes(args.charterHex.trim(), "charter", FORM_CLUSTER_CHARTER_BYTES),
    );
  }
  try {
    return await client.call<FormClusterPreview>("lyth_previewFormCluster", [params]);
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
  if (args.charterHex) {
    // Full charter gate before anything irreversible — including the
    // consent expiry, which the chain enforces at execution.
    validateClusterCharterHex(args.charterHex, { nowMs: Date.now() });
  }

  const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
  const rpc = makeRpcClient(args.rpcUrl);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());
  const preview = await previewFormCluster(rpc, {
    from: senderAddress,
    activePubkeysHex: args.activePubkeysHex,
    standbyPubkeysHex: args.standbyPubkeysHex,
    signaturesHex: args.signaturesHex,
    charterHex: args.charterHex,
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
    charterHex: args.charterHex,
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
