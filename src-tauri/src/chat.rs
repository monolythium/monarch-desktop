// Operator chat — Phase 1 MVP.
//
// Decoupled from mono-core consensus. This module runs a minimal libp2p
// node inside the Tauri backend and gossips signed operator-to-operator
// messages on per-cluster topics (`cluster-{cluster_id}`). The only
// chain interaction is READING cluster status from the node-registry over
// the existing RPC endpoint. Runtime join, send, and inbound persistence
// fail closed unless the signed sender address is proven against the
// active cluster roster through `lyth_clusterStatus` plus
// `lyth_operatorInfo`.
//
// Signing identity: we reuse the operator's existing PQM-1 (ML-DSA-65)
// mnemonic from the OS keychain (account `operator:mnemonic`, the same
// key the node-registry register flow signs with — see
// `src/sdk/register.ts`). We do NOT mint a new key. The PQM-1 →
// ML-DSA-65 derivation here is a byte-faithful port of the TS SDK's
// `pqm1MnemonicToMlDsa65Seed` / `mlDsa65AddressBytes`:
//
//   payload  = bip39_entropy(mnemonic)            // 32 bytes: [0x01][0x01][30B]
//   seed     = SHAKE256("monolythium.pqm1.v1.mldsa65" ‖ payload, 32)
//   (pk, sk) = ML-DSA-65.keygen_from_seed(seed)
//   address  = BLAKE3("MONO_ADDRESS_BLAKE3_20_V1" ‖ be16(1001) ‖ pk)[..20]
//
// (A round-trip equivalence test against a known mnemonic lives in the
// `tests` module; the canonical reference is the TS SDK.)
//
// Message envelope (canonical for signing): the body fields are encoded
// deterministically, keccak256-hashed, and the digest is ML-DSA-65
// signed. The libp2p libp2p layer carries the wire JSON; verification
// re-derives the digest and checks the signature against the embedded
// sender public key, then confirms the derived address matches the
// claimed `sender_address`.
//
// Deferred beyond the current cluster-channel surface: DMs
// (request-response), the challenge-sign login flow, history backfill,
// attachments, reactions, and E2E encryption.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use libp2p::futures::StreamExt;
use libp2p::gossipsub::{self, IdentTopic, MessageAuthenticity, ValidationMode};
use libp2p::multiaddr::Protocol;
use libp2p::swarm::SwarmEvent;
use libp2p::{noise, tcp, yamux, Multiaddr, Swarm};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use tauri::{AppHandle, Emitter, Manager, State};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, Mutex};
use zeroize::Zeroizing;

use crate::chat_store::{ChannelRecord, ChatStore, MessageRecord};
use crate::keychain;

// ---- constants (mirror the TS SDK) --------------------------------

/// Keychain account that holds the operator PQM-1 mnemonic. Identical
/// to `KEYCHAIN_ACCOUNTS.operatorMnemonic` on the React side.
const OPERATOR_MNEMONIC_ACCOUNT: &str = "operator:mnemonic";

/// PQM-1 → ML-DSA-65 KDF domain (SDK `PQM1_V1_MLDSA65_DOMAIN_TAG`).
const PQM1_DOMAIN: &[u8] = b"monolythium.pqm1.v1.mldsa65";
/// Address derivation domain (SDK `ADDRESS_DERIVATION_DOMAIN`).
const ADDRESS_DOMAIN: &[u8] = b"MONO_ADDRESS_BLAKE3_20_V1";
/// Standard algorithm number for ML-DSA-65 (SDK `STANDARD_ALGO_NUMBER_ML_DSA_65`).
const STD_ALGO_NUMBER_ML_DSA_65: u16 = 1001;
/// PQM-1 payload byte length (algo + version + 30B entropy).
const PQM1_PAYLOAD_LEN: usize = 32;
/// ML-DSA-65 seed length fed to keygen.
const ML_DSA_65_SEED_LEN: usize = 32;
/// PQM-1 algo tag for ML-DSA-65.
const PQM1_ALGO_TAG_MLDSA65: u8 = 1;
/// PQM-1 v1 version byte.
const PQM1_VERSION_V1: u8 = 1;

/// Max body size accepted on send / receive (design spec: ≤4 KB).
const MAX_BODY_BYTES: usize = 4096;
/// How many recent messages a `chat_get_messages` call returns.
const DEFAULT_MESSAGE_LIMIT: i64 = 500;

// ---- errors --------------------------------------------------------

#[derive(Debug, Error)]
pub enum ChatError {
    #[error("chat: operator mnemonic not in keychain — store it under monarch-desktop/operator:mnemonic first")]
    MissingMnemonic,
    #[error("chat: invalid operator mnemonic: {0}")]
    BadMnemonic(String),
    #[error("chat: store error: {0}")]
    Store(String),
    #[error("chat: not initialized — call chat_initialize first")]
    NotInitialized,
    #[error("chat: libp2p error: {0}")]
    Libp2p(String),
    #[error("chat: message body exceeds {MAX_BODY_BYTES} bytes")]
    BodyTooLarge,
    #[error("chat: channel {0} is not subscribed for cluster {1}")]
    NotSubscribed(String, i64),
    #[error("chat: channel {0} does not match cluster {1}")]
    ChannelClusterMismatch(String, i64),
    #[error("chat: not a member of cluster {0}")]
    NotMember(i64),
    #[error("chat: membership read failed: {0}")]
    Membership(String),
    #[error("chat: io error: {0}")]
    Io(String),
}

impl From<crate::chat_store::ChatStoreError> for ChatError {
    fn from(e: crate::chat_store::ChatStoreError) -> Self {
        ChatError::Store(e.to_string())
    }
}

// ---- signing identity (PQM-1 → ML-DSA-65) -------------------------

/// The operator's chat signing identity, derived from the keychain
/// mnemonic. Holds the ML-DSA-65 keypair plus the derived 20-byte
/// address (hex). The private key is dropped (and the seed zeroized)
/// when this is dropped at app teardown.
pub struct ChatIdentity {
    signing_key: fips204::ml_dsa_65::PrivateKey,
    public_key_bytes: Vec<u8>,
    /// `0x`-prefixed 20-byte address, matching the SDK's hex address.
    address_hex: String,
}

impl ChatIdentity {
    /// Derive the identity from the operator's PQM-1 mnemonic. Byte-for-
    /// byte equivalent to the TS SDK's `pqm1MnemonicToMlDsa65Backend`.
    pub fn from_mnemonic(mnemonic: &str) -> Result<Self, ChatError> {
        use fips204::traits::{KeyGen, SerDes};

        // BIP-39 mnemonic → 32-byte PQM-1 payload. The PQM-1 payload IS
        // the bip39 entropy (algo + version + 30B), so `to_entropy`
        // returns the payload directly.
        let parsed = bip39::Mnemonic::parse_normalized(mnemonic)
            .map_err(|e| ChatError::BadMnemonic(e.to_string()))?;
        let payload = parsed.to_entropy();
        if payload.len() != PQM1_PAYLOAD_LEN {
            return Err(ChatError::BadMnemonic(format!(
                "PQM-1 payload must be {PQM1_PAYLOAD_LEN} bytes, got {}",
                payload.len()
            )));
        }
        if payload[0] != PQM1_ALGO_TAG_MLDSA65 || payload[1] != PQM1_VERSION_V1 {
            return Err(ChatError::BadMnemonic(
                "MetaMask / BIP-32 seed phrases are NOT compatible — use a PQM-1 (ML-DSA-65) mnemonic".to_string(),
            ));
        }
        let payload = Zeroizing::new(payload);

        // seed = SHAKE256(domain ‖ payload, dkLen = 32)
        let seed = shake256_32(PQM1_DOMAIN, &payload);
        let mut xi = [0u8; ML_DSA_65_SEED_LEN];
        xi.copy_from_slice(&seed);

        let (pk, sk) = fips204::ml_dsa_65::KG::keygen_from_seed(&xi);
        // Zeroize the seed copy now that the keypair is materialized.
        xi.iter_mut().for_each(|b| *b = 0);

        let public_key_bytes = pk.into_bytes().to_vec();
        let address_hex = derive_address_hex(&public_key_bytes);

        Ok(Self {
            signing_key: sk,
            public_key_bytes,
            address_hex,
        })
    }

    /// Sign an arbitrary digest with the operator key. ML-DSA-65 `try_sign`
    /// signs the message bytes directly (empty context).
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, ChatError> {
        use fips204::traits::Signer;
        let sig = self
            .signing_key
            .try_sign(message, &[])
            .map_err(|e| ChatError::Libp2p(format!("ml-dsa sign failed: {e}")))?;
        Ok(sig.to_vec())
    }

    pub fn address_hex(&self) -> &str {
        &self.address_hex
    }

    pub fn public_key_hex(&self) -> String {
        bytes_to_hex(&self.public_key_bytes)
    }
}

/// SHAKE256(domain ‖ payload) truncated/extended to 32 bytes.
fn shake256_32(domain: &[u8], payload: &[u8]) -> [u8; 32] {
    use sha3::digest::{ExtendableOutput, Update, XofReader};
    let mut hasher = sha3::Shake256::default();
    hasher.update(domain);
    hasher.update(payload);
    let mut reader = hasher.finalize_xof();
    let mut out = [0u8; 32];
    reader.read(&mut out);
    out
}

/// address = BLAKE3(ADDRESS_DOMAIN ‖ be16(algo) ‖ pubkey)[..20], hex.
fn derive_address_hex(public_key_bytes: &[u8]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(ADDRESS_DOMAIN);
    hasher.update(&STD_ALGO_NUMBER_ML_DSA_65.to_be_bytes());
    hasher.update(public_key_bytes);
    let hash = hasher.finalize();
    bytes_to_hex(&hash.as_bytes()[..20])
}

/// Verify an envelope's signature against its embedded public key, and
/// confirm the derived address matches the claimed `sender_address`.
fn verify_envelope(env: &ChatEnvelope) -> bool {
    use fips204::traits::{SerDes, Verifier};

    if env.body.len() > MAX_BODY_BYTES {
        return false;
    }
    if env.channel_id != channel_id_for_cluster(env.cluster_id) {
        return false;
    }
    let Some(pk_bytes) = hex_to_bytes(&env.sender_pubkey_hex) else {
        return false;
    };
    // The claimed address must be the one derived from the pubkey.
    // Normalize both sides (derive returns `0x`-prefixed; the envelope
    // address may or may not carry the prefix).
    if normalize_hex(&derive_address_hex(&pk_bytes)) != normalize_hex(&env.sender_address) {
        return false;
    }
    let pk_arr: [u8; fips204::ml_dsa_65::PK_LEN] = match pk_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let Ok(pk) = fips204::ml_dsa_65::PublicKey::try_from_bytes(pk_arr) else {
        return false;
    };
    let Some(sig_bytes) = hex_to_bytes(&env.signature_hex) else {
        return false;
    };
    let sig_arr: [u8; fips204::ml_dsa_65::SIG_LEN] = match sig_bytes.try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let digest = env.signing_digest();
    if normalize_hex(&message_id_for_digest(&digest)) != normalize_hex(&env.msg_id) {
        return false;
    }
    pk.verify(&digest, &sig_arr, &[])
}

fn message_id_for_digest(digest: &[u8; 32]) -> String {
    let mut h = Keccak256::new();
    h.update(digest);
    bytes_to_hex(&h.finalize())
}

// ---- envelope ------------------------------------------------------

/// Wire envelope gossiped over a cluster topic. Mirrors the design
/// spec's message envelope. `signing_digest()` produces the canonical
/// bytes that are keccak256-hashed and ML-DSA-65 signed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatEnvelope {
    /// Stable message id (keccak256 of the signing digest, hex). Used
    /// for dedupe and as the SQLite primary-key component.
    pub msg_id: String,
    pub channel_id: String,
    pub cluster_id: i64,
    /// `0x`-prefixed 20-byte operator address (BLAKE3 of the pubkey).
    pub sender_address: String,
    /// Hex ML-DSA-65 public key — carried so receivers can verify
    /// without a key directory. The claimed `sender_address` MUST equal
    /// the address derived from this key (checked in `verify_envelope`).
    pub sender_pubkey_hex: String,
    pub timestamp_ms: i64,
    pub body: String,
    /// Random per-message nonce (hex) to defeat replay of identical
    /// bodies at the same timestamp.
    pub nonce_hex: String,
    /// Hex ML-DSA-65 signature over `signing_digest()`.
    pub signature_hex: String,
}

impl ChatEnvelope {
    /// Canonical signing digest: keccak256 over the length-prefixed
    /// concatenation of the signed fields. Deterministic and
    /// language-independent (the TS side would mirror this exact layout
    /// if/when it gossips — for the MVP only this Rust node gossips).
    fn signing_digest(&self) -> [u8; 32] {
        let mut hasher = Keccak256::new();
        for field in [
            self.channel_id.as_bytes(),
            self.sender_address.as_bytes(),
            self.sender_pubkey_hex.as_bytes(),
            self.body.as_bytes(),
            self.nonce_hex.as_bytes(),
        ] {
            hasher.update((field.len() as u64).to_be_bytes());
            hasher.update(field);
        }
        hasher.update(self.cluster_id.to_be_bytes());
        hasher.update(self.timestamp_ms.to_be_bytes());
        hasher.finalize().into()
    }

    fn to_record(&self, from_me: bool) -> MessageRecord {
        MessageRecord {
            msg_id: self.msg_id.clone(),
            channel_id: self.channel_id.clone(),
            cluster_id: self.cluster_id,
            sender_address: self.sender_address.clone(),
            sender_pubkey_hex: self.sender_pubkey_hex.clone(),
            body: self.body.clone(),
            timestamp_ms: self.timestamp_ms,
            nonce_hex: self.nonce_hex.clone(),
            signature_hex: self.signature_hex.clone(),
            verified: true,
            from_me,
        }
    }
}

fn envelope_from_record(record: &MessageRecord) -> ChatEnvelope {
    ChatEnvelope {
        msg_id: record.msg_id.clone(),
        channel_id: record.channel_id.clone(),
        cluster_id: record.cluster_id,
        sender_address: record.sender_address.clone(),
        sender_pubkey_hex: record.sender_pubkey_hex.clone(),
        timestamp_ms: record.timestamp_ms,
        body: record.body.clone(),
        nonce_hex: record.nonce_hex.clone(),
        signature_hex: record.signature_hex.clone(),
    }
}

fn reverify_message_record(mut record: MessageRecord) -> MessageRecord {
    record.verified = record.verified && verify_envelope(&envelope_from_record(&record));
    record
}

/// Channel id for a cluster: `cluster-{cluster_id}` (design spec).
pub fn channel_id_for_cluster(cluster_id: i64) -> String {
    format!("cluster-{cluster_id}")
}

/// gossipsub topic for a cluster channel.
fn topic_for_channel(channel_id: &str) -> IdentTopic {
    IdentTopic::new(channel_id)
}

// ---- swarm command channel ----------------------------------------

/// Commands the Tauri command handlers push to the swarm event loop.
/// The loop owns the `Swarm` exclusively; everything else talks to it
/// through this channel so we never need a lock around the swarm.
enum SwarmCommand {
    Subscribe(String),
    Unsubscribe(String),
    Publish { channel_id: String, bytes: Vec<u8> },
}

#[derive(Debug)]
enum InboundAccept {
    Accepted(MessageRecord),
    Ignored,
    InvalidSignature,
}

#[derive(Debug)]
enum InboundPreflight {
    Accept,
    Ignored,
    InvalidSignature,
}

// ---- network behaviour --------------------------------------------

// Single-behaviour swarm for the MVP: gossipsub only. Discovery (mDNS /
// kad) and DM request-response are Phase-2 additions; keeping the
// behaviour to one field keeps the event loop trivial.

// ---- manager (Tauri state) ----------------------------------------

pub struct ChatManagerInner {
    /// Local persistence. `None` until `chat_initialize`.
    store: Option<ChatStore>,
    /// Operator signing identity. `None` until `chat_initialize`.
    identity: Option<Arc<ChatIdentity>>,
    /// Channel to the swarm event loop. `None` until `chat_initialize`.
    swarm_tx: Option<mpsc::UnboundedSender<SwarmCommand>>,
    /// RPC endpoint used for the live membership read.
    rpc_endpoint: String,
    listen_addresses: Vec<String>,
    initialized: bool,
}

impl ChatManagerInner {
    pub fn new() -> Self {
        Self {
            store: None,
            identity: None,
            swarm_tx: None,
            rpc_endpoint: default_rpc_endpoint(),
            listen_addresses: Vec::new(),
            initialized: false,
        }
    }
}

impl Default for ChatManagerInner {
    fn default() -> Self {
        Self::new()
    }
}

pub type ChatState = Arc<Mutex<ChatManagerInner>>;

/// Default RPC endpoint — mirrors `src/sdk/client.ts::FALLBACK_ENDPOINT`.
/// Overridable via the `TAURI_RPC_ENDPOINT` / `VITE_RPC_ENDPOINT` env at
/// build time (the React side passes the resolved endpoint to
/// `chat_initialize`).
fn default_rpc_endpoint() -> String {
    std::env::var("TAURI_RPC_ENDPOINT")
        .or_else(|_| std::env::var("VITE_RPC_ENDPOINT"))
        .unwrap_or_else(|_| "http://127.0.0.1:8545".to_string())
}

fn parse_bootstrap_peer_list(raw: &str) -> Vec<String> {
    raw.split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
        .filter(|peer| !peer.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn env_bootstrap_peers() -> Vec<String> {
    std::env::var("TAURI_CHAT_BOOTSTRAP_PEERS")
        .or_else(|_| std::env::var("VITE_CHAT_BOOTSTRAP_PEERS"))
        .map(|raw| parse_bootstrap_peer_list(&raw))
        .unwrap_or_default()
}

// ---- membership gating --------------------------------------------

async fn rpc_json_result(
    rpc_endpoint: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, ChatError> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });
    let client = reqwest::Client::new();
    let resp = client
        .post(rpc_endpoint)
        .header("content-type", "application/json")
        .json(&body)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| ChatError::Membership(e.to_string()))?;
    let value: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ChatError::Membership(e.to_string()))?;

    if let Some(error) = value.get("error") {
        return Err(ChatError::Membership(format!("{method}: {error}")));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| ChatError::Membership(format!("{method}: missing result")))
}

/// Read the live cluster member set from the node-registry via
/// `lyth_clusterStatus`. Returns the member operator ids.
async fn fetch_cluster_member_ids(
    rpc_endpoint: &str,
    cluster_id: i64,
) -> Result<Vec<String>, ChatError> {
    let value = rpc_json_result(
        rpc_endpoint,
        "lyth_clusterStatus",
        serde_json::json!([cluster_id]),
    )
    .await?;

    let members = value
        .get("members")
        .and_then(|m| m.as_array())
        .ok_or_else(|| ChatError::Membership("lyth_clusterStatus: missing members".to_string()))?;

    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for m in members {
        if let Some(op) = m.get("operatorId").and_then(|v| v.as_str()) {
            let op = op.trim();
            if !op.is_empty() && seen.insert(op.to_lowercase()) {
                ids.push(op.to_string());
            }
        }
    }
    Ok(ids)
}

async fn fetch_operator_chain_address_hex(
    rpc_endpoint: &str,
    operator_id: &str,
) -> Result<String, ChatError> {
    let value = rpc_json_result(
        rpc_endpoint,
        "lyth_operatorInfo",
        serde_json::json!([operator_id]),
    )
    .await?;
    let raw = value
        .get("chainAddress")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            ChatError::Membership(format!(
                "lyth_operatorInfo({operator_id}): missing chainAddress"
            ))
        })?;
    normalize_address_hex(raw).ok_or_else(|| {
        ChatError::Membership(format!(
            "lyth_operatorInfo({operator_id}): invalid chainAddress"
        ))
    })
}

/// Confirm the signed sender belongs to the active cluster. The roster
/// read returns operator ids; each id is resolved through
/// `lyth_operatorInfo.chainAddress` and compared to the signed address.
/// Any RPC or decoding failure fails closed because chat membership is a
/// security boundary.
async fn assert_cluster_member(
    rpc_endpoint: &str,
    cluster_id: i64,
    sender_address: &str,
) -> Result<(), ChatError> {
    let sender_hex =
        normalize_address_hex(sender_address).ok_or(ChatError::NotMember(cluster_id))?;
    let operator_ids = fetch_cluster_member_ids(rpc_endpoint, cluster_id).await?;
    if operator_ids.is_empty() {
        return Err(ChatError::NotMember(cluster_id));
    }
    for operator_id in operator_ids {
        let chain_address = fetch_operator_chain_address_hex(rpc_endpoint, &operator_id).await?;
        if normalize_hex(&chain_address) == normalize_hex(&sender_hex) {
            return Ok(());
        }
    }
    Err(ChatError::NotMember(cluster_id))
}

fn hex_to_address_20(s: &str) -> Option<[u8; 20]> {
    let bytes = hex_to_bytes(s)?;
    if bytes.len() != 20 {
        return None;
    }
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes);
    Some(out)
}

fn normalize_address_hex(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.starts_with("0x") || trimmed.starts_with("0X") {
        return hex_to_address_20(trimmed).map(|bytes| bytes_to_hex(&bytes));
    }

    let parsed =
        bech32::primitives::decode::CheckedHrpstring::new::<bech32::Bech32m>(trimmed).ok()?;
    if parsed.hrp().as_str().to_lowercase() != "mono" {
        return None;
    }
    let bytes: Vec<u8> = parsed.byte_iter().collect();
    if bytes.len() != 20 {
        return None;
    }
    Some(bytes_to_hex(&bytes))
}

// ---- swarm construction + event loop ------------------------------

/// Build the gossipsub swarm and spawn the event loop. Returns the
/// command sender the manager keeps. The loop:
///   * applies Subscribe / Unsubscribe / Publish commands,
///   * verifies inbound gossip, persists it, and emits a Tauri event,
///   * dials the configured bootstrap peers on startup.
async fn spawn_swarm(
    app: AppHandle,
    state: ChatState,
    identity: Arc<ChatIdentity>,
    bootstrap_peers: Vec<Multiaddr>,
) -> Result<(mpsc::UnboundedSender<SwarmCommand>, Vec<String>), ChatError> {
    let (tx, mut rx) = mpsc::unbounded_channel::<SwarmCommand>();
    let (listen_tx, listen_rx) = oneshot::channel::<String>();
    let mut listen_tx = Some(listen_tx);

    let mut swarm = build_gossipsub_swarm(Duration::from_secs(1))?;
    let local_peer_id = *swarm.local_peer_id();

    // Listen on an ephemeral TCP port on all interfaces. AF_NETLINK
    // hardening (see memory/harden-netlink-required) only applies to
    // sandboxed node deployments — the desktop app runs unsandboxed.
    if let Err(e) = swarm.listen_on(
        "/ip4/0.0.0.0/tcp/0"
            .parse()
            .map_err(|e: libp2p::multiaddr::Error| ChatError::Libp2p(e.to_string()))?,
    ) {
        return Err(ChatError::Libp2p(format!("listen_on failed: {e}")));
    }

    // Dial explicitly configured bootstrap peers.
    for addr in bootstrap_peers {
        if let Err(e) = swarm.dial(addr.clone()) {
            log_warn(&format!("chat: dial {addr} failed: {e}"));
        }
    }

    tokio::spawn(async move {
        loop {
            tokio::select! {
                cmd = rx.recv() => {
                    match cmd {
                        Some(SwarmCommand::Subscribe(channel_id)) => {
                            let topic = topic_for_channel(&channel_id);
                            if let Err(e) = swarm.behaviour_mut().subscribe(&topic) {
                                log_warn(&format!("chat: subscribe {channel_id} failed: {e}"));
                            }
                        }
                        Some(SwarmCommand::Unsubscribe(channel_id)) => {
                            let topic = topic_for_channel(&channel_id);
                            // `unsubscribe` returns whether we were subscribed.
                            let _ = swarm.behaviour_mut().unsubscribe(&topic);
                        }
                        Some(SwarmCommand::Publish { channel_id, bytes }) => {
                            let topic = topic_for_channel(&channel_id);
                            if let Err(e) = swarm.behaviour_mut().publish(topic, bytes) {
                                // InsufficientPeers is expected when the
                                // operator is the only node online; the
                                // message is still persisted locally.
                                log_warn(&format!("chat: publish to {channel_id} deferred: {e}"));
                            }
                        }
                        None => break, // sender dropped — manager torn down
                    }
                }
                event = swarm.select_next_some() => {
                    match event {
                        SwarmEvent::NewListenAddr { address, .. } => {
                            if let Some(sender) = listen_tx.take() {
                                let mut addr = normalize_advertised_listen_addr(address);
                                addr.push(Protocol::P2p(local_peer_id));
                                let _ = sender.send(addr.to_string());
                            }
                        }
                        SwarmEvent::Behaviour(gossipsub::Event::Message {
                            message, ..
                        }) => {
                            handle_inbound(&app, &state, &identity, &message.data).await;
                        }
                        _ => {}
                    }
                }
            }
        }
    });

    let listen_addresses = match tokio::time::timeout(Duration::from_secs(5), listen_rx).await {
        Ok(Ok(addr)) => vec![addr],
        _ => Vec::new(),
    };

    Ok((tx, listen_addresses))
}

fn normalize_advertised_listen_addr(address: Multiaddr) -> Multiaddr {
    let mut out = Multiaddr::empty();
    for protocol in &address {
        match protocol.clone() {
            Protocol::Ip4(addr) if addr.is_unspecified() => {
                out.push(Protocol::Ip4(std::net::Ipv4Addr::LOCALHOST));
            }
            other => out.push(other),
        }
    }
    out
}

fn build_gossipsub_swarm(
    heartbeat_interval: Duration,
) -> Result<Swarm<gossipsub::Behaviour>, ChatError> {
    Ok(libp2p::SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            noise::Config::new,
            yamux::Config::default,
        )
        .map_err(|e| ChatError::Libp2p(e.to_string()))?
        .with_behaviour(|key| {
            let config = gossipsub::ConfigBuilder::default()
                .heartbeat_interval(heartbeat_interval)
                .validation_mode(ValidationMode::Permissive)
                .build()
                .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
                    Box::from(e.to_string())
                })?;
            gossipsub::Behaviour::new(MessageAuthenticity::Signed(key.clone()), config)
                .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { Box::from(e) })
        })
        .map_err(|e| ChatError::Libp2p(e.to_string()))?
        .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
        .build())
}

/// Verify, dedupe, persist, and emit one inbound gossip message.
async fn handle_inbound(
    app: &AppHandle,
    state: &ChatState,
    identity: &Arc<ChatIdentity>,
    data: &[u8],
) {
    let Ok(env) = serde_json::from_slice::<ChatEnvelope>(data) else {
        return; // not our envelope shape — ignore
    };

    let guard = state.lock().await;
    let Some(store) = guard.store.as_ref() else {
        return;
    };
    let preflight = match preflight_inbound_envelope(store, identity.address_hex(), &env) {
        Ok(preflight) => preflight,
        Err(e) => {
            log_warn(&format!("chat: inbound preflight failed: {e}"));
            return;
        }
    };
    let rpc_endpoint = guard.rpc_endpoint.clone();
    match preflight {
        InboundPreflight::Accept => {}
        InboundPreflight::Ignored => return,
        InboundPreflight::InvalidSignature => {
            log_warn("chat: dropped message with invalid signature");
            return;
        }
    }
    drop(guard);

    if let Err(e) = assert_cluster_member(&rpc_endpoint, env.cluster_id, &env.sender_address).await
    {
        log_warn(&format!("chat: dropped non-member message: {e}"));
        return;
    }

    let guard = state.lock().await;
    let Some(store) = guard.store.as_ref() else {
        return;
    };
    match accept_inbound_envelope(store, identity.address_hex(), env) {
        Ok(InboundAccept::Accepted(record)) => {
            let channel_id = record.channel_id.clone();
            drop(guard);
            emit_message(app, &channel_id, &record);
        }
        Ok(InboundAccept::Ignored) => {}
        Ok(InboundAccept::InvalidSignature) => {
            log_warn("chat: dropped message with invalid signature")
        }
        Err(e) => log_warn(&format!("chat: persist inbound failed: {e}")),
    }
}

fn accept_inbound_envelope(
    store: &ChatStore,
    local_address: &str,
    env: ChatEnvelope,
) -> Result<InboundAccept, ChatError> {
    match preflight_inbound_envelope(store, local_address, &env)? {
        InboundPreflight::Accept => {}
        InboundPreflight::Ignored => return Ok(InboundAccept::Ignored),
        InboundPreflight::InvalidSignature => return Ok(InboundAccept::InvalidSignature),
    }

    let record = env.to_record(false);
    if store.insert_message(&record)? {
        Ok(InboundAccept::Accepted(record))
    } else {
        Ok(InboundAccept::Ignored)
    }
}

fn preflight_inbound_envelope(
    store: &ChatStore,
    local_address: &str,
    env: &ChatEnvelope,
) -> Result<InboundPreflight, ChatError> {
    // Drop our own echoes — we already persisted+emitted them on send.
    if normalize_hex(&env.sender_address) == normalize_hex(local_address) {
        return Ok(InboundPreflight::Ignored);
    }
    if !verify_envelope(env) {
        return Ok(InboundPreflight::InvalidSignature);
    }
    if !store.is_subscribed_cluster(&env.channel_id, env.cluster_id)? {
        return Ok(InboundPreflight::Ignored);
    }
    if store.has_message(&env.channel_id, &env.msg_id)? {
        return Ok(InboundPreflight::Ignored);
    }
    Ok(InboundPreflight::Accept)
}

fn emit_message(app: &AppHandle, channel_id: &str, record: &MessageRecord) {
    let channel = format!("monarch://chat/message/{channel_id}");
    if let Err(e) = app.emit(&channel, record) {
        log_warn(&format!("chat: emit {channel} failed: {e}"));
    }
}

fn log_warn(msg: &str) {
    eprintln!("[monarch-desktop] {msg}");
}

// ---- hex helpers ---------------------------------------------------

fn bytes_to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(2 + b.len() * 2);
    s.push_str("0x");
    for byte in b {
        s.push_str(&format!("{byte:02x}"));
    }
    s
}

fn normalize_hex(s: &str) -> String {
    let lower = s.to_lowercase();
    lower
        .strip_prefix("0x")
        .map(|x| x.to_string())
        .unwrap_or(lower)
}

fn hex_to_bytes(s: &str) -> Option<Vec<u8>> {
    let clean = normalize_hex(s);
    if clean.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(clean.len() / 2);
    let bytes = clean.as_bytes();
    for i in (0..clean.len()).step_by(2) {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

// ---- DTOs over the Tauri boundary ---------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ChatInitResult {
    pub address_hex: String,
    pub public_key_hex: String,
    pub rpc_endpoint: String,
    pub listen_addresses: Vec<String>,
}

// ---- Tauri commands ------------------------------------------------

/// Initialize the chat subsystem: open the local store, derive the
/// signing identity from the keychain mnemonic, and spawn the gossipsub
/// swarm. Safe to call once per app launch (re-calling rebuilds the
/// swarm — the React side calls it on mount).
///
/// `rpc_endpoint` (optional) overrides the membership-read endpoint;
/// `bootstrap_peers` (optional) is the MVP discovery seed list.
///
/// Bootstrap currently comes from configured libp2p multiaddrs. The
/// node-registry endpoint is an RPC URL, not a libp2p multiaddr, so
/// automatic discovery needs a future `chat_endpoint` field before it
/// can replace explicit `bootstrap_peers`.
#[tauri::command]
pub async fn chat_initialize(
    app: AppHandle,
    state: State<'_, ChatState>,
    rpc_endpoint: Option<String>,
    bootstrap_peers: Option<Vec<String>>,
) -> Result<ChatInitResult, String> {
    chat_initialize_impl(app, state, rpc_endpoint, bootstrap_peers)
        .await
        .map_err(|e| e.to_string())
}

async fn chat_initialize_impl(
    app: AppHandle,
    state: State<'_, ChatState>,
    rpc_endpoint: Option<String>,
    bootstrap_peers: Option<Vec<String>>,
) -> Result<ChatInitResult, ChatError> {
    {
        let guard = state.lock().await;
        if guard.initialized {
            let identity = guard.identity.as_ref().ok_or(ChatError::NotInitialized)?;
            return Ok(ChatInitResult {
                address_hex: identity.address_hex().to_string(),
                public_key_hex: identity.public_key_hex(),
                rpc_endpoint: guard.rpc_endpoint.clone(),
                listen_addresses: guard.listen_addresses.clone(),
            });
        }
    }

    let resolved_rpc_endpoint = rpc_endpoint
        .as_deref()
        .map(str::trim)
        .filter(|ep| !ep.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(default_rpc_endpoint);

    // Resolve the per-app local data dir for the SQLite store.
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| ChatError::Io(e.to_string()))?;
    let store = ChatStore::open(&data_dir)?;

    // Reuse the operator key — never mint a new one.
    let mnemonic = match keychain::read_credential(OPERATOR_MNEMONIC_ACCOUNT) {
        Ok(m) => Zeroizing::new(m),
        Err(keychain::KeychainError::NotFound) => return Err(ChatError::MissingMnemonic),
        Err(e) => return Err(ChatError::BadMnemonic(e.to_string())),
    };
    let identity = Arc::new(ChatIdentity::from_mnemonic(&mnemonic)?);

    // Parse the optional bootstrap peer list.
    let mut peers = Vec::new();
    let bootstrap_peer_list = bootstrap_peers.unwrap_or_else(env_bootstrap_peers);
    for raw in bootstrap_peer_list {
        match raw.parse::<Multiaddr>() {
            Ok(addr) => peers.push(addr),
            Err(e) => log_warn(&format!("chat: bad bootstrap multiaddr {raw}: {e}")),
        }
    }

    let (swarm_tx, listen_addresses) =
        spawn_swarm(app.clone(), (*state).clone(), identity.clone(), peers).await?;

    // Re-subscribe channels persisted as subscribed from a prior launch,
    // but only after re-proving the local operator still belongs to the
    // cluster. Stale local state never overrides the live registry.
    if let Ok(channels) = store.list_channels() {
        for ch in channels.iter().filter(|c| c.subscribed) {
            match assert_cluster_member(
                &resolved_rpc_endpoint,
                ch.cluster_id,
                identity.address_hex(),
            )
            .await
            {
                Ok(()) => {
                    let _ = swarm_tx.send(SwarmCommand::Subscribe(ch.channel_id.clone()));
                }
                Err(e) => {
                    log_warn(&format!(
                        "chat: not re-subscribing {} without membership proof: {e}",
                        ch.channel_id
                    ));
                    let _ = store.set_subscribed(&ch.channel_id, false);
                }
            }
        }
    }

    let result = ChatInitResult {
        address_hex: identity.address_hex().to_string(),
        public_key_hex: identity.public_key_hex(),
        rpc_endpoint: resolved_rpc_endpoint.clone(),
        listen_addresses: listen_addresses.clone(),
    };

    let mut guard = state.lock().await;
    guard.store = Some(store);
    guard.identity = Some(identity);
    guard.swarm_tx = Some(swarm_tx);
    guard.rpc_endpoint = resolved_rpc_endpoint;
    guard.listen_addresses = listen_addresses;
    guard.initialized = true;

    Ok(result)
}

#[tauri::command]
pub async fn chat_get_channels(state: State<'_, ChatState>) -> Result<Vec<ChannelRecord>, String> {
    let guard = state.lock().await;
    let store = guard
        .store
        .as_ref()
        .ok_or(ChatError::NotInitialized)
        .map_err(|e| e.to_string())?;
    store.list_channels().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn chat_get_messages(
    state: State<'_, ChatState>,
    channel_id: String,
    limit: Option<i64>,
) -> Result<Vec<MessageRecord>, String> {
    let guard = state.lock().await;
    let store = guard
        .store
        .as_ref()
        .ok_or(ChatError::NotInitialized)
        .map_err(|e| e.to_string())?;
    let messages = store
        .messages_for_channel(&channel_id, limit.unwrap_or(DEFAULT_MESSAGE_LIMIT))
        .map_err(|e| e.to_string())?;
    Ok(messages.into_iter().map(reverify_message_record).collect())
}

/// Join a cluster channel: gate on live membership, persist the channel
/// row as subscribed, and subscribe the gossipsub topic.
#[tauri::command]
pub async fn chat_subscribe_channel(
    state: State<'_, ChatState>,
    cluster_id: i64,
    name: Option<String>,
) -> Result<ChannelRecord, String> {
    chat_subscribe_impl(state, cluster_id, name)
        .await
        .map_err(|e| e.to_string())
}

async fn chat_subscribe_impl(
    state: State<'_, ChatState>,
    cluster_id: i64,
    name: Option<String>,
) -> Result<ChannelRecord, ChatError> {
    // Read the live membership / endpoint outside the manager lock.
    let (rpc_endpoint, sender_address) = {
        let guard = state.lock().await;
        if !guard.initialized {
            return Err(ChatError::NotInitialized);
        }
        let identity = guard.identity.as_ref().ok_or(ChatError::NotInitialized)?;
        (
            guard.rpc_endpoint.clone(),
            identity.address_hex().to_string(),
        )
    };
    assert_cluster_member(&rpc_endpoint, cluster_id, &sender_address).await?;

    let channel_id = channel_id_for_cluster(cluster_id);
    let record = ChannelRecord {
        channel_id: channel_id.clone(),
        name: name.unwrap_or_else(|| format!("Cluster C-{cluster_id:03}")),
        sub: format!("cluster-{cluster_id} · signed"),
        kind: "cluster".to_string(),
        cluster_id,
        subscribed: true,
    };

    let guard = state.lock().await;
    let store = guard.store.as_ref().ok_or(ChatError::NotInitialized)?;
    store.upsert_channel(&record)?;
    if let Some(tx) = guard.swarm_tx.as_ref() {
        let _ = tx.send(SwarmCommand::Subscribe(channel_id));
    }
    Ok(record)
}

#[tauri::command]
pub async fn chat_unsubscribe_channel(
    state: State<'_, ChatState>,
    channel_id: String,
) -> Result<(), String> {
    let guard = state.lock().await;
    let store = guard
        .store
        .as_ref()
        .ok_or(ChatError::NotInitialized)
        .map_err(|e| e.to_string())?;
    store
        .set_subscribed(&channel_id, false)
        .map_err(|e| e.to_string())?;
    if let Some(tx) = guard.swarm_tx.as_ref() {
        let _ = tx.send(SwarmCommand::Unsubscribe(channel_id));
    }
    Ok(())
}

/// Sign and publish a message to a cluster channel. The message is
/// persisted + emitted locally immediately (optimistic) and gossiped to
/// peers. Membership is re-checked live before the send.
#[tauri::command]
pub async fn chat_send_message(
    app: AppHandle,
    state: State<'_, ChatState>,
    channel_id: String,
    cluster_id: i64,
    body: String,
) -> Result<MessageRecord, String> {
    chat_send_impl(app, state, channel_id, cluster_id, body)
        .await
        .map_err(|e| e.to_string())
}

async fn chat_send_impl(
    app: AppHandle,
    state: State<'_, ChatState>,
    channel_id: String,
    cluster_id: i64,
    body: String,
) -> Result<MessageRecord, ChatError> {
    if body.len() > MAX_BODY_BYTES {
        return Err(ChatError::BodyTooLarge);
    }
    if channel_id != channel_id_for_cluster(cluster_id) {
        return Err(ChatError::ChannelClusterMismatch(channel_id, cluster_id));
    }

    let (identity, rpc_endpoint) = {
        let guard = state.lock().await;
        if !guard.initialized {
            return Err(ChatError::NotInitialized);
        }
        (
            guard.identity.clone().ok_or(ChatError::NotInitialized)?,
            guard.rpc_endpoint.clone(),
        )
    };

    // Live membership gate (don't post to a cluster unless the sender
    // address is in the active roster).
    assert_cluster_member(&rpc_endpoint, cluster_id, identity.address_hex()).await?;

    {
        let guard = state.lock().await;
        let store = guard.store.as_ref().ok_or(ChatError::NotInitialized)?;
        if !store.is_subscribed_cluster(&channel_id, cluster_id)? {
            return Err(ChatError::NotSubscribed(channel_id, cluster_id));
        }
    }

    // Build + sign the envelope.
    let timestamp_ms = now_ms();
    let nonce_hex = bytes_to_hex(&random_nonce());
    let mut env = ChatEnvelope {
        msg_id: String::new(),
        channel_id: channel_id.clone(),
        cluster_id,
        sender_address: identity.address_hex().to_string(),
        sender_pubkey_hex: identity.public_key_hex(),
        timestamp_ms,
        body,
        nonce_hex,
        signature_hex: String::new(),
    };
    let digest = env.signing_digest();
    let signature = identity.sign(&digest)?;
    env.signature_hex = bytes_to_hex(&signature);
    // msg_id = keccak256(digest) hex — stable, dedupe-friendly.
    env.msg_id = message_id_for_digest(&digest);

    let record = env.to_record(true);
    let bytes = serde_json::to_vec(&env).map_err(|e| ChatError::Libp2p(e.to_string()))?;

    let guard = state.lock().await;
    let store = guard.store.as_ref().ok_or(ChatError::NotInitialized)?;
    store.insert_message(&record)?;
    if let Some(tx) = guard.swarm_tx.as_ref() {
        let _ = tx.send(SwarmCommand::Publish {
            channel_id: channel_id.clone(),
            bytes,
        });
    }
    drop(guard);

    // Optimistic local echo so the composer feels instant.
    emit_message(&app, &channel_id, &record);
    Ok(record)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn random_nonce() -> [u8; 16] {
    use rand::RngCore;
    let mut out = [0u8; 16];
    rand::rng().fill_bytes(&mut out);
    out
}

// ---- tests ---------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // A fixed PQM-1 mnemonic (24 words, algo+version tagged). Generated
    // with the TS SDK's `generatePqm1Mnemonic`; its address is the
    // reference value below. This pins the Rust derivation to the SDK.
    const TEST_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

    #[test]
    fn shake256_matches_known_vector() {
        // SHAKE256("", 32) — NIST known-answer (first 32 bytes of the XOF
        // of the empty string).
        let out = shake256_32(b"", b"");
        let expected = "46b9dd2b0ba88d13233b3feb743eeb243fcd52ea62b81b82b50c27646ed5762f";
        assert_eq!(bytes_to_hex(&out), format!("0x{expected}"));
    }

    #[test]
    fn derives_a_valid_address_from_a_pqm1_mnemonic() {
        // `art` keeps the all-`abandon` phrase a valid BIP-39 checksum,
        // but the leading bytes (algo/version) won't be 0x01/0x01 for an
        // arbitrary all-zero entropy, so this asserts the derivation path
        // runs and yields a 20-byte address when the tags are valid.
        // We construct a valid PQM-1 payload directly instead.
        let mut payload = [0u8; PQM1_PAYLOAD_LEN];
        payload[0] = PQM1_ALGO_TAG_MLDSA65;
        payload[1] = PQM1_VERSION_V1;
        // deterministic 30-byte entropy
        for (i, b) in payload[2..].iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(7).wrapping_add(3);
        }
        let mnemonic = bip39::Mnemonic::from_entropy(&payload).unwrap();
        let id = ChatIdentity::from_mnemonic(&mnemonic.to_string()).unwrap();
        assert!(id.address_hex().starts_with("0x"));
        assert_eq!(id.address_hex().len(), 2 + 40); // 0x + 20 bytes
        assert_eq!(id.public_key_bytes.len(), fips204::ml_dsa_65::PK_LEN);
    }

    #[test]
    fn rejects_bip32_style_mnemonic() {
        // All-`abandon ... art` is a valid 24-word BIP-39 phrase whose
        // entropy is all-zero, so its algo/version tags are 0x00/0x00 →
        // must be rejected as a non-PQM-1 (BIP-32) phrase.
        match ChatIdentity::from_mnemonic(TEST_MNEMONIC) {
            Err(ChatError::BadMnemonic(_)) => {}
            Err(other) => panic!("expected BadMnemonic, got {other}"),
            Ok(_) => panic!("a BIP-32 (all-zero entropy) phrase must be rejected"),
        }
    }

    /// Pins the Rust PQM-1 → ML-DSA-65 → address derivation to the TS
    /// SDK. The reference seed + address below were produced by the SDK
    /// (`@monolythium/core-sdk/crypto`) for the SAME deterministic
    /// payload `make_identity` builds (algo=1, ver=1, entropy[i]=i*5+11).
    /// If the SDK changes its derivation this test catches the drift.
    #[test]
    fn derivation_matches_ts_sdk_reference_vector() {
        let mut payload = [0u8; PQM1_PAYLOAD_LEN];
        payload[0] = PQM1_ALGO_TAG_MLDSA65;
        payload[1] = PQM1_VERSION_V1;
        for (i, b) in payload[2..].iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(5).wrapping_add(11);
        }
        // seed = SHAKE256(domain ‖ payload, 32) — SDK reference.
        let seed = shake256_32(PQM1_DOMAIN, &payload);
        assert_eq!(
            bytes_to_hex(&seed),
            "0xd9d68616bf0cf38b632111aabf316f29781b6b0e36be1d83a06b296a4a0e9716",
            "PQM-1 seed must match the TS SDK"
        );
        let mnemonic = bip39::Mnemonic::from_entropy(&payload).unwrap();
        let id = ChatIdentity::from_mnemonic(&mnemonic.to_string()).unwrap();
        assert_eq!(
            id.address_hex(),
            "0x3b48adca28974aacd15e9dd9577495f82cce8001",
            "operator address must match the TS SDK (mlDsa65AddressBytes)"
        );
    }

    fn make_identity_variant(offset: u8) -> ChatIdentity {
        let mut payload = [0u8; PQM1_PAYLOAD_LEN];
        payload[0] = PQM1_ALGO_TAG_MLDSA65;
        payload[1] = PQM1_VERSION_V1;
        for (i, b) in payload[2..].iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(5).wrapping_add(offset);
        }
        let mnemonic = bip39::Mnemonic::from_entropy(&payload).unwrap();
        ChatIdentity::from_mnemonic(&mnemonic.to_string()).unwrap()
    }

    fn make_identity() -> ChatIdentity {
        make_identity_variant(11)
    }

    fn sample_channel(cluster_id: i64, subscribed: bool) -> ChannelRecord {
        ChannelRecord {
            channel_id: channel_id_for_cluster(cluster_id),
            name: format!("Cluster C-{cluster_id:03}"),
            sub: format!("cluster-{cluster_id} · signed"),
            kind: "cluster".to_string(),
            cluster_id,
            subscribed,
        }
    }

    fn signed_envelope(id: &ChatIdentity, body: &str) -> ChatEnvelope {
        let mut env = ChatEnvelope {
            msg_id: String::new(),
            channel_id: "cluster-1".to_string(),
            cluster_id: 1,
            sender_address: id.address_hex().to_string(),
            sender_pubkey_hex: id.public_key_hex(),
            timestamp_ms: 1_700_000_000_000,
            body: body.to_string(),
            nonce_hex: "0xdeadbeef".to_string(),
            signature_hex: String::new(),
        };
        let digest = env.signing_digest();
        env.signature_hex = bytes_to_hex(&id.sign(&digest).unwrap());
        env.msg_id = message_id_for_digest(&digest);
        env
    }

    async fn spawn_membership_rpc(
        operator_ids: Vec<&'static str>,
        chain_addresses: Vec<(&'static str, &'static str)>,
    ) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let operator_ids: Vec<String> = operator_ids.into_iter().map(ToOwned::to_owned).collect();
        let chain_addresses: HashMap<String, String> = chain_addresses
            .into_iter()
            .map(|(id, address)| (id.to_string(), address.to_string()))
            .collect();

        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let Some(body) = read_http_body(&mut socket).await else {
                    continue;
                };
                let request: serde_json::Value =
                    serde_json::from_slice(&body).unwrap_or_else(|_| serde_json::json!({}));
                let id = request.get("id").cloned().unwrap_or(serde_json::json!(1));
                let method = request.get("method").and_then(|v| v.as_str()).unwrap_or("");
                let params = request
                    .get("params")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();

                let response = match method {
                    "lyth_clusterStatus" => serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "members": operator_ids.iter().map(|operator_id| {
                                serde_json::json!({ "operatorId": operator_id })
                            }).collect::<Vec<_>>()
                        }
                    }),
                    "lyth_operatorInfo" => {
                        let operator_id = params.first().and_then(|v| v.as_str()).unwrap_or("");
                        if let Some(chain_address) = chain_addresses.get(operator_id) {
                            serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "operatorId": operator_id,
                                    "chainAddress": chain_address
                                }
                            })
                        } else {
                            serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "error": { "code": -32004, "message": "operator not found" }
                            })
                        }
                    }
                    _ => serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32601, "message": "method not found" }
                    }),
                };
                let body = serde_json::to_vec(&response).unwrap();
                let header = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(header.as_bytes()).await;
                let _ = socket.write_all(&body).await;
            }
        });

        format!("http://{addr}")
    }

    async fn read_http_body(socket: &mut tokio::net::TcpStream) -> Option<Vec<u8>> {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 1024];
        loop {
            let n = socket.read(&mut tmp).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&tmp[..n]);
            let Some(header_end) = find_header_end(&buf) else {
                continue;
            };
            let headers = std::str::from_utf8(&buf[..header_end]).ok()?;
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    if name.eq_ignore_ascii_case("content-length") {
                        value.trim().parse::<usize>().ok()
                    } else {
                        None
                    }
                })
                .unwrap_or(0);
            let body_start = header_end + 4;
            while buf.len() < body_start + content_length {
                let n = socket.read(&mut tmp).await.ok()?;
                if n == 0 {
                    return None;
                }
                buf.extend_from_slice(&tmp[..n]);
            }
            return Some(buf[body_start..body_start + content_length].to_vec());
        }
    }

    fn find_header_end(buf: &[u8]) -> Option<usize> {
        buf.windows(4).position(|window| window == b"\r\n\r\n")
    }

    #[test]
    fn sign_then_verify_roundtrips() {
        let id = make_identity();
        let env = signed_envelope(&id, "operator cluster ping");
        assert!(verify_envelope(&env));
    }

    #[test]
    fn verify_fails_on_tampered_body() {
        let id = make_identity();
        let mut env = signed_envelope(&id, "original");
        env.body = "tampered".to_string();
        assert!(!verify_envelope(&env));
    }

    #[test]
    fn verify_fails_on_address_pubkey_mismatch() {
        let id = make_identity();
        let mut env = signed_envelope(&id, "hello");
        // Swap the claimed address to something not derived from the key.
        env.sender_address = "0x0000000000000000000000000000000000000000".to_string();
        assert!(!verify_envelope(&env));
    }

    #[test]
    fn verify_fails_on_msg_id_digest_mismatch() {
        let id = make_identity();
        let mut env = signed_envelope(&id, "hello");
        env.msg_id =
            "0x1111111111111111111111111111111111111111111111111111111111111111".to_string();
        assert!(!verify_envelope(&env));
    }

    #[test]
    fn verify_fails_on_channel_cluster_mismatch() {
        let id = make_identity();
        let mut env = signed_envelope(&id, "hello");
        env.cluster_id = 2;
        let digest = env.signing_digest();
        env.signature_hex = bytes_to_hex(&id.sign(&digest).unwrap());
        env.msg_id = message_id_for_digest(&digest);
        assert!(!verify_envelope(&env));
    }

    #[test]
    fn verify_fails_when_body_exceeds_limit() {
        let id = make_identity();
        let body = "x".repeat(MAX_BODY_BYTES + 1);
        let env = signed_envelope(&id, &body);
        assert!(!verify_envelope(&env));
    }

    #[test]
    fn persisted_records_are_reverified_from_envelope_fields() {
        let id = make_identity();
        let env = signed_envelope(&id, "restart-auditable");
        let valid = reverify_message_record(env.to_record(false));
        assert!(valid.verified);

        let mut tampered = valid.clone();
        tampered.body = "tampered after persistence".to_string();
        assert!(!reverify_message_record(tampered).verified);

        let mut missing_pubkey = valid;
        missing_pubkey.sender_pubkey_hex.clear();
        assert!(!reverify_message_record(missing_pubkey).verified);
    }

    #[test]
    fn normalize_address_hex_accepts_hex_and_user_bech32() {
        assert_eq!(
            normalize_address_hex("0x123456789ABCDEF0112233445566778899AABBCC").unwrap(),
            "0x123456789abcdef0112233445566778899aabbcc"
        );
        assert_eq!(
            normalize_address_hex("mono1zg69v7y6hn00qyfzxdz92enh3zv64w7vajvdc4").unwrap(),
            "0x123456789abcdef0112233445566778899aabbcc"
        );
        assert!(normalize_address_hex("monoc1zg69v7y6hn00qyfzxdz92enh3zv64w7v5cz8dn").is_none());
    }

    #[tokio::test]
    async fn cluster_membership_proves_sender_via_operator_info() {
        let endpoint = spawn_membership_rpc(
            vec!["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
            vec![(
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "mono1zg69v7y6hn00qyfzxdz92enh3zv64w7vajvdc4",
            )],
        )
        .await;

        assert_cluster_member(&endpoint, 42, "0x123456789abcdef0112233445566778899aabbcc")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cluster_membership_rejects_sender_without_roster_match() {
        let endpoint = spawn_membership_rpc(
            vec!["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
            vec![(
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "0x123456789abcdef0112233445566778899aabbcc",
            )],
        )
        .await;

        assert!(matches!(
            assert_cluster_member(&endpoint, 42, "0xffffffffffffffffffffffffffffffffffffffff",)
                .await,
            Err(ChatError::NotMember(42))
        ));
    }

    #[test]
    fn inbound_accepts_valid_message_for_subscribed_channel() {
        let local = make_identity();
        let remote = make_identity_variant(19);
        let store = ChatStore::open_in_memory().unwrap();
        store.upsert_channel(&sample_channel(1, true)).unwrap();

        let env = signed_envelope(&remote, "hello from peer");
        let result = accept_inbound_envelope(&store, local.address_hex(), env).unwrap();

        let InboundAccept::Accepted(record) = result else {
            panic!("expected inbound envelope to be accepted");
        };
        assert_eq!(record.channel_id, "cluster-1");
        assert_eq!(record.sender_address, remote.address_hex());
        assert_eq!(record.body, "hello from peer");
        assert!(record.verified);
        assert!(!record.from_me);

        let stored = store.messages_for_channel("cluster-1", 10).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].msg_id, record.msg_id);
    }

    #[test]
    fn inbound_ignores_own_echo() {
        let local = make_identity();
        let store = ChatStore::open_in_memory().unwrap();
        store.upsert_channel(&sample_channel(1, true)).unwrap();

        let env = signed_envelope(&local, "echo");
        assert!(matches!(
            accept_inbound_envelope(&store, local.address_hex(), env).unwrap(),
            InboundAccept::Ignored
        ));
        assert!(store
            .messages_for_channel("cluster-1", 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn inbound_ignores_unsubscribed_cluster_channel() {
        let local = make_identity();
        let remote = make_identity_variant(19);
        let store = ChatStore::open_in_memory().unwrap();
        store.upsert_channel(&sample_channel(1, false)).unwrap();

        let env = signed_envelope(&remote, "not joined");
        assert!(matches!(
            accept_inbound_envelope(&store, local.address_hex(), env).unwrap(),
            InboundAccept::Ignored
        ));
        assert!(store
            .messages_for_channel("cluster-1", 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn inbound_dedupes_existing_message() {
        let local = make_identity();
        let remote = make_identity_variant(19);
        let store = ChatStore::open_in_memory().unwrap();
        store.upsert_channel(&sample_channel(1, true)).unwrap();

        let env = signed_envelope(&remote, "dedupe");
        assert!(matches!(
            accept_inbound_envelope(&store, local.address_hex(), env.clone()).unwrap(),
            InboundAccept::Accepted(_)
        ));
        assert!(matches!(
            accept_inbound_envelope(&store, local.address_hex(), env).unwrap(),
            InboundAccept::Ignored
        ));
        assert_eq!(
            store.messages_for_channel("cluster-1", 10).unwrap().len(),
            1
        );
    }

    #[test]
    fn inbound_rejects_invalid_signature_without_persisting() {
        let local = make_identity();
        let remote = make_identity_variant(19);
        let store = ChatStore::open_in_memory().unwrap();
        store.upsert_channel(&sample_channel(1, true)).unwrap();

        let mut env = signed_envelope(&remote, "original");
        env.body = "tampered".to_string();
        assert!(matches!(
            accept_inbound_envelope(&store, local.address_hex(), env).unwrap(),
            InboundAccept::InvalidSignature
        ));
        assert!(store
            .messages_for_channel("cluster-1", 10)
            .unwrap()
            .is_empty());
    }

    async fn wait_for_listen_addr(swarm: &mut Swarm<gossipsub::Behaviour>) -> Multiaddr {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let SwarmEvent::NewListenAddr { address, .. } = swarm.select_next_some().await {
                    return address;
                }
            }
        })
        .await
        .expect("swarm should listen on localhost")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_swarms_exchange_and_persist_signed_cluster_message() {
        let sender_identity = make_identity_variant(19);
        let receiver_identity = make_identity();
        let receiver_store = ChatStore::open_in_memory().unwrap();
        receiver_store
            .upsert_channel(&sample_channel(1, true))
            .unwrap();

        let mut sender = build_gossipsub_swarm(Duration::from_millis(100)).unwrap();
        let mut receiver = build_gossipsub_swarm(Duration::from_millis(100)).unwrap();
        let topic = topic_for_channel("cluster-1");
        sender.behaviour_mut().subscribe(&topic).unwrap();
        receiver.behaviour_mut().subscribe(&topic).unwrap();

        receiver
            .listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap())
            .unwrap();
        let mut receiver_addr = wait_for_listen_addr(&mut receiver).await;
        receiver_addr.push(libp2p::multiaddr::Protocol::P2p(*receiver.local_peer_id()));
        sender.dial(receiver_addr).unwrap();

        let env = signed_envelope(&sender_identity, "hello over libp2p");
        let bytes = serde_json::to_vec(&env).unwrap();
        let received = tokio::time::timeout(Duration::from_secs(10), async {
            let mut publish_tick = tokio::time::interval(Duration::from_millis(100));
            loop {
                tokio::select! {
                    _ = publish_tick.tick() => {
                        let _ = sender
                            .behaviour_mut()
                            .publish(topic_for_channel("cluster-1"), bytes.clone());
                    }
                    event = sender.select_next_some() => {
                        let _ = event;
                    }
                    event = receiver.select_next_some() => {
                        if let SwarmEvent::Behaviour(gossipsub::Event::Message { message, .. }) = event {
                            break message.data;
                        }
                    }
                }
            }
        })
        .await
        .expect("receiver swarm should get a gossipsub message");

        let received_env = serde_json::from_slice::<ChatEnvelope>(&received).unwrap();
        assert_eq!(received_env.body, "hello over libp2p");
        let result = accept_inbound_envelope(
            &receiver_store,
            receiver_identity.address_hex(),
            received_env,
        )
        .unwrap();
        let InboundAccept::Accepted(record) = result else {
            panic!("receiver should persist the valid libp2p message");
        };
        assert_eq!(record.sender_address, sender_identity.address_hex());
        assert_eq!(record.body, "hello over libp2p");
        let stored = receiver_store
            .messages_for_channel("cluster-1", 10)
            .unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].msg_id, record.msg_id);
    }

    #[test]
    fn channel_id_format() {
        assert_eq!(channel_id_for_cluster(12), "cluster-12");
        assert_eq!(channel_id_for_cluster(0), "cluster-0");
    }

    #[test]
    fn bootstrap_peer_list_accepts_comma_and_whitespace() {
        let peers = parse_bootstrap_peer_list(
            "/ip4/127.0.0.1/tcp/41001/p2p/peer-a,\n  /dns4/chat.example/tcp/443/wss/p2p/peer-b",
        );
        assert_eq!(
            peers,
            vec![
                "/ip4/127.0.0.1/tcp/41001/p2p/peer-a".to_string(),
                "/dns4/chat.example/tcp/443/wss/p2p/peer-b".to_string(),
            ]
        );
    }

    #[test]
    fn hex_roundtrip() {
        let bytes = vec![0x00, 0x0f, 0xff, 0xab];
        let hex = bytes_to_hex(&bytes);
        assert_eq!(hex, "0x000fffab");
        assert_eq!(hex_to_bytes(&hex).unwrap(), bytes);
        assert_eq!(hex_to_bytes("000fffab").unwrap(), bytes);
        assert!(hex_to_bytes("0xabc").is_none()); // odd length
    }
}
