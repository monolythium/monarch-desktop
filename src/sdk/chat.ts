// Operator chat — shared types over the Tauri boundary.
//
// These mirror the serde shapes the Rust `chat` / `chat_store` modules
// emit (`ChannelRecord`, `MessageRecord`, `ChatInitResult`). The bridge
// helpers in `bridge.ts` invoke the `chat_*` commands and listen on the
// `monarch://chat/message/{channel_id}` event; `useChat.ts` folds them
// into the Chat view's state.
//
// Channel kinds: `cluster` (one channel per cluster, membership-gated)
// and `ceremony` (formCluster lobby, registered-operator-gated, sentinel
// cluster_id = -1). DMs, reactions, and attachments are later phases —
// the optional fields below are reserved for that growth but unused
// today.

/** A persisted chat channel (Rust `ChannelRecord`). */
export type ChatChannel = {
  channel_id: string;
  name: string;
  sub: string;
  /** `"cluster"` or `"ceremony"` today (`dm`/`broadcast` reserved). */
  kind: "cluster" | "ceremony" | "dm" | "broadcast" | string;
  /** Numeric cluster id; the sentinel `-1` for ceremony channels. */
  cluster_id: number;
  subscribed: boolean;
  /** Timestamp (ms) of the newest message marked read (`chat_mark_read`). */
  last_read_ts: number;
  /** Inbound messages newer than `last_read_ts` (computed on read). */
  unread_count: number;
};

/** A persisted, signature-verified message (Rust `MessageRecord`). */
export type ChatMessage = {
  msg_id: string;
  channel_id: string;
  cluster_id: number;
  /** `0x`-prefixed 20-byte operator address (BLAKE3 of the ML-DSA-65 key). */
  sender_address: string;
  /** Hex ML-DSA-65 public key used to verify the signed envelope. */
  sender_pubkey_hex: string;
  body: string;
  timestamp_ms: number;
  /** Hex nonce included in the signed envelope digest. */
  nonce_hex: string;
  signature_hex: string;
  /** True when the ML-DSA-65 signature verified locally on receipt. */
  verified: boolean;
  /** True when this is the operator's own message. */
  from_me: boolean;
};

/**
 * One roster member's display identity (Rust `MemberMonikerRecord`).
 * The address is bech32m `mono1…` — never raw hex — per ADR-0038.
 */
export type ChatMemberMoniker = {
  /** 32-byte operator id (BLAKE3 of the consensus pubkey), hex. */
  operator_id: string;
  /** bech32m `mono1…` display address. */
  address: string;
  /** On-chain moniker, when the operator has set one. */
  moniker: string | null;
};

/**
 * Result of `chat_sign_form_cluster_consent` (Rust
 * `FormClusterConsentSignature`). The BLAKE3 consent digest is derived
 * in Rust from the structured roster — never supplied by the webview.
 */
export type ChatFormClusterConsentSignature = {
  /** Hex BLAKE3 consent digest the signature covers (32 bytes). */
  digest_hex: string;
  /** Hex ML-DSA-65 signature (3309 bytes) by the operator key. */
  signature_hex: string;
};

/** Result of `chat_initialize` — the derived operator identity. */
export type ChatInitResult = {
  /** `0x`-prefixed 20-byte operator chat address. */
  address_hex: string;
  /** Hex ML-DSA-65 public key gossiped on every message. */
  public_key_hex: string;
  rpc_endpoint: string;
  /** Local libp2p listen multiaddrs, including `/p2p/<peer-id>`, for e2e/bootstrap discovery. */
  listen_addresses?: string[];
};
