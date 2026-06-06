// Operator chat — shared types over the Tauri boundary.
//
// These mirror the serde shapes the Rust `chat` / `chat_store` modules
// emit (`ChannelRecord`, `MessageRecord`, `ChatInitResult`). The bridge
// helpers in `bridge.ts` invoke the `chat_*` commands and listen on the
// `monarch://chat/message/{channel_id}` event; `useChat.ts` folds them
// into the Chat view's state.
//
// Phase 1 (MVP) covers cluster channels only. DMs, reactions, and
// attachments are later phases — the optional fields below are reserved
// for that growth but unused today.

/** A persisted chat channel (Rust `ChannelRecord`). */
export type ChatChannel = {
  channel_id: string;
  name: string;
  sub: string;
  /** Always `"cluster"` in the MVP. */
  kind: "cluster" | "dm" | "broadcast" | string;
  cluster_id: number;
  subscribed: boolean;
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
