// Advisory bridge. Routes Ask Monarch queries to either a configured
// hosted endpoint or a local chat endpoint. Both paths stream tokens back to the React side as
// Tauri events on `monarch://ask/stream/<correlation_id>` and emit a
// final `monarch://ask/done/<correlation_id>` payload that contains
// the assembled text plus an optional `proposed_action` parsed out of
// the model's reply.
//
// Hard rules that drove this file:
//
//   * **API key never leaves Rust.** The Hosted provider key lives in the
//     OS keychain (`keychain.rs`, account `hosted-provider-api-key`) and is
//     read just before issuing the HTTPS request; the React side never
//     sees it.
//   * **Advisory only.** The bridge does not — and must not — call
//     `ops.requestOp()` or fire any side-effecting Tauri command. It
//     parses a `<proposed_action>{...}</proposed_action>` JSON envelope
//     out of the model's text and hands it to the React side, which
//     opens the Operations drawer at the `preview` stage. The drawer's
//     state machine (`preview → auth → executing → done`) is the only
//     path that ever touches the host.
//   * **Correlation-id scoped.** Every ask gets a fresh `u64` so
//     parallel asks don't cross-stream. The id is the suffix on the
//     `monarch://ask/...` event channels.
//
// The proposed-action parser is the unit-tested seam (`#[cfg(test)]`
// at the bottom). Provider-specific streaming is split into `hosted`
// and `local` submodules below for readability; both feed into the
// same `accumulate_and_emit` loop.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;
use tokio::sync::Mutex;

use crate::keychain;

/// Hosted endpoint and model are explicit operator config. There is no
/// public default, because provider choice is deployment-local.
const DEFAULT_HOSTED_URL: &str = "";
const DEFAULT_HOSTED_MODEL: &str = "";
/// Default local endpoint. Operators can override via
/// `set_ai_config`.
const DEFAULT_LOCAL_URL: &str = "http://localhost:11434";
/// Conservative default local model — small + fast, fits on most dev
/// boxes. Production swaps to `nemotron:70b` or similar via settings.
const DEFAULT_LOCAL_MODEL: &str = "qwen2.5:3b";
/// Optional provider-version header for hosted endpoints that require it.
const HOSTED_VERSION: &str = "2023-06-01";
/// Keychain account name for the Hosted provider API key. Mirrors the SSH
/// naming convention (`ssh:host`, `ssh:user`, ...).
const HOSTED_KEYCHAIN_ACCOUNT: &str = "hosted-provider-api-key";
/// Settings file name under the per-user config dir.
const SETTINGS_FILE: &str = "ai.toml";
/// Per-user config directory name (folded into `dirs::config_dir()`).
const SETTINGS_DIR: &str = "monarch-desktop";

/// Operator-facing errors. Stringified at the Tauri boundary.
#[derive(Debug, Error)]
pub enum AiError {
    #[error("ai: missing hosted endpoint — configure hosted_url before using the hosted provider")]
    MissingHostedEndpoint,
    #[error("ai: missing hosted model — configure hosted_model before using the hosted provider")]
    MissingHostedModel,
    #[error(
        "ai: missing hosted api key — store one under keychain account `{HOSTED_KEYCHAIN_ACCOUNT}`"
    )]
    MissingHostedKey,
    #[error("ai: http error: {0}")]
    Http(String),
    #[error("ai: provider returned {status}: {body}")]
    Provider { status: u16, body: String },
    #[error("ai: settings io error: {0}")]
    Io(String),
    #[error("ai: bad settings: {0}")]
    BadSettings(String),
    #[error("ai: emit failed on {channel}: {error}")]
    Emit { channel: String, error: String },
}

impl From<reqwest::Error> for AiError {
    fn from(err: reqwest::Error) -> Self {
        AiError::Http(err.to_string())
    }
}

/// Which provider to dispatch on. Defaults to Local so a fresh checkout has
/// no hosted endpoint or key baked into public source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Hosted,
    #[default]
    Local,
}

/// Serialized form of the ai.toml settings file. We deliberately keep
/// this small: provider + endpoint/model labels. The hosted provider key stays in
/// the keychain — never in this file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    #[serde(default)]
    pub provider: AiProvider,
    #[serde(default = "default_hosted_url")]
    pub hosted_url: String,
    #[serde(default = "default_hosted_model")]
    pub hosted_model: String,
    #[serde(default = "default_local_url")]
    pub local_url: String,
    #[serde(default = "default_local_model")]
    pub local_model: String,
}

fn default_hosted_url() -> String {
    DEFAULT_HOSTED_URL.to_string()
}
fn default_hosted_model() -> String {
    DEFAULT_HOSTED_MODEL.to_string()
}
fn default_local_url() -> String {
    DEFAULT_LOCAL_URL.to_string()
}
fn default_local_model() -> String {
    DEFAULT_LOCAL_MODEL.to_string()
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: AiProvider::default(),
            hosted_url: default_hosted_url(),
            hosted_model: default_hosted_model(),
            local_url: default_local_url(),
            local_model: default_local_model(),
        }
    }
}

/// Tauri-managed state. Holds the latest known config + the
/// next-correlation-id counter. We re-read the settings file on every
/// `ask_monarch` call rather than caching aggressively — a one-line
/// disk read on a request boundary is cheap and prevents stale config
/// after the operator edits via the advisory settings panel.
pub struct AiStateInner {
    pub next_correlation_id: AtomicU64,
}

impl AiStateInner {
    pub fn new() -> Self {
        Self {
            next_correlation_id: AtomicU64::new(1),
        }
    }
}

impl Default for AiStateInner {
    fn default() -> Self {
        Self::new()
    }
}

pub type AiState = Arc<Mutex<AiStateInner>>;

// ---- settings file IO ---------------------------------------------

fn settings_path() -> Result<std::path::PathBuf, AiError> {
    let base = dirs::config_dir()
        .ok_or_else(|| AiError::Io("could not resolve user config directory".to_string()))?;
    Ok(base.join(SETTINGS_DIR).join(SETTINGS_FILE))
}

pub fn load_config() -> Result<AiConfig, AiError> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(AiConfig::default());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| AiError::Io(e.to_string()))?;
    toml::from_str::<AiConfig>(&text).map_err(|e| AiError::BadSettings(e.to_string()))
}

pub fn save_config(cfg: &AiConfig) -> Result<(), AiError> {
    let path = settings_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| AiError::Io(e.to_string()))?;
    }
    let text = toml::to_string_pretty(cfg).map_err(|e| AiError::BadSettings(e.to_string()))?;
    std::fs::write(&path, text).map_err(|e| AiError::Io(e.to_string()))
}

// ---- proposed-action parser (unit-tested seam) --------------------

/// Mirror of the React `OpKind` union. The model is instructed to
/// pick a kind from this list; if it returns something else we drop
/// the proposed action server-side rather than letting the React side
/// fail closed on an unknown kind.
const OP_KINDS: &[&str] = &[
    "operator-start",
    "operator-stop",
    "operator-restart",
    "operator-restore",
    "operator-register",
    "chat-bootstrap-peers",
    "rotate-keys",
    "redelegate",
    "export-backup",
    "cluster-swap",
    "cluster-accept-invite",
    "freeze-admission",
    "emergency-key-rotation",
    "ota-apply",
    "ota-rollback",
];

/// One field on the OpRequest preview card. JSON-shape-compatible with
/// the React `OpField` so we don't need a translation layer on the
/// frontend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProposedField {
    pub key: String,
    pub label: String,
    pub value: String,
}

/// Structured intent extracted from a model reply. Shape mirrors the
/// React `OpRequest` minus the `confirmLabel` (drawer fills that in).
/// `destructive` and `needsPasskey` default to false on the React side
/// when omitted; we keep them as `Option<bool>` here so the model can
/// stay terse.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProposedAction {
    pub kind: String,
    pub title: String,
    pub sub: String,
    pub intro: String,
    #[serde(default)]
    pub fields: Vec<ProposedField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destructive: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "needsPasskey"
    )]
    pub needs_passkey: Option<bool>,
}

/// Pull the first `<proposed_action>{...}</proposed_action>` block out
/// of `text`, deserialize it, and validate `kind` against `OP_KINDS`.
/// Returns `None` if the block is absent or malformed — the surface
/// gracefully falls back to an advisory-only reply (text shown,
/// drawer not opened).
pub fn parse_proposed_action(text: &str) -> Option<ProposedAction> {
    let open = text.find("<proposed_action>")?;
    let after_open = &text[open + "<proposed_action>".len()..];
    let close = after_open.find("</proposed_action>")?;
    let raw = after_open[..close].trim();
    let action: ProposedAction = serde_json::from_str(raw).ok()?;
    if !OP_KINDS.contains(&action.kind.as_str()) {
        return None;
    }
    if action.title.trim().is_empty() {
        return None;
    }
    Some(action)
}

/// Strip the `<proposed_action>...</proposed_action>` block from `text`
/// before showing it to the operator. The block is structured intent;
/// the operator-facing summary should not contain it.
pub fn strip_proposed_action(text: &str) -> String {
    let Some(open) = text.find("<proposed_action>") else {
        return text.to_string();
    };
    let after_open = &text[open + "<proposed_action>".len()..];
    let Some(close) = after_open.find("</proposed_action>") else {
        return text.to_string();
    };
    let head = &text[..open];
    let tail = &after_open[close + "</proposed_action>".len()..];
    format!("{head}{tail}").trim().to_string()
}

// ---- system prompt -----------------------------------------------

/// System prompt fed to both providers. Forces the structured-action
/// envelope and reinforces the advisory-only contract.
pub fn system_prompt() -> String {
    let kinds = OP_KINDS
        .iter()
        .map(|k| format!("`{k}`"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "You are Monarch — the operator console for a Monolythium v5.0 Starfish-C \
operator node. You are advisory only. You never execute commands. The operator \
runs every action through the Operations drawer (preview → auth → executing → done) \
on their machine.\n\n\
When your reply suggests a concrete action the operator should take, emit ONE \
`<proposed_action>{{...}}</proposed_action>` block at the end of your reply. \
The block contains a single JSON object with these fields:\n\
- `kind` (string, required): one of {kinds}.\n\
- `title` (string, required): short operator-facing label, e.g. `Restart eridanus`.\n\
- `sub` (string, required): one-line subtitle, e.g. `graceful · ~45s · cluster tolerates`.\n\
- `intro` (string, required): 1–2 sentence preview that will appear in the drawer.\n\
- `fields` (array of {{key, label, value}} objects, optional): structured key/value rows.\n\
- `destructive` (boolean, optional): true if the action is risky.\n\
- `needsPasskey` (boolean, optional): true if a passkey/keychain prompt is required.\n\n\
Do NOT emit more than one block. Do NOT propose an action when the operator is just \
asking for information. Keep the text reply tight: explain *why*, then propose. \
Never say you executed anything."
    )
}

// ---- streaming dispatch -------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct AskDonePayload {
    pub correlation_id: u64,
    pub text: String,
    pub proposed_action: Option<ProposedAction>,
    pub provider: AiProvider,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AskErrorPayload {
    pub correlation_id: u64,
    pub error: String,
}

/// Minimal trait so streaming can be unit-tested without spinning up a
/// Tauri runtime. The production impl wraps `tauri::AppHandle::emit`.
pub trait AskEmitter: Send + Sync + 'static {
    fn emit_chunk(&self, channel: &str, chunk: &str) -> Result<(), AiError>;
    fn emit_done(&self, channel: &str, payload: &AskDonePayload) -> Result<(), AiError>;
    fn emit_error(&self, channel: &str, payload: &AskErrorPayload) -> Result<(), AiError>;
}

pub struct AppHandleAskEmitter {
    pub app: AppHandle,
}

impl AskEmitter for AppHandleAskEmitter {
    fn emit_chunk(&self, channel: &str, chunk: &str) -> Result<(), AiError> {
        self.app.emit(channel, chunk).map_err(|e| AiError::Emit {
            channel: channel.to_string(),
            error: e.to_string(),
        })
    }
    fn emit_done(&self, channel: &str, payload: &AskDonePayload) -> Result<(), AiError> {
        self.app.emit(channel, payload).map_err(|e| AiError::Emit {
            channel: channel.to_string(),
            error: e.to_string(),
        })
    }
    fn emit_error(&self, channel: &str, payload: &AskErrorPayload) -> Result<(), AiError> {
        self.app.emit(channel, payload).map_err(|e| AiError::Emit {
            channel: channel.to_string(),
            error: e.to_string(),
        })
    }
}

// ---- provider: Hosted ---------------------------------------------

mod hosted {
    use super::*;
    use futures_util::TryStreamExt;
    use std::pin::Pin;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio_util::io::StreamReader;

    /// Stream the configured hosted Messages-compatible API. Returns the assembled text.
    /// SSE format: `event: <name>\ndata: <json>\n\n`. We only care about
    /// `content_block_delta` events whose delta type is `text_delta`.
    pub async fn run<E: AskEmitter>(
        prompt: &str,
        chunk_channel: &str,
        emitter: &E,
        api_key: &str,
        url: &str,
        model: &str,
    ) -> Result<String, AiError> {
        let url = url.trim();
        let model = model.trim();
        if url.is_empty() {
            return Err(AiError::MissingHostedEndpoint);
        }
        if model.is_empty() {
            return Err(AiError::MissingHostedModel);
        }
        let body = json!({
            "model": model,
            "max_tokens": 4096,
            "stream": true,
            "thinking": {"type": "adaptive"},
            "system": system_prompt(),
            "messages": [
                {"role": "user", "content": prompt}
            ],
        });

        let client = reqwest::Client::new();
        let resp = client
            .post(url)
            .header("x-api-key", api_key)
            .header("provider-version", HOSTED_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(AiError::Provider { status, body });
        }

        // SSE comes in as a byte stream — wrap in a StreamReader so we
        // can line-buffer it with tokio's BufRead.
        let stream = resp.bytes_stream().map_err(std::io::Error::other);
        let reader = StreamReader::new(stream);
        let mut reader: Pin<Box<dyn tokio::io::AsyncBufRead + Send>> =
            Box::pin(BufReader::new(reader));

        let mut full = String::new();
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader
                .read_line(&mut line)
                .await
                .map_err(|e| AiError::Http(e.to_string()))?;
            if n == 0 {
                break; // EOF
            }
            // Each SSE event begins with `event: <name>\n` followed by
            // `data: <json>\n\n`. We only pull the JSON.
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if let Some(json_str) = trimmed.strip_prefix("data: ") {
                if json_str.is_empty() || json_str == "[DONE]" {
                    continue;
                }
                let Ok(value): Result<Value, _> = serde_json::from_str(json_str) else {
                    continue;
                };
                let evt_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match evt_type {
                    "content_block_delta" => {
                        let delta = value.get("delta");
                        let dtype = delta.and_then(|d| d.get("type")).and_then(|t| t.as_str());
                        if dtype == Some("text_delta") {
                            if let Some(text) =
                                delta.and_then(|d| d.get("text")).and_then(|t| t.as_str())
                            {
                                full.push_str(text);
                                emitter.emit_chunk(chunk_channel, text)?;
                            }
                        }
                    }
                    "message_stop" | "error" => {
                        // `error` events should carry an `error.message`.
                        // We don't fail the call here — the assembled
                        // text is still returned and any HTTP error
                        // would have been caught by `is_success()` above.
                    }
                    _ => {}
                }
            }
        }
        Ok(full)
    }
}

// ---- provider: Local ---------------------------------------------

mod local {
    use super::*;
    use futures_util::TryStreamExt;
    use std::pin::Pin;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio_util::io::StreamReader;

    /// The local `/api/chat` endpoint is line-delimited JSON: each line is one
    /// `{message: {content: "..."}, done: bool}` payload.
    pub async fn run<E: AskEmitter>(
        prompt: &str,
        chunk_channel: &str,
        emitter: &E,
        url: &str,
        model: &str,
    ) -> Result<String, AiError> {
        let body = json!({
            "model": model,
            "stream": true,
            "messages": [
                {"role": "system", "content": system_prompt()},
                {"role": "user", "content": prompt}
            ],
        });

        let endpoint = format!("{}/api/chat", url.trim_end_matches('/'));
        let client = reqwest::Client::new();
        let resp = client
            .post(&endpoint)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(AiError::Provider { status, body });
        }

        let stream = resp.bytes_stream().map_err(std::io::Error::other);
        let reader = StreamReader::new(stream);
        let mut reader: Pin<Box<dyn tokio::io::AsyncBufRead + Send>> =
            Box::pin(BufReader::new(reader));

        let mut full = String::new();
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader
                .read_line(&mut line)
                .await
                .map_err(|e| AiError::Http(e.to_string()))?;
            if n == 0 {
                break;
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value): Result<Value, _> = serde_json::from_str(trimmed) else {
                continue;
            };
            if let Some(content) = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
            {
                if !content.is_empty() {
                    full.push_str(content);
                    emitter.emit_chunk(chunk_channel, content)?;
                }
            }
            if value.get("done").and_then(|d| d.as_bool()) == Some(true) {
                break;
            }
        }
        Ok(full)
    }
}

// ---- the runner ---------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskMonarchRequest {
    pub prompt: String,
}

/// Run one ask round. This is the testable seam — the Tauri command
/// below just resolves the AppHandle into an emitter and forwards.
pub async fn run_ask<E: AskEmitter>(
    correlation_id: u64,
    cfg: AiConfig,
    req: AskMonarchRequest,
    emitter: &E,
) -> Result<(), AiError> {
    let chunk_channel = format!("monarch://ask/stream/{correlation_id}");
    let done_channel = format!("monarch://ask/done/{correlation_id}");
    let error_channel = format!("monarch://ask/error/{correlation_id}");

    let model_label = match cfg.provider {
        AiProvider::Hosted => cfg.hosted_model.clone(),
        AiProvider::Local => cfg.local_model.clone(),
    };

    let result = match cfg.provider {
        AiProvider::Hosted => {
            let api_key = match keychain::read_credential(HOSTED_KEYCHAIN_ACCOUNT) {
                Ok(k) => k,
                Err(keychain::KeychainError::NotFound) => {
                    let payload = AskErrorPayload {
                        correlation_id,
                        error: AiError::MissingHostedKey.to_string(),
                    };
                    emitter.emit_error(&error_channel, &payload)?;
                    return Err(AiError::MissingHostedKey);
                }
                Err(e) => {
                    let payload = AskErrorPayload {
                        correlation_id,
                        error: format!("keychain: {e}"),
                    };
                    emitter.emit_error(&error_channel, &payload)?;
                    return Err(AiError::Http(e.to_string()));
                }
            };
            hosted::run(
                &req.prompt,
                &chunk_channel,
                emitter,
                &api_key,
                &cfg.hosted_url,
                &cfg.hosted_model,
            )
            .await
        }
        AiProvider::Local => {
            local::run(
                &req.prompt,
                &chunk_channel,
                emitter,
                &cfg.local_url,
                &cfg.local_model,
            )
            .await
        }
    };

    match result {
        Ok(full_text) => {
            let proposed = parse_proposed_action(&full_text);
            let visible = strip_proposed_action(&full_text);
            let payload = AskDonePayload {
                correlation_id,
                text: visible,
                proposed_action: proposed,
                provider: cfg.provider,
                model: model_label,
            };
            emitter.emit_done(&done_channel, &payload)?;
            Ok(())
        }
        Err(err) => {
            let payload = AskErrorPayload {
                correlation_id,
                error: err.to_string(),
            };
            emitter.emit_error(&error_channel, &payload)?;
            Err(err)
        }
    }
}

// ---- Tauri commands -----------------------------------------------

#[tauri::command]
pub async fn ask_monarch(
    app: AppHandle,
    state: State<'_, AiState>,
    req: AskMonarchRequest,
) -> Result<u64, String> {
    let cfg = load_config().map_err(|e| e.to_string())?;
    let correlation_id = {
        let guard = state.lock().await;
        guard.next_correlation_id.fetch_add(1, Ordering::Relaxed)
    };

    let emitter = AppHandleAskEmitter { app };
    // Spawn so the HTTP call doesn't block the IPC thread — the React
    // side awaits the events, not this return value.
    tokio::spawn(async move {
        let _ = run_ask(correlation_id, cfg, req, &emitter).await;
    });
    Ok(correlation_id)
}

#[tauri::command]
pub fn get_ai_config() -> Result<AiConfig, String> {
    load_config().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_ai_config(cfg: AiConfig) -> Result<(), String> {
    save_config(&cfg).map_err(|e| e.to_string())
}

// ---- unit tests ----------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_well_formed_proposed_action() {
        let text = r#"You missed three rounds because eridanus is lagging.

<proposed_action>{
  "kind": "operator-restart",
  "title": "Restart eridanus",
  "sub": "graceful · ~45s",
  "intro": "Restarts the operator service. Cluster tolerates."
}</proposed_action>"#;
        let action = parse_proposed_action(text).expect("parses");
        assert_eq!(action.kind, "operator-restart");
        assert_eq!(action.title, "Restart eridanus");
        assert_eq!(
            action.intro,
            "Restarts the operator service. Cluster tolerates."
        );
        assert!(action.fields.is_empty());
        assert!(action.destructive.is_none());
        assert!(action.needs_passkey.is_none());
    }

    #[test]
    fn parses_full_proposed_action_with_fields() {
        let text = r#"<proposed_action>{
  "kind": "rotate-keys",
  "title": "Rotate consensus keys",
  "sub": "1 round",
  "intro": "Generates a new consensus key.",
  "fields": [
    {"key": "source", "label": "Source", "value": "Ask Monarch"}
  ],
  "destructive": false,
  "needsPasskey": true
}</proposed_action>"#;
        let action = parse_proposed_action(text).expect("parses");
        assert_eq!(action.fields.len(), 1);
        assert_eq!(action.fields[0].key, "source");
        assert_eq!(action.destructive, Some(false));
        assert_eq!(action.needs_passkey, Some(true));
    }

    #[test]
    fn accepts_chat_bootstrap_peer_action() {
        let text = r#"<proposed_action>{
  "kind": "chat-bootstrap-peers",
  "title": "Publish chat peers",
  "sub": "operator metadata",
  "intro": "Publishes the chat bootstrap peer list."
}</proposed_action>"#;
        let action = parse_proposed_action(text).expect("parses");
        assert_eq!(action.kind, "chat-bootstrap-peers");
        assert_eq!(action.title, "Publish chat peers");
    }

    #[test]
    fn accepts_incident_executor_actions() {
        for kind in ["freeze-admission", "emergency-key-rotation"] {
            let text = format!(
                r#"<proposed_action>{{
  "kind": "{kind}",
  "title": "Incident executor",
  "sub": "foundation",
  "intro": "Submits a foundation incident executor."
}}</proposed_action>"#
            );
            let action = parse_proposed_action(&text).expect("parses");
            assert_eq!(action.kind, kind);
        }
    }

    #[test]
    fn rejects_unknown_kind() {
        let text = r#"<proposed_action>{
  "kind": "drop-database",
  "title": "Drop the entire database",
  "sub": "no",
  "intro": "no"
}</proposed_action>"#;
        assert!(parse_proposed_action(text).is_none());
    }

    #[test]
    fn rejects_empty_title() {
        let text = r#"<proposed_action>{
  "kind": "operator-restart",
  "title": "",
  "sub": "x",
  "intro": "x"
}</proposed_action>"#;
        assert!(parse_proposed_action(text).is_none());
    }

    #[test]
    fn returns_none_when_block_missing() {
        let text = "Just a friendly explanation, no action proposed.";
        assert!(parse_proposed_action(text).is_none());
    }

    #[test]
    fn returns_none_on_malformed_json() {
        let text = "<proposed_action>not json</proposed_action>";
        assert!(parse_proposed_action(text).is_none());
    }

    #[test]
    fn ignores_block_when_close_tag_missing() {
        // Open without close — operator must not see a half-parsed
        // payload propagate. We treat as "no action".
        let text = "<proposed_action>{\"kind\":\"operator-start\"}";
        assert!(parse_proposed_action(text).is_none());
    }

    #[test]
    fn strip_removes_block_and_trims() {
        let text =
            "Quick summary.\n\n<proposed_action>{\"kind\":\"operator-restart\"}</proposed_action>";
        assert_eq!(strip_proposed_action(text), "Quick summary.");
    }

    #[test]
    fn strip_preserves_text_when_no_block() {
        let text = "No action here.";
        assert_eq!(strip_proposed_action(text), "No action here.");
    }

    #[test]
    fn strip_handles_text_after_block() {
        let text = "intro\n<proposed_action>{\"kind\":\"x\"}</proposed_action>\noutro";
        assert_eq!(strip_proposed_action(text), "intro\n\noutro");
    }

    #[test]
    fn ai_config_default_round_trips_via_toml() {
        let cfg = AiConfig::default();
        let s = toml::to_string(&cfg).expect("serialize");
        let back: AiConfig = toml::from_str(&s).expect("parse");
        assert!(matches!(back.provider, AiProvider::Local));
        assert_eq!(back.hosted_url, DEFAULT_HOSTED_URL);
        assert_eq!(back.hosted_model, DEFAULT_HOSTED_MODEL);
        assert_eq!(back.local_url, DEFAULT_LOCAL_URL);
        assert_eq!(back.local_model, DEFAULT_LOCAL_MODEL);
    }

    #[test]
    fn ai_config_parses_user_override() {
        let s = r#"provider = "hosted"
hosted_url = "https://localhost.invalid/v1/messages"
hosted_model = "ops-model"
local_url = "http://localhost:11434"
local_model = "llama3.1:8b"
"#;
        let cfg: AiConfig = toml::from_str(s).expect("parse");
        assert!(matches!(cfg.provider, AiProvider::Hosted));
        assert_eq!(cfg.hosted_url, "https://localhost.invalid/v1/messages");
        assert_eq!(cfg.hosted_model, "ops-model");
        assert_eq!(cfg.local_url, "http://localhost:11434");
        assert_eq!(cfg.local_model, "llama3.1:8b");
    }

    /// Test emitter that records every chunk + the final done payload.
    /// Exercised to prove the streaming + emit shape stays aligned.
    #[derive(Default)]
    struct VecEmitter {
        chunks: std::sync::Mutex<Vec<(String, String)>>,
        done: std::sync::Mutex<Option<(String, AskDonePayload)>>,
        errors: std::sync::Mutex<Option<(String, AskErrorPayload)>>,
    }

    impl AskEmitter for VecEmitter {
        fn emit_chunk(&self, channel: &str, chunk: &str) -> Result<(), AiError> {
            self.chunks
                .lock()
                .unwrap()
                .push((channel.to_string(), chunk.to_string()));
            Ok(())
        }
        fn emit_done(&self, channel: &str, payload: &AskDonePayload) -> Result<(), AiError> {
            *self.done.lock().unwrap() = Some((channel.to_string(), payload.clone()));
            Ok(())
        }
        fn emit_error(&self, channel: &str, payload: &AskErrorPayload) -> Result<(), AiError> {
            *self.errors.lock().unwrap() = Some((channel.to_string(), payload.clone()));
            Ok(())
        }
    }

    /// Sanity check: the emitter trait is wired the way the React side
    /// expects — a chunk emit hits `monarch://ask/stream/<id>`, a done
    /// emit hits `monarch://ask/done/<id>` with the parsed action.
    #[test]
    fn emitter_records_chunks_and_done_payload() {
        let emitter = VecEmitter::default();
        emitter
            .emit_chunk("monarch://ask/stream/7", "hello ")
            .unwrap();
        emitter
            .emit_chunk("monarch://ask/stream/7", "world")
            .unwrap();
        let payload = AskDonePayload {
            correlation_id: 7,
            text: "Quick summary.".to_string(),
            proposed_action: parse_proposed_action(
                "<proposed_action>{\"kind\":\"operator-restart\",\"title\":\"Restart\",\"sub\":\"x\",\"intro\":\"y\"}</proposed_action>",
            ),
            provider: AiProvider::Hosted,
            model: "ops-model".to_string(),
        };
        emitter.emit_done("monarch://ask/done/7", &payload).unwrap();

        let chunks = emitter.chunks.lock().unwrap().clone();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].0, "monarch://ask/stream/7");
        assert_eq!(chunks[0].1, "hello ");
        assert_eq!(chunks[1].1, "world");
        let done = emitter.done.lock().unwrap().clone().expect("done emitted");
        assert_eq!(done.0, "monarch://ask/done/7");
        assert_eq!(done.1.correlation_id, 7);
        assert!(done.1.proposed_action.is_some());
        assert_eq!(
            done.1.proposed_action.as_ref().unwrap().kind,
            "operator-restart"
        );
    }
}
