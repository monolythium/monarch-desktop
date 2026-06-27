// Ceremony room — live multi-party formCluster lobby (schema + reducer +
// transport + export/import).
//
// The ceremony room coordinates ten registered operators forming a new
// cluster (7 active + 3 standby, 7-of-10 threshold) over the signed
// operator-chat transport. Bodies are versioned JSON carried inside
// signed ChatEnvelopes; identity is ALWAYS the verified envelope sender
// (`sender_address` / `sender_pubkey_hex`), never anything claimed in a
// body. The lobby state is a pure reduction over `ChatMessage[]`:
//
//   propose  — initiator declares 10 seats + terms + expiry
//   join     — a participant claims a seat (pubkey = envelope sender key)
//   freeze   — initiator pins the consent digest; every client recomputes
//              it locally and refuses on mismatch
//   consent  — an ML-DSA-65 signature over the 32-byte consent digest
//   withdraw — deletes that sender's join AND consent
//   submit   — records the formCluster tx hash
//   snapshot — initiator re-broadcast for late joiners (no gossip backfill)
//
// Any roster change shifts the locally recomputed digest, so every
// previously published consent goes stale automatically — readiness is
// exactly "10 distinct seats whose claimed sender published a verified
// consent over the CURRENT digest".
//
// CHARTER (V2): a propose MAY carry the 30-byte economics charter in
// `terms.charter` (with `terms.charter_hash` = SHA-256 over the charter
// bytes). With a charter present the consent digest is the V2
// `formClusterMessageV2` (fresh domain, charter committed) and the
// submit encodes `formCluster(bytes,bytes,bytes,bytes)`; without one,
// every path stays byte-identical V1. A charter change is a terms
// change: the digest shifts and every collected consent goes stale.
//
// Transport runs over Tauri `invoke()` directly (no bridge.ts) so this
// module stays standalone; missing commands degrade to a typed
// "transport unavailable in this build" error instead of crashing.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as nobleBytesToHex } from "@noble/hashes/utils.js";
import {
  formClusterMessageHex,
  formClusterMessageV2Hex,
  verifyNoEvmArchiveProofSignatures,
  NO_EVM_ARCHIVE_PROOF_SCHEMA,
  NO_EVM_ARCHIVE_SIGNATURE_SCHEME,
} from "@monolythium/core-sdk";
import { mlDsa65AddressFromPublicKey } from "@monolythium/core-sdk/crypto";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  FORM_CLUSTER_ACTIVE_COUNT,
  FORM_CLUSTER_STANDBY_COUNT,
  FORM_CLUSTER_MEMBER_COUNT,
  FORM_CLUSTER_THRESHOLD,
  FORM_CLUSTER_SIGNATURE_BYTES,
  FORM_CLUSTER_CHARTER_BYTES,
  decodeClusterCharterHex,
  validateClusterCharterHex,
} from "./clusterFormOps";
import {
  NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  operatorPubkeyHash,
} from "./operatorKeys";
import type { ChatChannel, ChatInitResult, ChatMessage } from "./chat";
import type { ClusterFormInput, OpRequest } from "../ops/types";

// ---- constants -----------------------------------------------------

export const CEREMONY_SCHEMA_VERSION = 1 as const;
export const CEREMONY_CHANNEL_PREFIX = "ceremony-";
/** Sentinel cluster id for ceremony channels (never 0 — cluster-0 is real). */
export const CEREMONY_SENTINEL_CLUSTER_ID = -1;
/** Per-kind body ceiling agreed with the Rust transport (one consent sig + JSON). */
export const CEREMONY_MAX_BODY_BYTES = 12_288;
export const CEREMONY_EXPORT_SCHEMA = "monarch-desktop-ceremony-export/v1";
export const CEREMONY_TRANSPORT_UNAVAILABLE_MESSAGE =
  "Ceremony transport is unavailable in this build — the chat backend does not expose the ceremony commands yet. Use the JSON export/import fallback below.";

// ---- small hex helpers (self-contained on purpose) ------------------

function normalizeHex(value: string): string {
  const clean = value.trim().replace(/^0x/iu, "").toLowerCase();
  return clean ? `0x${clean}` : "";
}

function isHexOfBytes(value: string, byteLen: number): boolean {
  return (
    value.length === byteLen * 2 + 2 && /^0x[0-9a-f]+$/u.test(value)
  );
}

function hexToBytes(value: string): Uint8Array {
  const clean = value.replace(/^0x/iu, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex0x(bytes: Uint8Array): string {
  return `0x${nobleBytesToHex(bytes)}`;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Canonical JSON (sorted keys) — same shape discipline as ops/receipts.ts. */
export function ceremonyCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(ceremonyCanonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${ceremonyCanonicalJson(record[key])}`)
    .join(",")}}`;
}

// ---- message schema --------------------------------------------------

export type CeremonySeatRole = "active" | "standby";

export type CeremonySeatRef = {
  role: CeremonySeatRole;
  index: number;
};

/** A declared seat. `operator_id` = 0x-prefixed BLAKE3(pubkey) hex pinning
 *  WHO may claim the seat; empty string = open seat. */
export type CeremonySeatDecl = CeremonySeatRef & {
  operator_id: string;
};

export type CeremonyTerms = {
  threshold: number;
  bond_lythoshi: string;
  commission_bps: number;
  /** 30-byte V2 charter wire hex: 10×u16 BE member_share_bps (sum
   *  10,000) ‖ u16 BE delegator_share_bps ‖ u64 BE expires_ms.
   *  Present → the consent digest is the charter-committing V2 digest. */
  charter?: string;
  /** SHA-256 over the 30 charter bytes (0x hex). MUST match `charter`
   *  when a charter is present; MUST be "" when there is none. */
  charter_hash: string;
};

export type CeremonyProposeBody = {
  v: typeof CEREMONY_SCHEMA_VERSION;
  t: "propose";
  cid: string;
  seats: CeremonySeatDecl[];
  terms: CeremonyTerms;
  expires_ms: number;
};

export type CeremonyJoinBody = {
  t: "join";
  cid: string;
  ref: string;
  seat: CeremonySeatRef;
};

export type CeremonyFreezeBody = {
  t: "freeze";
  cid: string;
  ref: string;
  consent_digest: string;
};

export type CeremonyConsentBody = {
  t: "consent";
  cid: string;
  ref: string;
  consent_digest: string;
  sig: string;
};

export type CeremonyWithdrawBody = {
  t: "withdraw";
  cid: string;
  ref: string;
};

export type CeremonySubmitBody = {
  t: "submit";
  cid: string;
  ref: string;
  tx_hash: string;
};

export type CeremonySnapshotState = {
  propose: {
    msg_id: string;
    sender_address: string;
    body: CeremonyProposeBody;
  };
  joins: Array<{
    sender_address: string;
    sender_pubkey_hex: string;
    seat: CeremonySeatRef;
    timestamp_ms: number;
  }>;
  consents: Array<{
    sender_address: string;
    consent_digest: string;
    sig: string;
    timestamp_ms: number;
  }>;
  freeze?: { consent_digest: string } | null;
  submit?: { sender_address: string; tx_hash: string } | null;
};

export type CeremonySnapshotBody = {
  t: "snapshot";
  cid: string;
  state: CeremonySnapshotState;
};

export type CeremonyMessageBody =
  | CeremonyProposeBody
  | CeremonyJoinBody
  | CeremonyFreezeBody
  | CeremonyConsentBody
  | CeremonyWithdrawBody
  | CeremonySubmitBody
  | CeremonySnapshotBody;

function isSeatRef(value: unknown): value is CeremonySeatRef {
  if (!value || typeof value !== "object") return false;
  const seat = value as Partial<CeremonySeatRef>;
  return (
    (seat.role === "active" || seat.role === "standby") &&
    typeof seat.index === "number" &&
    Number.isInteger(seat.index) &&
    seat.index >= 0
  );
}

function isSeatDecl(value: unknown): value is CeremonySeatDecl {
  return (
    isSeatRef(value) &&
    typeof (value as Partial<CeremonySeatDecl>).operator_id === "string"
  );
}

function isTerms(value: unknown): value is CeremonyTerms {
  if (!value || typeof value !== "object") return false;
  const terms = value as Partial<CeremonyTerms>;
  return (
    typeof terms.threshold === "number" &&
    typeof terms.bond_lythoshi === "string" &&
    typeof terms.commission_bps === "number" &&
    typeof terms.charter_hash === "string" &&
    (terms.charter === undefined || typeof terms.charter === "string")
  );
}

function parseProposeRecord(record: Record<string, unknown>): CeremonyProposeBody | null {
  if (record.t !== "propose" || typeof record.cid !== "string" || !record.cid) return null;
  if (record.v !== CEREMONY_SCHEMA_VERSION) return null;
  if (!Array.isArray(record.seats) || !record.seats.every(isSeatDecl)) return null;
  if (!isTerms(record.terms)) return null;
  if (typeof record.expires_ms !== "number") return null;
  return {
    v: CEREMONY_SCHEMA_VERSION,
    t: "propose",
    cid: record.cid,
    seats: record.seats as CeremonySeatDecl[],
    terms: record.terms as CeremonyTerms,
    expires_ms: record.expires_ms,
  };
}

/** Parse a chat body into a typed ceremony message; null when the body is
 *  not ceremony JSON (plain chatter is legal on the channel). */
export function parseCeremonyBody(body: string): CeremonyMessageBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.t !== "string" || typeof record.cid !== "string" || !record.cid) {
    return null;
  }
  switch (record.t) {
    case "propose": {
      return parseProposeRecord(record);
    }
    case "join": {
      if (typeof record.ref !== "string" || !isSeatRef(record.seat)) return null;
      return { t: "join", cid: record.cid, ref: record.ref, seat: record.seat };
    }
    case "freeze": {
      if (typeof record.ref !== "string" || typeof record.consent_digest !== "string") return null;
      return {
        t: "freeze",
        cid: record.cid,
        ref: record.ref,
        consent_digest: record.consent_digest,
      };
    }
    case "consent": {
      if (
        typeof record.ref !== "string" ||
        typeof record.consent_digest !== "string" ||
        typeof record.sig !== "string"
      ) {
        return null;
      }
      return {
        t: "consent",
        cid: record.cid,
        ref: record.ref,
        consent_digest: record.consent_digest,
        sig: record.sig,
      };
    }
    case "withdraw": {
      if (typeof record.ref !== "string") return null;
      return { t: "withdraw", cid: record.cid, ref: record.ref };
    }
    case "submit": {
      if (typeof record.ref !== "string" || typeof record.tx_hash !== "string") return null;
      return { t: "submit", cid: record.cid, ref: record.ref, tx_hash: record.tx_hash };
    }
    case "snapshot": {
      const state = record.state as Partial<CeremonySnapshotState> | undefined;
      if (!state || typeof state !== "object") return null;
      const propose = state.propose;
      if (
        !propose ||
        typeof propose.msg_id !== "string" ||
        typeof propose.sender_address !== "string" ||
        !propose.body ||
        typeof propose.body !== "object"
      ) {
        return null;
      }
      const proposeBody = parseProposeRecord(propose.body as unknown as Record<string, unknown>);
      if (!proposeBody) return null;
      if (!Array.isArray(state.joins) || !Array.isArray(state.consents)) return null;
      return {
        t: "snapshot",
        cid: record.cid,
        state: {
          ...(state as CeremonySnapshotState),
          propose: { ...propose, body: proposeBody },
        },
      };
    }
    default:
      return null;
  }
}

// ---- ceremony / channel ids ------------------------------------------

/** New random ceremony id — 8 bytes of lowercase hex (no 0x prefix). */
export function newCeremonyId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return nobleBytesToHex(bytes);
}

export function isCeremonyId(value: string): boolean {
  return /^[0-9a-f]{4,64}$/u.test(value);
}

export function ceremonyChannelId(ceremonyId: string): string {
  if (!isCeremonyId(ceremonyId)) {
    throw new Error("ceremony id must be 4-64 lowercase hex characters");
  }
  return `${CEREMONY_CHANNEL_PREFIX}${ceremonyId}`;
}

// ---- consent digest (V1 without charter, V2 with) ---------------------

export type CeremonyDigestArgs = {
  /** Exactly 7 per-key hex strings (1952 bytes each), roster order. */
  activePubkeysHex: string[];
  /** Exactly 3 per-key hex strings (1952 bytes each), roster order. */
  standbyPubkeysHex: string[];
  /** Optional 30-byte V2 charter hex — switches to the charter-committing
   *  V2 digest domain (`formClusterMessageV2Hex`). */
  charterHex?: string;
};

/** Locally recompute the formCluster consent digest via the core-sdk
 *  mirrors: `formClusterMessageHex` (V1) without a charter,
 *  `formClusterMessageV2Hex` (charter committed, fresh domain) with one. */
export function computeCeremonyConsentDigestHex(args: CeremonyDigestArgs): string {
  if (args.activePubkeysHex.length !== FORM_CLUSTER_ACTIVE_COUNT) {
    throw new Error(`expected ${FORM_CLUSTER_ACTIVE_COUNT} active operator pubkeys`);
  }
  if (args.standbyPubkeysHex.length !== FORM_CLUSTER_STANDBY_COUNT) {
    throw new Error(`expected ${FORM_CLUSTER_STANDBY_COUNT} standby operator pubkeys`);
  }
  const toBlob = (values: string[], label: string): Uint8Array =>
    concatBytes(
      values.map((value, index) => {
        const clean = normalizeHex(value);
        if (!isHexOfBytes(clean, NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES)) {
          throw new Error(
            `${label}[${index}] must be a ${NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES}-byte ML-DSA-65 consensus pubkey`,
          );
        }
        return hexToBytes(clean);
      }),
    );
  const activeBlob = toBlob(args.activePubkeysHex, "activePubkeys");
  const standbyBlob = toBlob(args.standbyPubkeysHex, "standbyPubkeys");
  if (args.charterHex) {
    const charterHex = normalizeHex(args.charterHex);
    if (!isHexOfBytes(charterHex, FORM_CLUSTER_CHARTER_BYTES)) {
      throw new Error(
        `charter must be the ${FORM_CLUSTER_CHARTER_BYTES}-byte charter wire payload`,
      );
    }
    return normalizeHex(
      formClusterMessageV2Hex(activeBlob, standbyBlob, hexToBytes(charterHex)),
    );
  }
  return normalizeHex(formClusterMessageHex(activeBlob, standbyBlob));
}

// ---- charter terms ------------------------------------------------------

/** `terms.charter_hash` scheme: 0x-hex SHA-256 over the 30 charter
 *  bytes. A propose-body integrity pin only — the consent digest itself
 *  commits to the raw charter bytes via the V2 domain. */
export function ceremonyCharterHashHex(charterHex: string): string {
  const clean = normalizeHex(charterHex);
  if (!isHexOfBytes(clean, FORM_CLUSTER_CHARTER_BYTES)) {
    throw new Error(`charter must be the ${FORM_CLUSTER_CHARTER_BYTES}-byte charter wire payload`);
  }
  return bytesToHex0x(sha256(hexToBytes(clean)));
}

/** Validate the charter slot of ceremony terms. Returns a human-readable
 *  rejection or null when acceptable. Structural only (no clock) — the
 *  charter expiry is enforced at sign/submit time, where a clock exists. */
export function validateCeremonyCharterTerms(terms: CeremonyTerms): string | null {
  if (!terms.charter) {
    return terms.charter_hash
      ? "terms.charter_hash is set but no charter bytes are present"
      : null;
  }
  const charterHex = normalizeHex(terms.charter);
  if (!isHexOfBytes(charterHex, FORM_CLUSTER_CHARTER_BYTES)) {
    return `terms.charter must be the ${FORM_CLUSTER_CHARTER_BYTES}-byte charter wire payload`;
  }
  try {
    validateClusterCharterHex(charterHex);
  } catch (err) {
    return `terms.charter is invalid: ${(err as Error)?.message ?? String(err)}`;
  }
  if (normalizeHex(terms.charter_hash) !== ceremonyCharterHashHex(charterHex)) {
    return "terms.charter_hash does not match SHA-256 of the charter bytes";
  }
  return null;
}

// ---- ML-DSA-65 consent signature verification ------------------------
//
// The core-sdk does not export a bare verify(pubkey, msg, sig); the
// archive-proof verifier is its supported raw ML-DSA-65 verification
// surface (one trusted signer, threshold 1, message = 32-byte digest),
// which is exactly the consent-signature shape.

const verifyMemo = new Map<string, boolean>();
const VERIFY_MEMO_MAX = 1024;

export function verifyCeremonyConsentSignature(args: {
  pubkeyHex: string;
  consentDigestHex: string;
  signatureHex: string;
}): boolean {
  const pubkeyHex = normalizeHex(args.pubkeyHex);
  const digestHex = normalizeHex(args.consentDigestHex);
  const sigHex = normalizeHex(args.signatureHex);
  if (!isHexOfBytes(pubkeyHex, NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES)) return false;
  if (!isHexOfBytes(digestHex, 32)) return false;
  if (!isHexOfBytes(sigHex, FORM_CLUSTER_SIGNATURE_BYTES)) return false;

  const memoKey = `${digestHex}|${pubkeyHex}|${sigHex}`;
  const cached = verifyMemo.get(memoKey);
  if (cached !== undefined) return cached;

  let ok = false;
  try {
    const publicKey = hexToBytes(pubkeyHex);
    const signerId = mlDsa65AddressFromPublicKey(publicKey);
    const result = verifyNoEvmArchiveProofSignatures(
      {
        schema: NO_EVM_ARCHIVE_PROOF_SCHEMA,
        source: "monarch-ceremony-consent",
        manifestHash: digestHex,
        contentHash: digestHex,
        signatureDigest: digestHex,
        signatures: [`${NO_EVM_ARCHIVE_SIGNATURE_SCHEME}:${signerId}:${sigHex}`],
      },
      [{ publicKey }],
      1,
    );
    ok = result.verified;
  } catch {
    ok = false;
  }
  if (verifyMemo.size >= VERIFY_MEMO_MAX) verifyMemo.clear();
  verifyMemo.set(memoKey, ok);
  return ok;
}

// ---- pure reducer ----------------------------------------------------

export type CeremonyParticipant = {
  /** Verified envelope sender address (identity anchor). */
  address: string;
  /** Verified envelope sender pubkey (the registered consensus key). */
  pubkeyHex: string;
  /** BLAKE3(pubkey) — the operator id used for lyth_operatorInfo checks. */
  operatorIdHex: string;
  seat: CeremonySeatRef;
  timestampMs: number;
  viaSnapshot: boolean;
};

export type CeremonyConsentStatus =
  | "valid"
  | "stale-digest"
  | "invalid-signature"
  | "no-seat";

export type CeremonyConsent = {
  address: string;
  consentDigest: string;
  sigHex: string;
  timestampMs: number;
  viaSnapshot: boolean;
  status: CeremonyConsentStatus;
};

export type CeremonyState = {
  cid: string | null;
  proposeMsgId: string | null;
  initiatorAddress: string | null;
  seats: CeremonySeatDecl[];
  terms: CeremonyTerms | null;
  expiresMs: number | null;
  participants: CeremonyParticipant[];
  consents: CeremonyConsent[];
  /** Digest pinned by the initiator's freeze (null until frozen). */
  frozenDigest: string | null;
  /** Locally recomputed digest — null until all 10 seats are claimed. */
  localDigest: string | null;
  /** True when frozen and the local recomputation disagrees — REFUSE. */
  digestMismatch: boolean;
  validConsentCount: number;
  /** 10 distinct verified consents over the current local digest. */
  ready: boolean;
  submitted: { txHash: string; address: string } | null;
  warnings: string[];
};

export type CeremonyVerifyFn = (args: {
  pubkeyHex: string;
  consentDigestHex: string;
  signatureHex: string;
}) => boolean;

export type ReduceCeremonyOptions = {
  /** Signature verifier override (tests / web workers). Defaults to real ML-DSA-65. */
  verify?: CeremonyVerifyFn;
};

function seatKey(seat: CeremonySeatRef): string {
  return `${seat.role}:${seat.index}`;
}

function validateProposeSeats(seats: CeremonySeatDecl[]): string | null {
  if (seats.length !== FORM_CLUSTER_MEMBER_COUNT) {
    return `propose must declare exactly ${FORM_CLUSTER_MEMBER_COUNT} seats`;
  }
  const active = seats.filter((seat) => seat.role === "active");
  const standby = seats.filter((seat) => seat.role === "standby");
  if (active.length !== FORM_CLUSTER_ACTIVE_COUNT) {
    return `propose must declare ${FORM_CLUSTER_ACTIVE_COUNT} active seats`;
  }
  if (standby.length !== FORM_CLUSTER_STANDBY_COUNT) {
    return `propose must declare ${FORM_CLUSTER_STANDBY_COUNT} standby seats`;
  }
  const seen = new Set<string>();
  for (const seat of seats) {
    const max = seat.role === "active" ? FORM_CLUSTER_ACTIVE_COUNT : FORM_CLUSTER_STANDBY_COUNT;
    if (seat.index < 0 || seat.index >= max) {
      return `propose seat ${seat.role}:${seat.index} is out of range`;
    }
    const key = seatKey(seat);
    if (seen.has(key)) return `propose declares seat ${key} twice`;
    seen.add(key);
    if (seat.operator_id && !isHexOfBytes(normalizeHex(seat.operator_id), 32)) {
      return `propose seat ${key} pins a malformed operator id`;
    }
  }
  return null;
}

function validateProposeBody(body: CeremonyProposeBody): string | null {
  const seatError = validateProposeSeats(body.seats);
  if (seatError) return seatError;
  if (body.terms.threshold !== FORM_CLUSTER_THRESHOLD) {
    return `terms.threshold must be ${FORM_CLUSTER_THRESHOLD}`;
  }
  const charterError = validateCeremonyCharterTerms(body.terms);
  if (charterError) return charterError;
  if (!Number.isFinite(body.expires_ms) || body.expires_ms <= 0) {
    return "propose expiry is malformed";
  }
  return null;
}

/** Canonical seat order: active 0..6, then standby 0..2 — consensus-critical. */
export function ceremonySeatOrder(seats: CeremonySeatDecl[]): CeremonySeatDecl[] {
  const active = seats
    .filter((seat) => seat.role === "active")
    .sort((a, b) => a.index - b.index);
  const standby = seats
    .filter((seat) => seat.role === "standby")
    .sort((a, b) => a.index - b.index);
  return [...active, ...standby];
}

type MutableLobby = {
  cid: string | null;
  proposeMsgId: string | null;
  initiatorAddress: string | null;
  seats: CeremonySeatDecl[];
  terms: CeremonyTerms | null;
  expiresMs: number | null;
  participants: Map<string, Omit<CeremonyParticipant, "operatorIdHex">>;
  consents: Map<string, { consentDigest: string; sigHex: string; timestampMs: number; viaSnapshot: boolean }>;
  frozenDigest: string | null;
  submitted: { txHash: string; address: string } | null;
  warnings: string[];
};

function applyJoin(
  lobby: MutableLobby,
  args: {
    address: string;
    pubkeyHex: string;
    seat: CeremonySeatRef;
    timestampMs: number;
    viaSnapshot: boolean;
  },
): void {
  const decl = lobby.seats.find(
    (seat) => seat.role === args.seat.role && seat.index === args.seat.index,
  );
  if (!decl) {
    lobby.warnings.push(`join from ${args.address} targets an undeclared seat ${seatKey(args.seat)}`);
    return;
  }
  const pubkeyHex = normalizeHex(args.pubkeyHex);
  if (!isHexOfBytes(pubkeyHex, NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES)) {
    lobby.warnings.push(`join from ${args.address} carries a malformed consensus pubkey`);
    return;
  }
  // Envelope pubkey must derive the envelope sender address (defense in
  // depth; the Rust transport already enforces this on inbound verify).
  const derivedAddress = normalizeHex(mlDsa65AddressFromPublicKey(hexToBytes(pubkeyHex)));
  if (derivedAddress !== normalizeHex(args.address)) {
    lobby.warnings.push(`join sender ${args.address} does not match its envelope pubkey`);
    return;
  }
  const operatorIdHex = bytesToHex0x(operatorPubkeyHash(hexToBytes(pubkeyHex)));
  if (decl.operator_id && normalizeHex(decl.operator_id) !== operatorIdHex) {
    lobby.warnings.push(
      `join from ${args.address} rejected — seat ${seatKey(args.seat)} is pinned to a different operator id`,
    );
    return;
  }
  const wantedKey = seatKey(args.seat);
  for (const [address, participant] of lobby.participants) {
    if (address !== args.address && seatKey(participant.seat) === wantedKey) {
      lobby.warnings.push(
        `join from ${args.address} rejected — seat ${wantedKey} is already claimed`,
      );
      return;
    }
  }
  lobby.participants.set(args.address, {
    address: args.address,
    pubkeyHex,
    seat: { role: args.seat.role, index: args.seat.index },
    timestampMs: args.timestampMs,
    viaSnapshot: args.viaSnapshot,
  });
}

function applyPropose(
  lobby: MutableLobby,
  args: { msgId: string; sender: string; body: CeremonyProposeBody },
): boolean {
  if (lobby.proposeMsgId) {
    if (lobby.proposeMsgId !== args.msgId) {
      lobby.warnings.push("conflicting propose ignored — the first valid propose wins");
    }
    return false;
  }
  const error = validateProposeBody(args.body);
  if (error) {
    lobby.warnings.push(`propose rejected: ${error}`);
    return false;
  }
  lobby.cid = args.body.cid;
  lobby.proposeMsgId = args.msgId;
  lobby.initiatorAddress = args.sender;
  lobby.seats = ceremonySeatOrder(args.body.seats).map((seat) => ({
    role: seat.role,
    index: seat.index,
    operator_id: seat.operator_id ? normalizeHex(seat.operator_id) : "",
  }));
  lobby.terms = args.body.terms;
  lobby.expiresMs = args.body.expires_ms;
  return true;
}

/** Pure reduction of a ceremony channel's messages into lobby state. */
export function reduceCeremony(
  messages: ChatMessage[],
  options?: ReduceCeremonyOptions,
): CeremonyState {
  const verify = options?.verify ?? verifyCeremonyConsentSignature;
  const lobby: MutableLobby = {
    cid: null,
    proposeMsgId: null,
    initiatorAddress: null,
    seats: [],
    terms: null,
    expiresMs: null,
    participants: new Map(),
    consents: new Map(),
    frozenDigest: null,
    submitted: null,
    warnings: [],
  };

  const ordered = [...messages].sort((a, b) =>
    a.timestamp_ms === b.timestamp_ms
      ? a.msg_id.localeCompare(b.msg_id)
      : a.timestamp_ms - b.timestamp_ms,
  );

  for (const msg of ordered) {
    if (msg.verified === false) {
      lobby.warnings.push(`unverified envelope ${msg.msg_id} ignored`);
      continue;
    }
    const body = parseCeremonyBody(msg.body);
    if (!body) continue;
    if (lobby.cid && body.cid !== lobby.cid) {
      lobby.warnings.push(`message for foreign ceremony ${body.cid} ignored`);
      continue;
    }

    switch (body.t) {
      case "propose": {
        applyPropose(lobby, { msgId: msg.msg_id, sender: msg.sender_address, body });
        break;
      }
      case "snapshot": {
        const snap = body.state;
        const proposeBody = snap.propose.body;
        if (snap.propose.sender_address !== msg.sender_address) {
          lobby.warnings.push("snapshot rejected — sender is not the ceremony initiator");
          break;
        }
        if (lobby.proposeMsgId) {
          if (
            lobby.proposeMsgId !== snap.propose.msg_id ||
            lobby.initiatorAddress !== msg.sender_address
          ) {
            lobby.warnings.push("snapshot rejected — does not match the known propose");
            break;
          }
        } else {
          const accepted = applyPropose(lobby, {
            msgId: snap.propose.msg_id,
            sender: snap.propose.sender_address,
            body: proposeBody,
          });
          if (!accepted) break;
        }
        for (const join of snap.joins) {
          if (lobby.participants.has(join.sender_address)) continue;
          applyJoin(lobby, {
            address: join.sender_address,
            pubkeyHex: join.sender_pubkey_hex,
            seat: join.seat,
            timestampMs: join.timestamp_ms,
            viaSnapshot: true,
          });
        }
        for (const consent of snap.consents) {
          if (lobby.consents.has(consent.sender_address)) continue;
          const sigHex = normalizeHex(consent.sig);
          if (!isHexOfBytes(sigHex, FORM_CLUSTER_SIGNATURE_BYTES)) {
            lobby.warnings.push(
              `snapshot consent from ${consent.sender_address} has a malformed signature`,
            );
            continue;
          }
          lobby.consents.set(consent.sender_address, {
            consentDigest: normalizeHex(consent.consent_digest),
            sigHex,
            timestampMs: consent.timestamp_ms,
            viaSnapshot: true,
          });
        }
        if (snap.freeze?.consent_digest && !lobby.frozenDigest) {
          lobby.frozenDigest = normalizeHex(snap.freeze.consent_digest);
        }
        if (snap.submit && !lobby.submitted) {
          lobby.submitted = {
            txHash: snap.submit.tx_hash,
            address: snap.submit.sender_address,
          };
        }
        break;
      }
      case "join": {
        if (!lobby.proposeMsgId) {
          lobby.warnings.push(`join from ${msg.sender_address} before any propose ignored`);
          break;
        }
        if (body.ref !== lobby.proposeMsgId) {
          lobby.warnings.push(`join from ${msg.sender_address} references a stale propose`);
          break;
        }
        applyJoin(lobby, {
          address: msg.sender_address,
          pubkeyHex: msg.sender_pubkey_hex,
          seat: body.seat,
          timestampMs: msg.timestamp_ms,
          viaSnapshot: false,
        });
        break;
      }
      case "freeze": {
        if (!lobby.proposeMsgId || body.ref !== lobby.proposeMsgId) break;
        if (msg.sender_address !== lobby.initiatorAddress) {
          lobby.warnings.push("freeze from a non-initiator ignored");
          break;
        }
        lobby.frozenDigest = normalizeHex(body.consent_digest);
        break;
      }
      case "consent": {
        if (!lobby.proposeMsgId || body.ref !== lobby.proposeMsgId) break;
        const sigHex = normalizeHex(body.sig);
        if (!isHexOfBytes(sigHex, FORM_CLUSTER_SIGNATURE_BYTES)) {
          lobby.warnings.push(`consent from ${msg.sender_address} has a malformed signature`);
          break;
        }
        lobby.consents.set(msg.sender_address, {
          consentDigest: normalizeHex(body.consent_digest),
          sigHex,
          timestampMs: msg.timestamp_ms,
          viaSnapshot: false,
        });
        break;
      }
      case "withdraw": {
        if (!lobby.proposeMsgId || body.ref !== lobby.proposeMsgId) break;
        lobby.participants.delete(msg.sender_address);
        lobby.consents.delete(msg.sender_address);
        break;
      }
      case "submit": {
        if (!lobby.proposeMsgId || body.ref !== lobby.proposeMsgId) break;
        if (lobby.submitted) {
          lobby.warnings.push("extra submit message ignored — tx already recorded");
          break;
        }
        lobby.submitted = { txHash: body.tx_hash, address: msg.sender_address };
        break;
      }
      default:
        break;
    }
  }

  // -- derive roster, local digest, consent validity, readiness ---------

  const participants = [...lobby.participants.values()];
  const claimants = new Map<string, (typeof participants)[number]>();
  for (const participant of participants) {
    claimants.set(seatKey(participant.seat), participant);
  }
  const rosterComplete =
    lobby.seats.length === FORM_CLUSTER_MEMBER_COUNT &&
    lobby.seats.every((seat) => claimants.has(seatKey(seat)));

  let localDigest: string | null = null;
  if (rosterComplete) {
    const activePubkeys: string[] = [];
    const standbyPubkeys: string[] = [];
    for (const seat of lobby.seats) {
      const claimant = claimants.get(seatKey(seat));
      if (!claimant) continue;
      if (seat.role === "active") activePubkeys.push(claimant.pubkeyHex);
      else standbyPubkeys.push(claimant.pubkeyHex);
    }
    try {
      localDigest = computeCeremonyConsentDigestHex({
        activePubkeysHex: activePubkeys,
        standbyPubkeysHex: standbyPubkeys,
        // A charter is part of the terms: its presence (and every byte
        // of it) shifts the digest, staling all previous consents.
        charterHex: lobby.terms?.charter || undefined,
      });
    } catch (err) {
      lobby.warnings.push(
        `local digest recomputation failed: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  const digestMismatch =
    lobby.frozenDigest !== null &&
    localDigest !== null &&
    lobby.frozenDigest !== localDigest;

  const consents: CeremonyConsent[] = [];
  let validConsentCount = 0;
  for (const [address, consent] of lobby.consents) {
    const participant = lobby.participants.get(address);
    let status: CeremonyConsentStatus;
    if (!participant) {
      status = "no-seat";
    } else if (localDigest === null || consent.consentDigest !== localDigest) {
      status = "stale-digest";
    } else if (
      verify({
        pubkeyHex: participant.pubkeyHex,
        consentDigestHex: localDigest,
        signatureHex: consent.sigHex,
      })
    ) {
      status = "valid";
      validConsentCount += 1;
    } else {
      status = "invalid-signature";
    }
    consents.push({
      address,
      consentDigest: consent.consentDigest,
      sigHex: consent.sigHex,
      timestampMs: consent.timestampMs,
      viaSnapshot: consent.viaSnapshot,
      status,
    });
  }

  const ready =
    rosterComplete &&
    localDigest !== null &&
    !digestMismatch &&
    validConsentCount === FORM_CLUSTER_MEMBER_COUNT;

  return {
    cid: lobby.cid,
    proposeMsgId: lobby.proposeMsgId,
    initiatorAddress: lobby.initiatorAddress,
    seats: lobby.seats,
    terms: lobby.terms,
    expiresMs: lobby.expiresMs,
    participants: participants.map((participant) => ({
      ...participant,
      operatorIdHex: bytesToHex0x(operatorPubkeyHash(hexToBytes(participant.pubkeyHex))),
    })),
    consents,
    frozenDigest: lobby.frozenDigest,
    localDigest,
    digestMismatch,
    validConsentCount,
    ready,
    submitted: lobby.submitted,
    warnings: lobby.warnings,
  };
}

// ---- derived views ---------------------------------------------------

export type CeremonyRosterRow = {
  seat: CeremonySeatDecl;
  participant: CeremonyParticipant | null;
  consent: CeremonyConsent | null;
};

/** Roster rows in canonical order (active 0..6 then standby 0..2). */
export function ceremonyRoster(state: CeremonyState): CeremonyRosterRow[] {
  return state.seats.map((seat) => {
    const participant =
      state.participants.find(
        (candidate) =>
          candidate.seat.role === seat.role && candidate.seat.index === seat.index,
      ) ?? null;
    const consent = participant
      ? state.consents.find((candidate) => candidate.address === participant.address) ?? null
      : null;
    return { seat, participant, consent };
  });
}

/** Roster pubkeys in canonical order — null until all seats are claimed. */
export function ceremonyRosterPubkeys(
  state: CeremonyState,
): { activePubkeysHex: string[]; standbyPubkeysHex: string[] } | null {
  const rows = ceremonyRoster(state);
  if (rows.length !== FORM_CLUSTER_MEMBER_COUNT || rows.some((row) => !row.participant)) {
    return null;
  }
  return {
    activePubkeysHex: rows
      .filter((row) => row.seat.role === "active")
      .map((row) => row.participant?.pubkeyHex ?? ""),
    standbyPubkeysHex: rows
      .filter((row) => row.seat.role === "standby")
      .map((row) => row.participant?.pubkeyHex ?? ""),
  };
}

export function ceremonyExpired(state: CeremonyState, nowMs: number): boolean {
  return state.expiresMs !== null && nowMs >= state.expiresMs;
}

/** Whether `selfAddress` claims an ACTIVE seat (chain enforces
 *  caller_is_active on formCluster submit). */
export function isActiveCeremonyMember(state: CeremonyState, selfAddress: string | null): boolean {
  if (!selfAddress) return false;
  const self = normalizeHex(selfAddress);
  return state.participants.some(
    (participant) =>
      normalizeHex(participant.address) === self && participant.seat.role === "active",
  );
}

export function canSubmitCeremony(
  state: CeremonyState,
  selfAddress: string | null,
  nowMs: number,
): { allowed: boolean; reason: string | null } {
  if (state.submitted) {
    return { allowed: false, reason: `formCluster already submitted (${state.submitted.txHash})` };
  }
  if (ceremonyExpired(state, nowMs)) {
    return { allowed: false, reason: "this ceremony has expired — propose a fresh one" };
  }
  if (state.terms?.charter) {
    try {
      validateClusterCharterHex(state.terms.charter, { nowMs });
    } catch (err) {
      return {
        allowed: false,
        reason: `charter refuses submission: ${(err as Error)?.message ?? String(err)}`,
      };
    }
  }
  if (state.digestMismatch) {
    return {
      allowed: false,
      reason: "frozen digest does not match the locally recomputed digest — refuse to submit",
    };
  }
  if (!state.ready) {
    return {
      allowed: false,
      reason: `waiting on consents — ${state.validConsentCount} of ${FORM_CLUSTER_MEMBER_COUNT} verified`,
    };
  }
  if (!isActiveCeremonyMember(state, selfAddress)) {
    return {
      allowed: false,
      reason:
        "only an ACTIVE roster member may submit — the chain rejects formCluster from any other sender",
    };
  }
  return { allowed: true, reason: null };
}

/** Reducer output → the existing paste-box shapes (roster order, newline-joined). */
export function buildClusterFormInput(state: CeremonyState): ClusterFormInput | null {
  if (!state.ready || state.localDigest === null) return null;
  const rows = ceremonyRoster(state);
  const sigs: string[] = [];
  const active: string[] = [];
  const standby: string[] = [];
  for (const row of rows) {
    if (!row.participant || !row.consent || row.consent.status !== "valid") return null;
    if (row.seat.role === "active") active.push(row.participant.pubkeyHex);
    else standby.push(row.participant.pubkeyHex);
    sigs.push(row.consent.sigHex);
  }
  const charterHex = state.terms?.charter ? normalizeHex(state.terms.charter) : "";
  return {
    activePubkeysHex: active.join("\n"),
    standbyPubkeysHex: standby.join("\n"),
    signaturesHex: sigs.join("\n"),
    ...(charterHex ? { charterHex } : {}),
  };
}

/** Hand-off into the existing Operations drawer (preview → auth → execute). */
export function buildClusterFormOpRequest(state: CeremonyState): OpRequest | null {
  const input = buildClusterFormInput(state);
  if (!input || !state.localDigest) return null;
  const executor = input.charterHex
    ? "formCluster(bytes,bytes,bytes,bytes)"
    : "formCluster(bytes,bytes,bytes)";
  let charterDiff: { key: string; label: string; value: string }[] = [];
  if (input.charterHex) {
    try {
      const charter = decodeClusterCharterHex(input.charterHex);
      charterDiff = [
        {
          key: "charter",
          label: "Charter (V2)",
          value: `+ delegators ${(charter.delegatorShareBps / 100).toFixed(1)}% · consent expires ${new Date(charter.expiresMs).toISOString()}`,
        },
      ];
    } catch {
      charterDiff = [{ key: "charter", label: "Charter (V2)", value: "+ (malformed)" }];
    }
  }
  return {
    kind: "cluster-form",
    title: "Form cluster",
    sub: "Submit ceremony roster",
    intro: input.charterHex
      ? "Submits the ceremony room's fully consented formCluster(bytes,bytes,bytes,bytes) roster with its 30-byte economics charter: 10 operator seats, 7-of-10 threshold, with all ten ML-DSA-65 consent signatures over the charter-committing V2 digest. The drawer preflights through lyth_previewFormCluster before signing."
      : "Submits the ceremony room's fully consented formCluster(bytes,bytes,bytes) roster: 10 operator seats, 7-of-10 threshold, 7 active and 3 standby operators, with all ten ML-DSA-65 consent signatures collected live. The drawer preflights through lyth_previewFormCluster before signing.",
    icon: "FC",
    risk: "high",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign formation",
    effects: [
      "Validates exactly 7 active and 3 standby ML-DSA-65 consensus pubkeys.",
      "Verifies all ten roster consent signatures against the ceremony consent digest.",
      ...(input.charterHex
        ? [
            "Encodes the 30-byte economics charter (member shares, delegator share, consent expiry) — the signed V2 digest commits to these exact terms.",
          ]
        : []),
      "Preflights formCluster, then signs with the active operator's recovery phrase on compatible runtimes.",
    ],
    diff: [
      { key: "cluster", label: "Cluster", value: "+ roster proposal" },
      { key: "topology", label: "Topology", value: "7 active + 3 standby, 7-of-10" },
      ...charterDiff,
      { key: "digest", label: "Consent digest", value: state.localDigest },
    ],
    fields: [
      { key: "ceremony", label: "Ceremony", value: state.cid ?? "—" },
      { key: "digest", label: "Consent digest", value: state.localDigest },
      { key: "executor", label: "Executor", value: executor },
    ],
    clusterFormInput: input,
  };
}

/** Initiator re-broadcast payload for late joiners (no gossip backfill). */
export function buildCeremonySnapshotBody(state: CeremonyState): CeremonySnapshotBody | null {
  if (!state.cid || !state.proposeMsgId || !state.initiatorAddress || !state.terms) return null;
  return {
    t: "snapshot",
    cid: state.cid,
    state: {
      propose: {
        msg_id: state.proposeMsgId,
        sender_address: state.initiatorAddress,
        body: {
          v: CEREMONY_SCHEMA_VERSION,
          t: "propose",
          cid: state.cid,
          seats: state.seats,
          terms: state.terms,
          expires_ms: state.expiresMs ?? 0,
        },
      },
      joins: state.participants.map((participant) => ({
        sender_address: participant.address,
        sender_pubkey_hex: participant.pubkeyHex,
        seat: participant.seat,
        timestamp_ms: participant.timestampMs,
      })),
      consents: state.consents
        .filter((consent) => consent.status !== "no-seat")
        .map((consent) => ({
          sender_address: consent.address,
          consent_digest: consent.consentDigest,
          sig: consent.sigHex,
          timestamp_ms: consent.timestampMs,
        })),
      freeze: state.frozenDigest ? { consent_digest: state.frozenDigest } : null,
      submit: state.submitted
        ? { sender_address: state.submitted.address, tx_hash: state.submitted.txHash }
        : null,
    },
  };
}

/** Display helper — digest hex in 4-char groups (drops the 0x prefix). */
export function formatDigestGroups(digestHex: string): string {
  const clean = digestHex.replace(/^0x/iu, "");
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += 4) groups.push(clean.slice(i, i + 4));
  return groups.join(" ");
}

// ---- per-seat chain checks (lyth_operatorInfo) ------------------------

export type CeremonySeatChainStatus = {
  operatorIdHex: string;
  bonded: boolean | null;
  lifecycleState: string | null;
  error: string | null;
};

export type CeremonyOperatorInfoClient = {
  lythOperatorInfo(operatorId: string): Promise<{ bonded: boolean; lifecycleState: string }>;
};

/** Registered-but-unbonded operators fail formCluster on-chain — probe
 *  every claimed seat. Fail-soft per seat (RPC may not expose the read). */
export async function fetchCeremonySeatChainStatuses(
  client: CeremonyOperatorInfoClient,
  operatorIdsHex: string[],
): Promise<Record<string, CeremonySeatChainStatus>> {
  const out: Record<string, CeremonySeatChainStatus> = {};
  await Promise.all(
    operatorIdsHex.map(async (operatorIdHex) => {
      try {
        const info = await client.lythOperatorInfo(operatorIdHex);
        out[operatorIdHex] = {
          operatorIdHex,
          bonded: info.bonded,
          lifecycleState: info.lifecycleState,
          error: null,
        };
      } catch (err) {
        out[operatorIdHex] = {
          operatorIdHex,
          bonded: null,
          lifecycleState: null,
          error: (err as Error)?.message ?? String(err),
        };
      }
    }),
  );
  return out;
}

// ---- JSON export / import fallback ------------------------------------

export type CeremonyExportSeat = {
  role: CeremonySeatRole;
  index: number;
  operator_id: string;
  pubkey_hex: string;
  address: string;
};

export type CeremonyExportConsent = {
  role: CeremonySeatRole;
  index: number;
  sig_hex: string;
};

export type CeremonyExportPayload = {
  schema: typeof CEREMONY_EXPORT_SCHEMA;
  cid: string;
  consent_digest: string;
  terms: CeremonyTerms;
  seats: CeremonyExportSeat[];
  consents: CeremonyExportConsent[];
};

export type CeremonyExportFile = CeremonyExportPayload & { export_hash: string };

export function ceremonyExportHash(payload: CeremonyExportPayload): string {
  return nobleBytesToHex(sha256(new TextEncoder().encode(ceremonyCanonicalJson(payload))));
}

/** Serialize a fully consented ceremony for offline hand-off. Byte-compatible
 *  with the shipped paste-box via `importCeremonyJson().input`. */
export function exportCeremonyJson(state: CeremonyState): string {
  if (!state.ready || !state.cid || !state.localDigest || !state.terms) {
    throw new Error("export requires a ready ceremony — 10 verified consents over the current digest");
  }
  const rows = ceremonyRoster(state);
  const seats: CeremonyExportSeat[] = [];
  const consents: CeremonyExportConsent[] = [];
  for (const row of rows) {
    if (!row.participant || !row.consent || row.consent.status !== "valid") {
      throw new Error("export requires every seat claimed and consented");
    }
    seats.push({
      role: row.seat.role,
      index: row.seat.index,
      operator_id: row.participant.operatorIdHex,
      pubkey_hex: row.participant.pubkeyHex,
      address: row.participant.address,
    });
    consents.push({
      role: row.seat.role,
      index: row.seat.index,
      sig_hex: row.consent.sigHex,
    });
  }
  const payload: CeremonyExportPayload = {
    schema: CEREMONY_EXPORT_SCHEMA,
    cid: state.cid,
    consent_digest: state.localDigest,
    terms: state.terms,
    seats,
    consents,
  };
  const file: CeremonyExportFile = { ...payload, export_hash: ceremonyExportHash(payload) };
  return JSON.stringify(file, null, 2);
}

export type CeremonyImportResult = {
  cid: string;
  consentDigestHex: string;
  terms: CeremonyTerms;
  seats: CeremonyExportSeat[];
  /** Prefill for the existing formCluster paste-box / ops drawer. */
  input: ClusterFormInput;
};

/** Parse + fully validate an exported ceremony JSON. Every consent
 *  signature is verified against the recomputed digest BEFORE anything
 *  is offered for prefill; any failure throws. */
export function importCeremonyJson(
  json: string,
  options?: { verify?: CeremonyVerifyFn },
): CeremonyImportResult {
  const verify = options?.verify ?? verifyCeremonyConsentSignature;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("import is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("import is not a ceremony export");
  const file = parsed as Partial<CeremonyExportFile>;
  if (file.schema !== CEREMONY_EXPORT_SCHEMA) {
    throw new Error(`import schema must be ${CEREMONY_EXPORT_SCHEMA}`);
  }
  if (
    typeof file.cid !== "string" ||
    typeof file.consent_digest !== "string" ||
    !isTerms(file.terms) ||
    !Array.isArray(file.seats) ||
    !Array.isArray(file.consents) ||
    typeof file.export_hash !== "string"
  ) {
    throw new Error("import is missing required ceremony export fields");
  }
  const payload: CeremonyExportPayload = {
    schema: CEREMONY_EXPORT_SCHEMA,
    cid: file.cid,
    consent_digest: file.consent_digest,
    terms: file.terms,
    seats: file.seats as CeremonyExportSeat[],
    consents: file.consents as CeremonyExportConsent[],
  };
  if (ceremonyExportHash(payload) !== file.export_hash) {
    throw new Error("import integrity hash mismatch — the export was modified");
  }
  const charterTermsError = validateCeremonyCharterTerms(payload.terms);
  if (charterTermsError) {
    throw new Error(`import charter terms rejected: ${charterTermsError}`);
  }
  if (payload.seats.length !== FORM_CLUSTER_MEMBER_COUNT) {
    throw new Error(`import must carry exactly ${FORM_CLUSTER_MEMBER_COUNT} seats`);
  }
  if (payload.consents.length !== FORM_CLUSTER_MEMBER_COUNT) {
    throw new Error(`import must carry exactly ${FORM_CLUSTER_MEMBER_COUNT} consents`);
  }

  const ordered = [...payload.seats].sort((a, b) =>
    a.role === b.role ? a.index - b.index : a.role === "active" ? -1 : 1,
  );
  const active = ordered.filter((seat) => seat.role === "active");
  const standby = ordered.filter((seat) => seat.role === "standby");
  if (active.length !== FORM_CLUSTER_ACTIVE_COUNT || standby.length !== FORM_CLUSTER_STANDBY_COUNT) {
    throw new Error("import roster must be 7 active + 3 standby seats");
  }
  for (const seat of ordered) {
    if (!isHexOfBytes(normalizeHex(seat.pubkey_hex), NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES)) {
      throw new Error(`import seat ${seat.role}:${seat.index} pubkey is malformed`);
    }
  }
  const importCharterHex = payload.terms.charter ? normalizeHex(payload.terms.charter) : "";
  const digest = computeCeremonyConsentDigestHex({
    activePubkeysHex: active.map((seat) => seat.pubkey_hex),
    standbyPubkeysHex: standby.map((seat) => seat.pubkey_hex),
    charterHex: importCharterHex || undefined,
  });
  if (digest !== normalizeHex(payload.consent_digest)) {
    throw new Error("import consent digest does not match the recomputed roster digest");
  }
  const sigs: string[] = [];
  for (const seat of ordered) {
    const consent = payload.consents.find(
      (candidate) => candidate.role === seat.role && candidate.index === seat.index,
    );
    if (!consent || !isHexOfBytes(normalizeHex(consent.sig_hex), FORM_CLUSTER_SIGNATURE_BYTES)) {
      throw new Error(`import is missing a valid consent for seat ${seat.role}:${seat.index}`);
    }
    const ok = verify({
      pubkeyHex: seat.pubkey_hex,
      consentDigestHex: digest,
      signatureHex: consent.sig_hex,
    });
    if (!ok) {
      throw new Error(
        `import consent signature for seat ${seat.role}:${seat.index} failed ML-DSA-65 verification`,
      );
    }
    sigs.push(normalizeHex(consent.sig_hex));
  }
  return {
    cid: payload.cid,
    consentDigestHex: digest,
    terms: payload.terms,
    seats: ordered,
    input: {
      activePubkeysHex: active.map((seat) => normalizeHex(seat.pubkey_hex)).join("\n"),
      standbyPubkeysHex: standby.map((seat) => normalizeHex(seat.pubkey_hex)).join("\n"),
      signaturesHex: sigs.join("\n"),
      ...(importCharterHex ? { charterHex: importCharterHex } : {}),
    },
  };
}

// ---- transport (direct Tauri invoke, graceful degradation) -------------

export class CeremonyTransportUnavailableError extends Error {
  constructor(message: string = CEREMONY_TRANSPORT_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "CeremonyTransportUnavailableError";
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

async function invokeCeremonyCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!inTauriWebview()) {
    throw new CeremonyTransportUnavailableError(
      "Ceremony transport requires Monarch Desktop.",
    );
  }
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    if (isMissingCommandError(err)) {
      throw new CeremonyTransportUnavailableError();
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Initialize chat (existing command) — null when the operator key isn't
 *  stored yet, mirroring the bridge's expected pre-setup state. */
export async function ceremonyChatInitialize(args?: {
  rpcEndpoint?: string;
  bootstrapPeers?: string[];
}): Promise<ChatInitResult | null> {
  try {
    return await invokeCeremonyCommand<ChatInitResult>("chat_initialize", {
      rpcEndpoint: args?.rpcEndpoint ?? null,
      bootstrapPeers: args?.bootstrapPeers ?? null,
    });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    if (/mnemonic not in keychain/iu.test(message)) return null;
    throw err;
  }
}

/** Join (or create) a ceremony lobby channel — registered-operator gated Rust-side. */
export async function subscribeCeremonyChannel(args: {
  ceremonyId: string;
  name?: string;
}): Promise<ChatChannel> {
  return await invokeCeremonyCommand<ChatChannel>("chat_subscribe_ceremony", {
    ceremonyId: args.ceremonyId,
    name: args.name ?? null,
  });
}

/** Dial lobby peers post-init (cluster-less formers never mesh otherwise). */
export async function dialCeremonyPeers(addrs: string[]): Promise<void> {
  await invokeCeremonyCommand<void>("chat_dial_peers", { addrs });
}

export type CeremonyConsentSignResult = {
  digest_hex: string;
  signature_hex: string;
};

/** Rust-side consent signing: the digest is re-derived in Rust from the
 *  roster (and the 30-byte charter when present — V2 domain) and signed
 *  with the keychain identity — there is deliberately no raw
 *  sign-this-digest surface. ALWAYS compare the returned `digest_hex`
 *  against the locally recomputed digest before publishing. */
export async function signCeremonyConsent(args: {
  activePubkeysHex: string[];
  standbyPubkeysHex: string[];
  charterHex?: string;
}): Promise<CeremonyConsentSignResult> {
  return await invokeCeremonyCommand<CeremonyConsentSignResult>(
    "chat_sign_form_cluster_consent",
    {
      activePubkeysHex: args.activePubkeysHex,
      standbyPubkeysHex: args.standbyPubkeysHex,
      charterHex: args.charterHex ?? null,
    },
  );
}

/** Publish a ceremony body over the signed chat envelope transport. */
export async function sendCeremonyBody(
  channelId: string,
  body: CeremonyMessageBody,
): Promise<ChatMessage> {
  const json = JSON.stringify(body);
  if (new TextEncoder().encode(json).length > CEREMONY_MAX_BODY_BYTES) {
    throw new Error(
      `ceremony message exceeds the ${CEREMONY_MAX_BODY_BYTES}-byte channel body cap`,
    );
  }
  return await invokeCeremonyCommand<ChatMessage>("chat_send_message", {
    channelId,
    clusterId: CEREMONY_SENTINEL_CLUSTER_ID,
    body: json,
  });
}

export async function fetchCeremonyMessages(
  channelId: string,
  limit?: number,
): Promise<ChatMessage[]> {
  return await invokeCeremonyCommand<ChatMessage[]>("chat_get_messages", {
    channelId,
    limit: limit ?? null,
  });
}

/** Live tail for the ceremony channel. The ceremony view owns its OWN
 *  subscription — useChat drops events for non-active channels. */
export async function listenCeremonyMessages(
  channelId: string,
  onMessage: (message: ChatMessage) => void,
): Promise<UnlistenFn> {
  if (!inTauriWebview()) return () => {};
  return await listen<ChatMessage>(
    `monarch://chat/message/${channelId}`,
    (event) => onMessage(event.payload),
  );
}
