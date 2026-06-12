// Live-cluster charter AMENDMENT (`updateCharter`) helpers.
//
// A formed cluster's economics charter is not frozen: 7-of-10 of its
// CURRENTLY-ACTIVE members can consent to a new 30-byte charter via the
// node-registry `updateCharter(uint32,bytes,bytes,bytes)` precompile. The
// chain does NOT apply it immediately — a delegator-protective cooldown
// (`NODE_REGISTRY_CHARTER_COOLDOWN_EPOCHS`, ~24h in production) keeps the
// OLD terms in force until `effectiveEpoch`, so an ARK delegator who
// dislikes the new split can undelegate first.
//
// This module is the SDK seam the Charter panel talks to. It:
//
//   * reads the ACTIVE charter from node-registry storage (two SLOADs at
//     `0x1005`) and the PENDING amendment via the `getPendingCharter`
//     view, so the panel can show "current terms" + "pending change";
//   * encodes a draft charter (reusing the formation encoder) and derives
//     the `updateCharter` CONSENT DIGEST every signer must sign, under the
//     distinct `..._UPDATE_CHARTER_V1\0` domain that can never collide
//     with a formation consent;
//   * collects ≥7 ML-DSA-65 consent signatures from active members
//     (Rust re-derives + signs the digest — no blind-signing surface) and
//     folds them into a pure, render-friendly state;
//   * builds the `updateCharter` calldata once the threshold is met.
//
// Every byte-level encode/decode delegates to `@monolythium/core-sdk`
// (byte-identical to the Rust SDK + the on-chain decoder); the digest the
// Rust signer returns is ALWAYS cross-checked against the locally
// recomputed `updateCharterMessageHex` before a signature is accepted,
// exactly as the Ceremony Room cross-checks its formation digest.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex as nobleBytesToHex } from "@noble/hashes/utils.js";
import {
  addressToTypedBech32,
  decodeClusterCharter,
  encodeClusterCharter,
  encodeGetPendingCharterCalldata,
  decodePendingCharter,
  encodeUpdateCharterCalldata,
  nodeRegistryAddressHex,
  RpcClient,
  updateCharterMessageHex,
  NODE_REGISTRY_CHARTER_COOLDOWN_EPOCHS,
  NODE_REGISTRY_UPDATE_CHARTER_THRESHOLD,
  type PendingCharterView,
} from "@monolythium/core-sdk";
import {
  pqm1MnemonicToMlDsa65Backend,
  submitTransactionWithPrivacy,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  FORM_CLUSTER_ACTIVE_COUNT,
  FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS,
  FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS,
  FORM_CLUSTER_MEMBER_COUNT,
  FORM_CLUSTER_SIGNATURE_BYTES,
} from "./clusterFormOps";
import { NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES } from "./operatorKeys";
import { clampPriorityTip, type RegisterFeeQuote } from "./register";
import { validateCharterDraft, type CharterDraft } from "./charterShare";

/** Headroom for the large `updateCharter` calldata (charter + up to ten
 *  1952-byte pubkeys + ten 3309-byte signatures ≈ 53 KB). Mirrors the
 *  formCluster execution-unit limit. */
export const DEFAULT_UPDATE_CHARTER_EXECUTION_UNIT_LIMIT = 1_900_000n;

// ---- re-exports (one import site for the panel) ----------------------

export {
  NODE_REGISTRY_CHARTER_COOLDOWN_EPOCHS as CHARTER_COOLDOWN_EPOCHS,
  NODE_REGISTRY_UPDATE_CHARTER_THRESHOLD as UPDATE_CHARTER_THRESHOLD,
  FORM_CLUSTER_MEMBER_COUNT,
};
export type { CharterDraft, PendingCharterView };

// ---- node-registry storage layout (mirrors mono-core) ----------------
//
// Active charter lives in two SLOAD slots in account `0x1005`, written by
// the formCluster-V2 / updateCharter paths (mono-core
// `cluster_anchor::slot_cluster_charter`):
//
//   keccak256(0x31 ‖ clusterId_be32 ‖ 0x00) → presence = delegator_bps + 1
//   keccak256(0x31 ‖ clusterId_be32 ‖ 0x01) → packed 10×u16 BE member
//                                              shares at bytes [12..32]
//
// `U256::ZERO` presence = no charter = legacy default split.

/** `TAG_CLUSTER_CHARTER` — node-registry charter slot family tag. */
const TAG_CLUSTER_CHARTER = 0x31;
const SUBKIND_CHARTER_DELEGATOR_BPS = 0x00;
const SUBKIND_CHARTER_MEMBER_SHARES = 0x01;

function stripHex(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

function bytesToHex0x(bytes: Uint8Array): string {
  return `0x${nobleBytesToHex(bytes)}`;
}

function hexToBytes(value: string): Uint8Array {
  const clean = stripHex(value.trim());
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function u32BE(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

/** `slot_cluster_charter(clusterId, subkind)` = keccak256(0x31 ‖
 *  clusterId_be32 ‖ subkind), as a 0x-hex 32-byte slot key. */
export function clusterCharterSlotHex(clusterId: number, subkind: number): string {
  if (!Number.isInteger(clusterId) || clusterId < 0 || clusterId > 0xffff_ffff) {
    throw new Error(`clusterId out of range: ${clusterId}`);
  }
  const buf = new Uint8Array(1 + 4 + 1);
  buf[0] = TAG_CLUSTER_CHARTER;
  buf.set(u32BE(clusterId), 1);
  buf[5] = subkind & 0xff;
  return bytesToHex0x(keccak_256(buf));
}

// ---- active charter read ---------------------------------------------

/** A cluster's currently-effective charter, or `null` when the cluster
 *  runs the legacy default split (no charter ever written). */
export type ActiveCharter = {
  /** Ten member shares (bps), member-declaration order. Sum = 10000. */
  memberShareBps: number[];
  /** Delegator share (bps). */
  delegatorShareBps: number;
};

/** Minimal read surface — the `RpcClient.ethGetStorageAt` shape. */
export type CharterStorageReadClient = {
  ethGetStorageAt(address: string, slot: string): Promise<{ value: string }>;
};

/** Right-aligned big-endian integer from a 32-byte storage word hex. */
function wordToBigInt(valueHex: string): bigint {
  const clean = stripHex(valueHex.trim());
  return clean ? BigInt(`0x${clean}`) : 0n;
}

/** 32-byte storage word as fixed-width bytes (left-padded). */
function wordToBytes32(valueHex: string): Uint8Array {
  const clean = stripHex(valueHex.trim()).padStart(64, "0").slice(-64);
  return hexToBytes(`0x${clean}`);
}

/** Read a cluster's ACTIVE charter from node-registry storage. Returns
 *  `null` when the presence slot is zero (legacy default split). Fails
 *  soft to `null` only on a genuinely-absent charter — RPC errors throw so
 *  the caller can surface "read unavailable on this endpoint". */
export async function readActiveCharter(
  client: CharterStorageReadClient,
  clusterId: number,
): Promise<ActiveCharter | null> {
  const registry = nodeRegistryAddressHex();
  const presenceWord = await client.ethGetStorageAt(
    registry,
    clusterCharterSlotHex(clusterId, SUBKIND_CHARTER_DELEGATOR_BPS),
  );
  const presence = wordToBigInt(presenceWord.value);
  if (presence === 0n) return null;
  // presence word stores `delegator_share_bps + 1` (the `+1` sentinel).
  const delegatorShareBps = Number(presence - 1n);
  const sharesWord = await client.ethGetStorageAt(
    registry,
    clusterCharterSlotHex(clusterId, SUBKIND_CHARTER_MEMBER_SHARES),
  );
  const packed = wordToBytes32(sharesWord.value);
  const memberShareBps: number[] = [];
  for (let i = 0; i < FORM_CLUSTER_MEMBER_COUNT; i += 1) {
    const at = 12 + 2 * i;
    memberShareBps.push(((packed[at] ?? 0) << 8) | (packed[at + 1] ?? 0));
  }
  return { memberShareBps, delegatorShareBps };
}

// ---- pending charter read --------------------------------------------

/** Minimal read surface — the `RpcClient.ethCall` shape. */
export type CharterCallClient = {
  ethCall(request: { to: string; data: string }): Promise<string>;
};

/** Read a cluster's PENDING charter amendment via the `getPendingCharter`
 *  view. Returns `{ present: false, ... }` when no amendment is posted. */
export async function readPendingCharter(
  client: CharterCallClient,
  clusterId: number,
): Promise<PendingCharterView> {
  const data = encodeGetPendingCharterCalldata(clusterId);
  const returnData = await client.ethCall({ to: nodeRegistryAddressHex(), data });
  return decodePendingCharter(returnData);
}

// ---- charter encode + consent digest ---------------------------------

/** Encode a validated charter DRAFT (member shares + delegator share) to
 *  the 30-byte wire payload (0x hex). The amendment carries no consent
 *  expiry — the on-chain cooldown governs effectiveness — so the charter's
 *  `expiresMs` is pinned to 0. Throws `CharterDraftError` on a draft the
 *  chain would reject (sum ≠ 10000, delegator below floor). */
export function encodeCharterDraftHex(draft: {
  memberShareRows: readonly string[];
  delegatorShareBps: number;
}): string {
  const validated = validateCharterDraft(draft);
  const bytes = encodeClusterCharter({
    memberShareBps: validated.memberShareBps,
    delegatorShareBps: validated.delegatorShareBps,
    expiresMs: 0,
  });
  return bytesToHex0x(bytes);
}

/** Decode a 30-byte charter wire payload back to its member/delegator
 *  shares (the `expiresMs` field is unused for amendments). */
export function decodeCharterDraftHex(charterHex: string): CharterDraft {
  const decoded = decodeClusterCharter(hexToBytes(charterHex));
  return {
    memberShareBps: [...decoded.memberShareBps],
    delegatorShareBps: decoded.delegatorShareBps,
  };
}

/** The `updateCharter` consent digest (0x hex) every signer must sign,
 *  bound to the exact cluster id + charter bytes under the
 *  UPDATE_CHARTER domain. Thin wrapper over the core-sdk
 *  `updateCharterMessageHex` (byte-identical to mono-core). */
export function updateCharterConsentDigestHex(clusterId: number, charterHex: string): string {
  return updateCharterMessageHex(clusterId, hexToBytes(charterHex));
}

// ---- update-charter calldata -----------------------------------------

export type UpdateCharterCalldataArgs = {
  clusterId: number;
  charterHex: string;
  /** ≥7 active-member ML-DSA-65 pubkeys, 1:1 with `signaturesHex`. */
  signerPubkeysHex: string[];
  /** ≥7 ML-DSA-65 signatures over the consent digest, signer order. */
  signaturesHex: string[];
};

/** Encode `updateCharter(uint32,bytes,bytes,bytes)` calldata. Validates
 *  the signer/signature shape (count parity, threshold band) client-side
 *  via the core-sdk encoder so a doomed amendment never burns a nonce. */
export function encodeUpdateCharterCalldataHex(args: UpdateCharterCalldataArgs): string {
  if (args.signerPubkeysHex.length !== args.signaturesHex.length) {
    throw new Error(
      `signer pubkeys (${args.signerPubkeysHex.length}) and signatures (${args.signaturesHex.length}) counts must match`,
    );
  }
  return encodeUpdateCharterCalldata({
    clusterId: args.clusterId,
    charter: hexToBytes(args.charterHex),
    signerPubkeys: args.signerPubkeysHex.map((hex) => hexToBytes(hex)),
    signatures: args.signaturesHex.map((hex) => hexToBytes(hex)),
  });
}

// ---- update-charter submit -------------------------------------------

/** Pure builder for the `updateCharter` `NativeEvmTxFields` — calldata +
 *  SDK fee defaults. Side-effect-free so the fee/limit/clamp logic is
 *  unit-testable without a live node. */
export function buildUpdateCharterTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  clusterId: number;
  charterHex: string;
  signerPubkeysHex: string[];
  signaturesHex: string[];
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
    gasLimit: args.executionUnitLimit ?? DEFAULT_UPDATE_CHARTER_EXECUTION_UNIT_LIMIT,
    to: nodeRegistryAddressHex(),
    value: 0n,
    input: encodeUpdateCharterCalldataHex({
      clusterId: args.clusterId,
      charterHex: args.charterHex,
      signerPubkeysHex: args.signerPubkeysHex,
      signaturesHex: args.signaturesHex,
    }),
  };
}

export type SubmitUpdateCharterArgs = {
  rpcUrl: string;
  mnemonic: string;
  clusterId: number;
  charterHex: string;
  signerPubkeysHex: string[];
  signaturesHex: string[];
  executionUnitLimit?: bigint;
};

export type SubmitUpdateCharterResult = {
  txHash: string;
  clusterId: number;
  signatureCount: number;
  calldataHex: string;
  consentDigestHex: string;
};

/** Build + submit the `updateCharter` amendment from the caller's operator
 *  key. Re-encodes the consent digest for the receipt; the chain enforces
 *  the 7-of-10 active-member threshold and the cooldown. */
export async function submitUpdateCharter(
  args: SubmitUpdateCharterArgs,
): Promise<SubmitUpdateCharterResult> {
  if (args.signerPubkeysHex.length < NODE_REGISTRY_UPDATE_CHARTER_THRESHOLD) {
    throw new Error(
      `updateCharter requires at least ${NODE_REGISTRY_UPDATE_CHARTER_THRESHOLD} active-member consents, got ${args.signerPubkeysHex.length}`,
    );
  }
  const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
  const rpc = new RpcClient(args.rpcUrl);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());
  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);
  const tx = buildUpdateCharterTxFields({
    chainId,
    nonce,
    fee,
    clusterId: args.clusterId,
    charterHex: args.charterHex,
    signerPubkeysHex: args.signerPubkeysHex,
    signaturesHex: args.signaturesHex,
    executionUnitLimit: args.executionUnitLimit,
  });
  const calldataHex = tx.input;
  if (typeof calldataHex !== "string") {
    throw new Error("updateCharter tx input was not hex-encoded");
  }
  const txHash = await submitTransactionWithPrivacy({
    client: rpc,
    backend,
    tx,
    private: false,
  });
  return {
    txHash,
    clusterId: args.clusterId,
    signatureCount: args.signerPubkeysHex.length,
    calldataHex,
    consentDigestHex: updateCharterConsentDigestHex(args.clusterId, args.charterHex),
  };
}

// ---- Rust-side consent signing (no blind-signing surface) ------------

export class CharterSignTransportUnavailableError extends Error {
  constructor(
    message = "Charter signing requires the desktop app — the chat backend does not expose the updateCharter consent command in this build.",
  ) {
    super(message);
    this.name = "CharterSignTransportUnavailableError";
  }
}

function inTauriWebview(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

function isMissingCommandError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  return /not found|unknown command|not allowed|no handler/iu.test(message);
}

export type UpdateCharterConsentSignResult = {
  digest_hex: string;
  signature_hex: string;
};

/** Sign the `updateCharter` consent digest with the keychain operator
 *  key. The Rust side RE-DERIVES the digest from `(clusterId, charterHex)`
 *  under the UPDATE_CHARTER domain and signs it — there is no
 *  sign-this-digest surface. ALWAYS cross-check the returned `digest_hex`
 *  against {@link updateCharterConsentDigestHex} before accepting the
 *  signature (the panel refuses on mismatch). */
export async function signUpdateCharterConsent(args: {
  clusterId: number;
  charterHex: string;
}): Promise<UpdateCharterConsentSignResult> {
  if (!inTauriWebview()) {
    throw new CharterSignTransportUnavailableError(
      "Charter signing requires the desktop app — running in browser preview.",
    );
  }
  try {
    return await invoke<UpdateCharterConsentSignResult>("chat_sign_update_charter_consent", {
      clusterId: args.clusterId,
      charterHex: args.charterHex,
    });
  } catch (err) {
    if (isMissingCommandError(err)) {
      throw new CharterSignTransportUnavailableError();
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// ---- collected-signature state (pure) --------------------------------

function normalizeHex(value: string): string {
  const clean = stripHex(value.trim()).toLowerCase();
  return clean ? `0x${clean}` : "";
}

function isHexOfBytes(value: string, byteLen: number): boolean {
  return value.length === byteLen * 2 + 2 && /^0x[0-9a-f]+$/u.test(value);
}

/** One collected consent signature in an in-progress amendment. */
export type CollectedCharterConsent = {
  /** Signer's 1952-byte ML-DSA-65 active-member consensus pubkey (0x hex). */
  signerPubkeyHex: string;
  /** 3309-byte ML-DSA-65 signature over the consent digest (0x hex). */
  signatureHex: string;
};

export type CharterAmendmentReadiness = {
  /** Distinct, well-formed consents collected so far. */
  signatureCount: number;
  /** 7 (`UPDATE_CHARTER_THRESHOLD`). */
  threshold: number;
  /** True once `signatureCount >= threshold` with valid shapes. */
  ready: boolean;
  /** Stable human reason when not ready (null when ready). */
  reason: string | null;
  /** De-duplicated signer pubkeys / signatures in collection order. */
  signerPubkeysHex: string[];
  signaturesHex: string[];
};

/** Fold collected consents into amendment readiness — de-duplicates by
 *  signer pubkey, rejects malformed shapes, and reports whether the
 *  7-of-10 threshold is met. Pure (no chain calls); the membership /
 *  active-seat check is enforced by the panel using the live roster and
 *  by the chain at execution. */
export function reduceCharterAmendment(
  consents: readonly CollectedCharterConsent[],
): CharterAmendmentReadiness {
  const threshold = NODE_REGISTRY_UPDATE_CHARTER_THRESHOLD;
  const seen = new Set<string>();
  const signerPubkeysHex: string[] = [];
  const signaturesHex: string[] = [];
  for (const consent of consents) {
    const pubkey = normalizeHex(consent.signerPubkeyHex);
    const sig = normalizeHex(consent.signatureHex);
    if (!isHexOfBytes(pubkey, NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES)) continue;
    if (!isHexOfBytes(sig, FORM_CLUSTER_SIGNATURE_BYTES)) continue;
    if (seen.has(pubkey)) continue;
    seen.add(pubkey);
    signerPubkeysHex.push(pubkey);
    signaturesHex.push(sig);
  }
  const signatureCount = signerPubkeysHex.length;
  const ready = signatureCount >= threshold && signatureCount <= FORM_CLUSTER_MEMBER_COUNT;
  return {
    signatureCount,
    threshold,
    ready,
    reason: ready
      ? null
      : `waiting on consents — ${signatureCount} of ${threshold} active-member signatures collected`,
    signerPubkeysHex,
    signaturesHex,
  };
}

// ---- shared constants re-export --------------------------------------

export {
  FORM_CLUSTER_ACTIVE_COUNT,
  FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS,
  FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS,
};
