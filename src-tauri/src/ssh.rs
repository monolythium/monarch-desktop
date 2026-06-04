// SSH bridge — minimal russh client wrapper.
//
// The SSH bridge scope is intentionally narrow:
//
//   * `connect(target)` opens an authenticated session using the
//     `SshTarget` struct (host + user + key_path). Operators store
//     their key path (and optional passphrase) in the OS keychain via
//     `keychain.rs`; we don't read raw key material out of the keychain
//     here — the entry holds the *path*, the file system holds the
//     bytes. (Tauri gets file-system access; russh-keys parses,
//     decrypts, and discards.)
//   * `exec(session, cmd)` runs a single command and returns stdout.
//   * `exec_stream(...)` spawns a long-running command (e.g. `journalctl
//     -fu monod`) on a dedicated channel, reads lines as they arrive,
//     and emits each line back to the React side as a Tauri event so
//     the Logs view can render a live tail. A unique `session_id` is
//     returned and used to cancel the stream via `exec_cancel`.
//
// What we deliberately *don't* do here:
//
//   * No interactive shell.
//   * No SFTP file transfer (out of scope; brief explicitly excludes it).
//   * No fingerprint pinning yet — `check_server_key` accepts any key
//     because the OS keychain doesn't yet hold the host fingerprint.
//     Pin host fingerprints before any
//     real signing path lands. Tracked alongside the broader keychain
//     hardening work.
//
// All public functions are async + tokio because russh's client is
// async-only. We hold the open `Session` inside a `tokio::Mutex` behind
// a `tauri::State` so the same connection survives between commands;
// streaming sessions live in a separate map keyed by `session_id` so
// concurrent streams (e.g. two Logs tabs on different operators) stay
// independent.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{self, Handle, Handler};
use russh::keys::key::PublicKey;
use russh::keys::load_secret_key;
use russh::{ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::keychain;

/// Operator-facing errors. Stringified at the Tauri boundary.
#[derive(Debug, Error)]
pub enum SshError {
    #[error("ssh connection error: {0}")]
    Connection(String),
    #[error("ssh authentication failed for user {0}")]
    AuthFailed(String),
    #[error("ssh key load error: {0}")]
    KeyLoad(String),
    #[error("ssh exec error: {0}")]
    Exec(String),
    #[error("ssh utf-8 error: {0}")]
    Utf8(String),
    #[error("no active ssh session — call ssh_connect first")]
    NoSession,
    #[error("keychain: {0}")]
    Keychain(String),
}

impl From<russh::Error> for SshError {
    fn from(err: russh::Error) -> Self {
        SshError::Connection(err.to_string())
    }
}

impl From<russh::keys::Error> for SshError {
    fn from(err: russh::keys::Error) -> Self {
        SshError::KeyLoad(err.to_string())
    }
}

impl From<keychain::KeychainError> for SshError {
    fn from(err: keychain::KeychainError) -> Self {
        SshError::Keychain(err.to_string())
    }
}

/// Where to dial. The React side hands us this verbatim — for known
/// testnet operators it's pre-filled from a static dropdown; in the
/// keychain-driven flow it's reassembled from `ssh:host` / `ssh:user`
/// / `ssh:key-path`. Currently the live `ssh_connect` command takes
/// the three fields as separate args (existing call sites depend on
/// that shape); this struct exists so future commands and the React
/// side can pass them as one bundle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct SshTarget {
    pub host: String,
    pub user: String,
    #[serde(rename = "keyPath")]
    pub key_path: String,
}

/// Trust-on-first-use server-key handler. Every server key is accepted
/// today; pinning lands with the broader keychain hardening work above.
struct AcceptAllKeys;

#[async_trait]
impl Handler for AcceptAllKeys {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// Live SSH session. Held inside a tokio Mutex so concurrent
/// `ssh_exec` calls serialize cleanly without cloning channels.
pub struct SshSession {
    handle: Handle<AcceptAllKeys>,
    /// Best-effort label used in error messages.
    pub host: String,
    pub user: String,
}

/// One in-flight stream — `journalctl -fu monod` and friends. Holding
/// the abort handle lets `ssh_exec_cancel` tear the channel down
/// promptly without waiting for the next message. `session_id` is
/// duplicated from the map key so dump/diagnostic code can hand the
/// struct out without a separate index lookup.
pub struct StreamHandle {
    #[allow(dead_code)]
    pub session_id: u64,
    pub abort: JoinHandle<()>,
}

/// Tauri-managed singleton. The shared session is `Option` because a
/// fresh app boot has no session until the operator wires their host;
/// the streams map sits alongside so cancel can drop in O(1).
pub struct SshStateInner {
    pub session: Option<SshSession>,
    pub streams: HashMap<u64, StreamHandle>,
    pub next_session_id: AtomicU64,
}

impl SshStateInner {
    pub fn new() -> Self {
        Self {
            session: None,
            streams: HashMap::new(),
            next_session_id: AtomicU64::new(1),
        }
    }
}

impl Default for SshStateInner {
    fn default() -> Self {
        Self::new()
    }
}

pub type SshState = Arc<Mutex<SshStateInner>>;

/// Open a russh client to `<user>@<host>:22`, authenticate using the
/// private key at `key_path`, and return a held session. The optional
/// passphrase is read from the keychain (`account = ssh:passphrase`)
/// when present so encrypted keys still work.
pub async fn connect(host: &str, user: &str, key_path: &str) -> Result<SshSession, SshError> {
    let key_path = Path::new(key_path);

    // Encrypted keys: try the keychain for a passphrase. Absence is fine.
    let passphrase = match keychain::read_credential("ssh:passphrase") {
        Ok(p) => Some(p),
        Err(keychain::KeychainError::NotFound) => None,
        Err(e) => return Err(SshError::Keychain(e.to_string())),
    };
    let pass_ref = passphrase.as_deref();

    let key_pair =
        load_secret_key(key_path, pass_ref).map_err(|e| SshError::KeyLoad(e.to_string()))?;

    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    };
    let config = Arc::new(config);

    let addrs = (host, 22u16);
    let mut handle = client::connect(config, addrs, AcceptAllKeys)
        .await
        .map_err(|e| SshError::Connection(e.to_string()))?;

    let auth_ok = handle
        .authenticate_publickey(user, Arc::new(key_pair))
        .await?;
    if !auth_ok {
        return Err(SshError::AuthFailed(user.to_string()));
    }

    Ok(SshSession {
        handle,
        host: host.to_string(),
        user: user.to_string(),
    })
}

/// Run a single command on an existing session and return captured
/// stdout as a UTF-8 string. Stderr + non-zero exit codes surface as
/// `SshError::Exec` so the drawer can render the failure halo verbatim.
pub async fn exec(session: &mut SshSession, cmd: &str) -> Result<String, SshError> {
    let mut channel = session
        .handle
        .channel_open_session()
        .await
        .map_err(|e| SshError::Exec(e.to_string()))?;
    channel
        .exec(true, cmd)
        .await
        .map_err(|e| SshError::Exec(e.to_string()))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code: Option<u32> = None;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
            ChannelMsg::ExtendedData { ref data, ext: 1 } => stderr.extend_from_slice(data),
            ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
            _ => {}
        }
    }

    let stdout_str = String::from_utf8(stdout).map_err(|e| SshError::Utf8(e.to_string()))?;

    match exit_code {
        Some(0) => Ok(stdout_str),
        Some(code) => {
            let stderr_str = String::from_utf8_lossy(&stderr);
            Err(SshError::Exec(format!(
                "exit {} on {}@{}: {}",
                code,
                session.user,
                session.host,
                stderr_str.trim()
            )))
        }
        None => {
            // Some servers close the channel without sending an exit
            // status (e.g. for `exec` with no stdout). Treat that as
            // success rather than tripping the drawer.
            Ok(stdout_str)
        }
    }
}

/// Tear down the session politely so the server doesn't see a dropped
/// connection. Ignored errors — we're best-effort on close.
pub async fn close(session: &mut SshSession) -> Result<(), SshError> {
    let _ = session
        .handle
        .disconnect(Disconnect::ByApplication, "", "en")
        .await;
    Ok(())
}

// ---- streaming primitives -----------------------------------------
//
// `journalctl -fu monod -o json` writes one JSON object per line. We
// don't try to parse it on the Rust side — the React side already has
// the journald shape (`__REALTIME_TIMESTAMP`, `MESSAGE`, `PRIORITY`)
// and would have to re-marshal anyway. Our job is line-buffering: read
// chunks off the russh channel, split on `\n`, emit each completed
// line as a Tauri event, and keep the trailing partial in a buffer.
//
// `LineBuffer` is the unit-tested core; `pump_lines` glues russh's
// `ChannelMsg::Data` stream onto it.

/// Stateful line splitter. `feed(chunk)` returns every completed line
/// it could pull out of the buffer; the trailing partial sticks
/// around for the next chunk.
#[derive(Default)]
pub struct LineBuffer {
    pending: Vec<u8>,
}

impl LineBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed `chunk`, return zero or more completed lines (UTF-8). Lines
    /// keep their original byte order; CR and LF are stripped at the
    /// boundary so callers don't have to.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(idx) = self.pending.iter().position(|b| *b == b'\n') {
            let mut line = self.pending.drain(..=idx).collect::<Vec<u8>>();
            // Drop the trailing '\n' (and '\r' if CRLF).
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            out.push(String::from_utf8_lossy(&line).into_owned());
        }
        out
    }

    /// Drain whatever remains as a final partial line. Useful when the
    /// channel closes without a trailing newline so a half-line still
    /// reaches the UI before the stream marker fires.
    pub fn flush(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let bytes = std::mem::take(&mut self.pending);
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

/// Trait kept tiny so the unit test can swap in a fake emitter without
/// pulling in `tauri::AppHandle`. The production impl in
/// `pump_lines` uses Tauri's `Emitter`; the test impl pushes into a
/// shared `Vec`.
pub trait LineEmitter: Send + Sync + 'static {
    fn emit_line(&self, channel: &str, line: &str) -> Result<(), String>;
}

/// Tauri-side emitter. Bound to a single `AppHandle` clone.
pub struct AppHandleEmitter {
    pub app: AppHandle,
}

impl LineEmitter for AppHandleEmitter {
    fn emit_line(&self, channel: &str, line: &str) -> Result<(), String> {
        self.app
            .emit(channel, line)
            .map_err(|e| format!("emit failed on {channel}: {e}"))
    }
}

/// Read every chunk that arrives on the AsyncRead, split into lines,
/// emit each line via `emitter`. Returns when the source closes.
///
/// Kept generic so the unit test can drive it with `tokio::io::Cursor`
/// and a mock emitter rather than spinning up an SSH server.
pub async fn pump_lines<R, E>(mut source: R, emitter: E, channel: String) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin,
    E: LineEmitter,
{
    use tokio::io::AsyncReadExt;
    let mut buf = LineBuffer::new();
    let mut chunk = vec![0u8; 8 * 1024];
    loop {
        let n = source
            .read(&mut chunk)
            .await
            .map_err(|e| format!("ssh stream read: {e}"))?;
        if n == 0 {
            // EOF — drain any partial line so the UI doesn't lose it.
            if let Some(tail) = buf.flush() {
                emitter.emit_line(&channel, &tail)?;
            }
            return Ok(());
        }
        for line in buf.feed(&chunk[..n]) {
            emitter.emit_line(&channel, &line)?;
        }
    }
}

// ---- Tauri command wrappers ---------------------------------------

#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, SshState>,
    host: String,
    user: String,
    key_path: String,
) -> Result<(), String> {
    let session = connect(&host, &user, &key_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut guard = state.lock().await;
    // Replace any stale session — the new one wins. Cancel any
    // streams attached to the old session so they don't leak.
    if let Some(mut prev) = guard.session.take() {
        let _ = close(&mut prev).await;
    }
    for (_, sh) in guard.streams.drain() {
        sh.abort.abort();
    }
    guard.session = Some(session);
    Ok(())
}

/// Run `cmd` against the held session. If no session is open, the
/// React side gets a typed `NoSession` error so it can fall back to
/// the mock drawer flow rather than appearing to hang.
#[tauri::command]
pub async fn ssh_exec(state: State<'_, SshState>, cmd: String) -> Result<String, String> {
    let mut guard = state.lock().await;
    let session = guard
        .session
        .as_mut()
        .ok_or_else(|| SshError::NoSession.to_string())?;
    exec(session, &cmd).await.map_err(|e| e.to_string())
}

/// Returns the active host/user pair, if any. Used by the React
/// Settings pane to render the "connected" state without round-trips.
#[tauri::command]
pub async fn ssh_status(state: State<'_, SshState>) -> Result<Option<(String, String)>, String> {
    let guard = state.lock().await;
    Ok(guard
        .session
        .as_ref()
        .map(|s| (s.host.clone(), s.user.clone())))
}

/// Close the current session and drop it. No-op if no session is open.
#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, SshState>) -> Result<(), String> {
    let mut guard = state.lock().await;
    for (_, sh) in guard.streams.drain() {
        sh.abort.abort();
    }
    if let Some(mut session) = guard.session.take() {
        let _ = close(&mut session).await;
    }
    Ok(())
}

/// Spawn a streaming command (typically `journalctl -fu monod -o
/// json`) on a fresh channel. Each completed stdout line is re-emitted
/// as a Tauri event named `monarch://ssh-log/<session_id>` so the
/// React side can subscribe via `listen()`. Returns the `session_id`
/// the React side passes back to `ssh_exec_cancel`.
#[tauri::command]
pub async fn ssh_exec_stream(
    app: AppHandle,
    state: State<'_, SshState>,
    cmd: String,
) -> Result<u64, String> {
    let mut guard = state.lock().await;
    // Pull the next id first so we don't double-borrow `guard` across
    // the upcoming mutable borrow of `guard.session`.
    let session_id = guard.next_session_id.fetch_add(1, Ordering::Relaxed);
    let session = guard
        .session
        .as_mut()
        .ok_or_else(|| SshError::NoSession.to_string())?;

    // Open the channel and start the command on it. We hand the channel
    // to the background pump task by `into_stream()` — that yields an
    // `AsyncRead` covering stdout, which is exactly what `pump_lines`
    // expects.
    let channel = session
        .handle
        .channel_open_session()
        .await
        .map_err(|e| format!("ssh channel open: {e}"))?;
    channel
        .exec(true, cmd.as_bytes())
        .await
        .map_err(|e| format!("ssh exec: {e}"))?;

    // `into_stream()` consumes the channel and yields an AsyncRead /
    // AsyncWrite pair covering stdout. Cancellation works by aborting
    // the pump task (which drops the stream) — no need to keep the
    // raw `ChannelId` around.
    let stream = channel.into_stream();

    let event_channel = format!("monarch://ssh-log/{session_id}");
    let emitter = AppHandleEmitter { app: app.clone() };
    let event_channel_for_task = event_channel.clone();

    let abort = tokio::spawn(async move {
        let _ = pump_lines(stream, emitter, event_channel_for_task).await;
        // Best-effort terminator so the React side can flip the halo
        // off when the stream closes naturally (e.g. journalctl exit).
        let _ = app.emit(
            &format!("monarch://ssh-log/{session_id}/end"),
            "stream-closed",
        );
    });

    guard
        .streams
        .insert(session_id, StreamHandle { session_id, abort });

    Ok(session_id)
}

/// Cancel a stream started by `ssh_exec_stream`. Idempotent — if the
/// id is unknown (already cancelled, never created) we return Ok.
#[tauri::command]
pub async fn ssh_exec_cancel(state: State<'_, SshState>, session_id: u64) -> Result<(), String> {
    let mut guard = state.lock().await;
    if let Some(handle) = guard.streams.remove(&session_id) {
        handle.abort.abort();
    }
    Ok(())
}

// ---- unit tests ---------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// `(channel, line)` pairs collected by the test emitter. Aliased
    /// to keep clippy's `type_complexity` lint happy.
    type EventLog = Arc<StdMutex<Vec<(String, String)>>>;

    /// Test emitter that records every (channel, line) pair so we can
    /// assert order + content without spinning up a Tauri runtime.
    #[derive(Default)]
    struct VecEmitter {
        events: EventLog,
    }

    impl VecEmitter {
        fn new() -> (Self, EventLog) {
            let events: EventLog = Arc::new(StdMutex::new(Vec::new()));
            (
                Self {
                    events: events.clone(),
                },
                events,
            )
        }
    }

    impl LineEmitter for VecEmitter {
        fn emit_line(&self, channel: &str, line: &str) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push((channel.to_string(), line.to_string()));
            Ok(())
        }
    }

    #[test]
    fn line_buffer_splits_on_newlines() {
        let mut buf = LineBuffer::new();
        let lines = buf.feed(b"hello\nworld\n");
        assert_eq!(lines, vec!["hello".to_string(), "world".to_string()]);
        // Nothing left over.
        assert!(buf.flush().is_none());
    }

    #[test]
    fn line_buffer_holds_partial_until_newline() {
        let mut buf = LineBuffer::new();
        let a = buf.feed(b"par");
        assert!(a.is_empty());
        let b = buf.feed(b"tial\nnext");
        assert_eq!(b, vec!["partial".to_string()]);
        // "next" is still pending — flush completes it.
        assert_eq!(buf.flush(), Some("next".to_string()));
    }

    #[test]
    fn line_buffer_strips_crlf() {
        let mut buf = LineBuffer::new();
        let lines = buf.feed(b"alpha\r\nbeta\r\n");
        assert_eq!(lines, vec!["alpha".to_string(), "beta".to_string()]);
    }

    #[test]
    fn line_buffer_handles_empty_lines() {
        let mut buf = LineBuffer::new();
        let lines = buf.feed(b"\n\nthird\n");
        assert_eq!(
            lines,
            vec!["".to_string(), "".to_string(), "third".to_string()]
        );
    }

    #[tokio::test]
    async fn pump_lines_emits_each_line_in_order() {
        let payload = b"first line\nsecond line\nthird\n";
        let cursor = std::io::Cursor::new(payload.to_vec());
        let (emitter, log) = VecEmitter::new();

        pump_lines(cursor, emitter, "monarch://ssh-log/42".to_string())
            .await
            .expect("pump succeeds on cursor input");

        let recorded = log.lock().unwrap().clone();
        assert_eq!(recorded.len(), 3, "three lines emitted");
        assert_eq!(recorded[0].0, "monarch://ssh-log/42");
        assert_eq!(recorded[0].1, "first line");
        assert_eq!(recorded[1].1, "second line");
        assert_eq!(recorded[2].1, "third");
    }

    #[tokio::test]
    async fn pump_lines_flushes_partial_line_at_eof() {
        // No trailing newline — the journald JSON shouldn't be missing
        // its closing brace, but a remote stream cancel mid-flight can
        // produce one. We must still surface what we have.
        let payload = b"complete\nhalf";
        let cursor = std::io::Cursor::new(payload.to_vec());
        let (emitter, log) = VecEmitter::new();

        pump_lines(cursor, emitter, "ch".to_string())
            .await
            .expect("pump succeeds on cursor input");

        let recorded = log.lock().unwrap().clone();
        assert_eq!(
            recorded,
            vec![
                ("ch".to_string(), "complete".to_string()),
                ("ch".to_string(), "half".to_string()),
            ],
            "partial line is flushed at EOF"
        );
    }

    #[tokio::test]
    async fn pump_lines_handles_chunked_writes() {
        // Simulate a slow ssh channel where one logical line arrives
        // across two reads — the reader-side buffer must reassemble.
        use tokio::io::duplex;
        use tokio::io::AsyncWriteExt;

        let (mut tx, rx) = duplex(64);
        let (emitter, log) = VecEmitter::new();

        let pump_task = tokio::spawn(pump_lines(rx, emitter, "split".to_string()));

        tx.write_all(b"jour").await.unwrap();
        tx.write_all(b"nald\nopened\n").await.unwrap();
        drop(tx); // EOF
        pump_task.await.unwrap().expect("pump ok");

        let recorded = log.lock().unwrap().clone();
        assert_eq!(
            recorded,
            vec![
                ("split".to_string(), "journald".to_string()),
                ("split".to_string(), "opened".to_string()),
            ]
        );
    }
}
