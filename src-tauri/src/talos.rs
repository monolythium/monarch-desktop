// Talos control bridge for Monarch OS.
//
// Monarch OS does not expose SSH. This module gives the desktop app a
// native mTLS control path over the Talos API using the operator's
// `talosconfig`. It intentionally avoids shelling out to `talosctl` so
// signed releases can be self-contained.

use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use prost::Message as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use talos_rust_client::generated::{common, google, machine, storage};
use talos_rust_client::talosconfig::TalosConfig;
use talos_rust_client::{MachineServiceClient, StorageServiceClient, TalosConnector};
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use x509_parser::prelude::{ASN1Time, GeneralName, Pem};

use crate::keychain;

const TALOS_ENDPOINT_ACCOUNT: &str = "talos:endpoint";
const TALOS_CONFIG_PATH_ACCOUNT: &str = "talos:config-path";
const TALOS_CA_FINGERPRINT_ACCOUNT: &str = "talos:ca-fingerprint";
const TALOS_TIMEOUT: Duration = Duration::from_secs(12);
const TALOS_BACKUP_TIMEOUT: Duration = Duration::from_secs(300);
const PROTOCORE_RPC_TIMEOUT: Duration = Duration::from_secs(4);
// The general in-app RPC read transport (rpc_proxy) carries every dashboard
// read, so it gets a more forgiving budget than the 4s health bridges.
const RPC_PROXY_TIMEOUT: Duration = Duration::from_secs(20);
const DEFAULT_SERVICE_ID: &str = "ext-protocore";
// Talos `MachineService.Logs` requires a NON-EMPTY namespace — an empty one is
// rejected with `InvalidArgument: "namespace can't be empty"` (observed live on
// Talos v1.13.0; the prior empty value left the Logs panel dead). `ext-protocore`
// is a Talos extension service that runs as a containerd container in the
// `system` namespace, so `talosctl logs ext-protocore` reads it with namespace
// `system` + the Containerd driver. We mirror that exact shape so the
// follow/one-shot tails carry the protocore process stdout/stderr the extension
// captures.
const TALOS_SERVICE_LOG_NAMESPACE: &str = "system";
const PROTOCORE_DATA_DIR: &str = "/var/lib/protocore";
// Where the protocore extension's systemd unit appends stdout/stderr
// (`StandardOutput=append:/var/lib/protocore/logs/protocore.log`). The `append:`
// redirect never rotates, so this directory grows unbounded — the Log
// management surface reports its size (read) and patches retention (config).
const PROTOCORE_LOG_DIR: &str = "/var/lib/protocore/logs";
const PROTOCORE_OPERATOR_SEAL_EK_PATH: &str =
    "/var/lib/protocore/operator/threshold/lythiumseal-operator-key.ek";
const PROTOCORE_OPERATOR_SEAL_EK_HEX_LEN: usize = 1_184 * 2;
const TALOS_CERT_EXPIRY_WARNING_DAYS: i64 = 30;

#[derive(Debug, Error)]
pub enum TalosError {
    #[error("Talos endpoint is required")]
    MissingEndpoint,
    #[error("talosconfig path is required")]
    MissingConfigPath,
    #[error("Talos endpoint contains unsupported whitespace")]
    InvalidEndpoint,
    #[error("talosconfig does not exist: {0}")]
    ConfigNotFound(String),
    #[error("talosconfig has no active context")]
    MissingContext,
    #[error("talosconfig context has no endpoint")]
    MissingContextEndpoint,
    #[error("unsupported service name: {0}")]
    InvalidService(String),
    #[error("unsupported service action: {0}")]
    InvalidServiceAction(String),
    #[error("unsupported Talos reboot mode: {0}")]
    InvalidRebootMode(String),
    #[error("invalid Talos upgrade image reference: {0}")]
    InvalidUpgradeImage(String),
    #[error("invalid log retention policy: {0}")]
    InvalidLogRetention(String),
    #[error("keychain: {0}")]
    Keychain(String),
    #[error("talosconfig: {0}")]
    Config(String),
    #[error("Talos API timed out")]
    Timeout,
    #[error("Talos API failed: {0}")]
    Api(String),
    #[error("backup export failed: {0}")]
    Backup(String),
    #[error("filesystem failed: {0}")]
    FileSystem(String),
}

impl From<keychain::KeychainError> for TalosError {
    fn from(err: keychain::KeychainError) -> Self {
        TalosError::Keychain(err.to_string())
    }
}

impl From<talos_rust_client::Error> for TalosError {
    fn from(err: talos_rust_client::Error) -> Self {
        TalosError::Config(err.to_string())
    }
}

impl From<talos_rust_client::tonic::Status> for TalosError {
    fn from(err: talos_rust_client::tonic::Status) -> Self {
        TalosError::Api(err.to_string())
    }
}

#[derive(Debug)]
pub struct TalosLogStreamHandle {
    #[allow(dead_code)]
    pub session_id: u64,
    pub abort: JoinHandle<()>,
}

#[derive(Default)]
struct TalosLineBuffer {
    pending: Vec<u8>,
}

impl TalosLineBuffer {
    fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(idx) = self.pending.iter().position(|b| *b == b'\n') {
            let mut line = self.pending.drain(..=idx).collect::<Vec<u8>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            out.push(String::from_utf8_lossy(&line).into_owned());
        }
        out
    }

    fn flush(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        Some(String::from_utf8_lossy(&std::mem::take(&mut self.pending)).into_owned())
    }
}

#[derive(Debug)]
pub struct TalosStateInner {
    pub endpoint: Option<String>,
    pub config_path: Option<String>,
    pub log_streams: HashMap<u64, TalosLogStreamHandle>,
    pub next_session_id: u64,
}

impl TalosStateInner {
    pub fn new() -> Self {
        Self {
            endpoint: None,
            config_path: None,
            log_streams: HashMap::new(),
            next_session_id: 1,
        }
    }
}

impl Default for TalosStateInner {
    fn default() -> Self {
        Self::new()
    }
}

pub type TalosState = Arc<Mutex<TalosStateInner>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosStatus {
    pub configured: bool,
    pub reachable: bool,
    pub endpoint: Option<String>,
    #[serde(rename = "nodeAddress")]
    pub node_address: Option<String>,
    #[serde(rename = "configPath")]
    pub config_path: Option<String>,
    #[serde(rename = "clientMode")]
    pub client_mode: String,
    pub version: Option<String>,
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosCertificateInfo {
    pub role: String,
    pub subject: String,
    pub issuer: String,
    #[serde(rename = "notBefore")]
    pub not_before: String,
    #[serde(rename = "notAfter")]
    pub not_after: String,
    #[serde(rename = "sha256Fingerprint")]
    pub sha256_fingerprint: String,
    pub expired: bool,
    #[serde(rename = "notYetValid")]
    pub not_yet_valid: bool,
    #[serde(rename = "expiresInDays")]
    pub expires_in_days: i64,
    #[serde(rename = "dnsNames")]
    pub dns_names: Vec<String>,
    #[serde(rename = "ipAddresses")]
    pub ip_addresses: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosConfigInfo {
    pub path: String,
    pub context: String,
    pub endpoint: String,
    #[serde(rename = "serverName")]
    pub server_name: String,
    #[serde(rename = "caFingerprint")]
    pub ca_fingerprint: String,
    #[serde(rename = "trustedCaFingerprint")]
    pub trusted_ca_fingerprint: Option<String>,
    #[serde(rename = "caPinStatus")]
    pub ca_pin_status: String,
    pub endpoints: Vec<String>,
    pub nodes: Vec<String>,
    pub certificates: Vec<TalosCertificateInfo>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosServiceEvent {
    pub message: String,
    pub state: String,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosServiceInfo {
    pub id: String,
    pub state: String,
    #[serde(rename = "displayState")]
    pub display_state: String,
    pub severity: String,
    pub summary: String,
    pub healthy: Option<bool>,
    #[serde(rename = "healthUnknown")]
    pub health_unknown: Option<bool>,
    #[serde(rename = "healthMessage")]
    pub health_message: Option<String>,
    #[serde(rename = "lastEvent")]
    pub last_event: Option<TalosServiceEvent>,
    pub events: Vec<TalosServiceEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosTextResult {
    pub endpoint: String,
    #[serde(rename = "nodeAddress")]
    pub node_address: String,
    pub command: String,
    pub output: String,
    pub service: Option<TalosServiceInfo>,
}

/// One regular file under the protocore log directory, as reported by the
/// Talos `List` RPC. Sizes/timestamps are the node's own, never synthesised.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosLogFile {
    pub name: String,
    pub size: i64,
    /// UNIX seconds of last modification, when the node reported one.
    pub modified: Option<i64>,
}

/// Disk usage of the protocore log directory, sourced from the Talos
/// `DiskUsage` + `List` RPCs. Pure read — no fabricated numbers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosLogDiskUsage {
    pub endpoint: String,
    #[serde(rename = "nodeAddress")]
    pub node_address: String,
    pub path: String,
    /// Total bytes under `path` as reported by `du`.
    #[serde(rename = "totalBytes")]
    pub total_bytes: i64,
    /// Per-file breakdown (regular files only), newest/largest first as the
    /// node returns them.
    pub files: Vec<TalosLogFile>,
}

/// Disk usage of the protocore data directory (`/var/lib/protocore` — the chain
/// DB + resolved genesis + config), sourced from the Talos `DiskUsage` RPC. Pure
/// read. The Hardware view pairs this byte total with the node's uptime to derive
/// an *immediate* disk-growth pace before any local time-series has accrued.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosDataDirUsage {
    pub endpoint: String,
    #[serde(rename = "nodeAddress")]
    pub node_address: String,
    pub path: String,
    /// Total bytes under `path` as reported by `du`.
    #[serde(rename = "totalBytes")]
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosBackupResult {
    pub endpoint: String,
    #[serde(rename = "nodeAddress")]
    pub node_address: String,
    pub command: String,
    pub output: String,
    #[serde(rename = "archivePath")]
    pub archive_path: String,
    #[serde(rename = "archiveSha256")]
    pub archive_sha256: String,
    #[serde(rename = "archiveSizeBytes")]
    pub archive_size_bytes: u64,
    #[serde(rename = "manifestPath")]
    pub manifest_path: String,
    #[serde(rename = "manifestSha256")]
    pub manifest_sha256: String,
    #[serde(rename = "sourcePath")]
    pub source_path: String,
    pub service: Option<TalosServiceInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosOperatorSealEkResult {
    pub endpoint: String,
    #[serde(rename = "nodeAddress")]
    pub node_address: String,
    pub command: String,
    pub path: String,
    #[serde(rename = "sealEkHex")]
    pub seal_ek_hex: String,
    #[serde(rename = "sha256")]
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosReadinessCheck {
    pub name: String,
    pub state: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocoreReadiness {
    pub service: Option<TalosServiceInfo>,
    #[serde(rename = "rpcEndpoint")]
    pub rpc_endpoint: String,
    #[serde(rename = "displayState")]
    pub display_state: String,
    pub severity: String,
    pub summary: String,
    #[serde(rename = "chainId")]
    pub chain_id: Option<u64>,
    #[serde(rename = "blockNumber")]
    pub block_number: Option<u64>,
    #[serde(rename = "clientVersion")]
    pub client_version: Option<String>,
    pub listening: Option<bool>,
    pub syncing: Option<bool>,
    pub checks: Vec<TalosReadinessCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosLoadAverage {
    #[serde(rename = "load1")]
    pub load1: f64,
    #[serde(rename = "load5")]
    pub load5: f64,
    #[serde(rename = "load15")]
    pub load15: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosMemoryTelemetry {
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "availableBytes")]
    pub available_bytes: u64,
    #[serde(rename = "usedBytes")]
    pub used_bytes: u64,
    #[serde(rename = "usedPercent")]
    pub used_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosMountTelemetry {
    pub filesystem: String,
    #[serde(rename = "mountedOn")]
    pub mounted_on: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "availableBytes")]
    pub available_bytes: u64,
    #[serde(rename = "usedBytes")]
    pub used_bytes: u64,
    #[serde(rename = "usedPercent")]
    pub used_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosNetworkTelemetry {
    pub name: String,
    #[serde(rename = "rxBytes")]
    pub rx_bytes: u64,
    #[serde(rename = "txBytes")]
    pub tx_bytes: u64,
    #[serde(rename = "rxErrors")]
    pub rx_errors: u64,
    #[serde(rename = "txErrors")]
    pub tx_errors: u64,
    #[serde(rename = "rxDropped")]
    pub rx_dropped: u64,
    #[serde(rename = "txDropped")]
    pub tx_dropped: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosDiskIoTelemetry {
    pub name: String,
    #[serde(rename = "readBytes")]
    pub read_bytes: u64,
    #[serde(rename = "writeBytes")]
    pub write_bytes: u64,
    #[serde(rename = "ioInProgress")]
    pub io_in_progress: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosDiskTelemetry {
    #[serde(rename = "deviceName")]
    pub device_name: String,
    pub model: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "diskType")]
    pub disk_type: String,
    #[serde(rename = "systemDisk")]
    pub system_disk: bool,
    pub readonly: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosHostTelemetry {
    pub endpoint: String,
    #[serde(rename = "nodeAddress")]
    pub node_address: String,
    #[serde(rename = "loadAverage")]
    pub load_average: Option<TalosLoadAverage>,
    /// CPU busy percent (0..100) over a short sampling window, computed from the
    /// delta between two `SystemStat` reads. `None` when the node didn't report
    /// usable CPU jiffies (the snapshot then falls back to the load average).
    #[serde(rename = "cpuUsedPercent")]
    pub cpu_used_percent: Option<f64>,
    /// Number of logical CPUs the node reported (per-core `SystemStat` rows).
    /// `None` when unavailable.
    #[serde(rename = "cpuCount")]
    pub cpu_count: Option<u32>,
    pub memory: Option<TalosMemoryTelemetry>,
    pub mounts: Vec<TalosMountTelemetry>,
    pub network: Vec<TalosNetworkTelemetry>,
    #[serde(rename = "diskIo")]
    pub disk_io: Vec<TalosDiskIoTelemetry>,
    pub disks: Vec<TalosDiskTelemetry>,
}

/// One MachineService key-service state, condensed for the node-status header.
/// Re-uses the richer `TalosServiceInfo` summariser so a service shows the same
/// running/degraded/failed verdict the Operations view does. Absent when the
/// node doesn't report a service of that id (e.g. `kubelet` on a node whose
/// kubelet never started) — the header then renders a graceful "—".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosNodeServiceState {
    pub id: String,
    pub state: String,
    #[serde(rename = "displayState")]
    pub display_state: String,
    pub severity: String,
    pub healthy: Option<bool>,
    #[serde(rename = "healthUnknown")]
    pub health_unknown: Option<bool>,
}

/// READ-ONLY node-status snapshot for the in-app header — the same at-a-glance
/// fields the Talos console/VNC dashboard surfaces, pulled over Talos *read*
/// RPCs only. Every field is best-effort and independently sourced: a field the
/// node can't answer (or that this Talos client can't reach) comes back `None`
/// and the header shows a subtle "—", never a hard error.
///
/// Sourcing (talos-rust-client 0.1.3, MachineService unary/stream reads):
///   * `stage` / `ready` / `unmetConditions` — `Events` stream, decoded from the
///     tailed `MachineStatusEvent` (the same resource the dashboard's Stage line
///     reads).
///   * `hostname` — `Hostname` RPC.
///   * `talosVersion` / `talosArch` — `Version` RPC.
///   * `uptimeSeconds` — `SystemStat` RPC (`now - bootTime`).
///   * `addresses` — `Events` stream `AddressEvent` (node addresses; no
///     CIDR/gateway/DNS, which need COSI resources this client does not expose).
///   * `services` — `ServiceList` RPC, filtered to the key service ids.
///
/// Deliberately NOT included (not cleanly reachable via this client, omitted
/// rather than faked): machine UUID / SMBIOS, IP CIDR, gateway, DNS resolvers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TalosNodeStatus {
    pub endpoint: String,
    #[serde(rename = "nodeAddress")]
    pub node_address: String,
    /// Machine stage label (e.g. "Running", "Booting", "Upgrading"), from the
    /// tailed MachineStatusEvent. `None` when no stage event was observed.
    pub stage: Option<String>,
    /// MachineStatus.ready — the node has met its boot conditions.
    pub ready: Option<bool>,
    /// Names of the still-unmet boot conditions when `ready` is false.
    #[serde(rename = "unmetConditions")]
    pub unmet_conditions: Vec<String>,
    pub hostname: Option<String>,
    #[serde(rename = "talosVersion")]
    pub talos_version: Option<String>,
    #[serde(rename = "talosArch")]
    pub talos_arch: Option<String>,
    /// Seconds since the node booted (`now - SystemStat.bootTime`).
    #[serde(rename = "uptimeSeconds")]
    pub uptime_seconds: Option<u64>,
    /// Node addresses as the AddressEvent reports them (bare IPs, no CIDR).
    pub addresses: Vec<String>,
    /// Key service states (`ext-protocore`, `kubelet`).
    pub services: Vec<TalosNodeServiceState>,
    /// Per-field read errors, keyed by source (e.g. "version", "events"). The
    /// header ignores these for display (a missing field is just "—") but they
    /// are surfaced for diagnostics. Never blocks the rest of the snapshot.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServiceAction {
    Start,
    Stop,
    Restart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TalosRebootMode {
    Default,
    Powercycle,
}

fn expand_tilde(path: &str) -> PathBuf {
    if path == "~" {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home);
        }
    }

    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }

    PathBuf::from(path)
}

fn normalise_endpoint(endpoint: &str) -> Result<String, TalosError> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return Err(TalosError::MissingEndpoint);
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err(TalosError::InvalidEndpoint);
    }
    Ok(trimmed.to_string())
}

pub(crate) fn endpoint_url(endpoint: &str) -> Result<String, TalosError> {
    let endpoint = normalise_endpoint(endpoint)?;
    if endpoint.contains("://") {
        return Ok(endpoint);
    }
    if endpoint.contains(':') {
        return Ok(format!("https://{endpoint}"));
    }
    Ok(format!("https://{endpoint}:50000"))
}

pub(crate) fn node_address(endpoint: &str) -> String {
    let without_scheme = endpoint
        .strip_prefix("https://")
        .or_else(|| endpoint.strip_prefix("http://"))
        .unwrap_or(endpoint);
    let authority = without_scheme.split('/').next().unwrap_or(without_scheme);

    if let Some(rest) = authority.strip_prefix('[') {
        if let Some((host, _)) = rest.split_once(']') {
            return host.to_string();
        }
    }

    if authority.matches(':').count() == 1 {
        return authority
            .split_once(':')
            .map(|(host, _)| host.to_string())
            .unwrap_or_else(|| authority.to_string());
    }

    authority.to_string()
}

fn protocore_rpc_endpoint(
    talos_endpoint: &str,
    rpc_endpoint: Option<&str>,
) -> Result<String, TalosError> {
    let candidate = match rpc_endpoint
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value.to_string(),
        None => {
            let node = node_address(talos_endpoint);
            if node.contains(':') && !node.starts_with('[') {
                format!("http://[{node}]:8545")
            } else {
                format!("http://{node}:8545")
            }
        }
    };
    if candidate.chars().any(char::is_whitespace) {
        return Err(TalosError::InvalidEndpoint);
    }

    let with_scheme = if candidate.contains("://") {
        candidate
    } else {
        format!("http://{candidate}")
    };
    let url = reqwest::Url::parse(&with_scheme)
        .map_err(|err| TalosError::Config(format!("invalid Protocore RPC endpoint: {err}")))?;
    match url.scheme() {
        "http" | "https" => Ok(url.as_str().trim_end_matches('/').to_string()),
        other => Err(TalosError::Config(format!(
            "Protocore RPC endpoint must use http or https, got {other}"
        ))),
    }
}

fn validate_config_path(path: &str) -> Result<String, TalosError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(TalosError::MissingConfigPath);
    }
    let expanded = expand_tilde(trimmed);
    if !Path::new(&expanded).exists() {
        return Err(TalosError::ConfigNotFound(expanded.display().to_string()));
    }
    Ok(expanded.display().to_string())
}

fn validate_service_name(service: &str) -> Result<String, TalosError> {
    let service = service.trim();
    let ok = !service.is_empty()
        && service
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@' | ':'));
    if !ok {
        return Err(TalosError::InvalidService(service.to_string()));
    }
    Ok(service.to_string())
}

fn parse_service_action(action: &str) -> Result<ServiceAction, TalosError> {
    match action.trim().to_ascii_lowercase().as_str() {
        "start" => Ok(ServiceAction::Start),
        "stop" => Ok(ServiceAction::Stop),
        "restart" => Ok(ServiceAction::Restart),
        other => Err(TalosError::InvalidServiceAction(other.to_string())),
    }
}

fn talos_logs_request(service: String, follow: bool, line_count: i32) -> machine::LogsRequest {
    // Build the *service*-log request that `talosctl logs <service>` emits:
    // empty namespace + the proto-default driver (Containerd == 0, which Talos
    // never reaches because the empty namespace short-circuits the container
    // lookup), keyed on `id`. The earlier `system`/Containerd shape asked for a
    // containerd container that does not exist, so the stream opened empty and
    // never carried a chunk — the panel stuck on "Waiting for logs".
    machine::LogsRequest {
        namespace: TALOS_SERVICE_LOG_NAMESPACE.to_string(),
        id: service,
        driver: common::ContainerDriver::Containerd as i32,
        follow,
        tail_lines: line_count,
    }
}

fn parse_reboot_mode(mode: &str) -> Result<TalosRebootMode, TalosError> {
    match mode.trim().to_ascii_lowercase().as_str() {
        "" | "default" => Ok(TalosRebootMode::Default),
        "powercycle" => Ok(TalosRebootMode::Powercycle),
        other => Err(TalosError::InvalidRebootMode(other.to_string())),
    }
}

fn validate_upgrade_image(image: &str) -> Result<String, TalosError> {
    let image = image.trim();
    if image.len() < 2 || image.len() > 512 {
        return Err(TalosError::InvalidUpgradeImage(
            "reference length must be between 2 and 512 characters".to_string(),
        ));
    }
    if image
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || !c.is_ascii())
    {
        return Err(TalosError::InvalidUpgradeImage(
            "reference must be printable ASCII without whitespace".to_string(),
        ));
    }
    if !image
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | ':' | '@' | '+' | '-'))
    {
        return Err(TalosError::InvalidUpgradeImage(
            "reference contains unsupported characters".to_string(),
        ));
    }
    if !image.contains('/') {
        return Err(TalosError::InvalidUpgradeImage(
            "reference must include a registry/repository path".to_string(),
        ));
    }
    if image.contains("..") {
        return Err(TalosError::InvalidUpgradeImage(
            "reference must not contain '..' path segments".to_string(),
        ));
    }
    let last_segment = image.rsplit('/').next().unwrap_or(image);
    if let Some((_, digest)) = image.rsplit_once("@sha256:") {
        if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(TalosError::InvalidUpgradeImage(
                "sha256 digest must be 64 hex characters".to_string(),
            ));
        }
    } else if !last_segment.contains(':') {
        return Err(TalosError::InvalidUpgradeImage(
            "reference must include a tag or sha256 digest".to_string(),
        ));
    }
    Ok(image.to_string())
}

fn read_keychain(account: &str) -> Result<Option<String>, TalosError> {
    match keychain::read_credential(account) {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) => Ok(None),
        Err(keychain::KeychainError::NotFound) => Ok(None),
        Err(err) => Err(TalosError::Keychain(err.to_string())),
    }
}

async fn resolve_config(
    state: &TalosState,
) -> Result<(Option<String>, Option<String>), TalosError> {
    let snapshot = {
        let guard = state.lock().await;
        (guard.endpoint.clone(), guard.config_path.clone())
    };

    let endpoint = match snapshot.0 {
        Some(value) => Some(value),
        None => read_keychain(TALOS_ENDPOINT_ACCOUNT)?,
    };
    let config_path = match snapshot.1 {
        Some(value) => Some(value),
        None => read_keychain(TALOS_CONFIG_PATH_ACCOUNT)?,
    };

    Ok((endpoint, config_path))
}

fn decode_pem(label: &str, value: &str) -> Result<Vec<u8>, TalosError> {
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|err| TalosError::Config(format!("invalid {label} in talosconfig: {err}")))
}

fn normalize_private_key_pem(label: &str, pem: Vec<u8>) -> Result<Vec<u8>, TalosError> {
    if !pem.starts_with(b"-----BEGIN ED25519 PRIVATE KEY-----") {
        return Ok(pem);
    }
    let text = String::from_utf8(pem)
        .map_err(|err| TalosError::Config(format!("invalid {label} PEM text: {err}")))?;
    Ok(text
        .replace(
            "-----BEGIN ED25519 PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY-----",
        )
        .replace(
            "-----END ED25519 PRIVATE KEY-----",
            "-----END PRIVATE KEY-----",
        )
        .into_bytes())
}

fn format_time(ts: ASN1Time) -> String {
    ts.to_rfc2822()
        .unwrap_or_else(|_| ts.timestamp().to_string())
}

fn format_fingerprint(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn parse_certificate(role: &str, pem_bytes: &[u8]) -> Result<TalosCertificateInfo, TalosError> {
    let (pem, _) = Pem::read(Cursor::new(pem_bytes))
        .map_err(|err| TalosError::Config(format!("invalid {role} certificate PEM: {err}")))?;
    let cert = pem
        .parse_x509()
        .map_err(|err| TalosError::Config(format!("invalid {role} certificate: {err}")))?;
    let validity = cert.validity();
    let now = ASN1Time::now();

    let mut dns_names = Vec::new();
    let mut ip_addresses = Vec::new();
    if let Some(san) = cert
        .subject_alternative_name()
        .map_err(|err| TalosError::Config(format!("invalid {role} SAN extension: {err}")))?
    {
        for name in &san.value.general_names {
            match name {
                GeneralName::DNSName(name) => dns_names.push((*name).to_string()),
                GeneralName::IPAddress(bytes) => match bytes.len() {
                    4 => {
                        let mut octets = [0u8; 4];
                        octets.copy_from_slice(bytes);
                        ip_addresses.push(Ipv4Addr::from(octets).to_string());
                    }
                    16 => {
                        let mut octets = [0u8; 16];
                        octets.copy_from_slice(bytes);
                        ip_addresses.push(Ipv6Addr::from(octets).to_string());
                    }
                    _ => ip_addresses.push(format!("invalid-len-{}", bytes.len())),
                },
                _ => {}
            }
        }
    }

    let seconds_until_expiry = validity.not_after.timestamp() - now.timestamp();

    Ok(TalosCertificateInfo {
        role: role.to_string(),
        subject: cert.subject().to_string(),
        issuer: cert.issuer().to_string(),
        not_before: format_time(validity.not_before),
        not_after: format_time(validity.not_after),
        sha256_fingerprint: format_fingerprint(&pem.contents),
        expired: now > validity.not_after,
        not_yet_valid: now < validity.not_before,
        expires_in_days: seconds_until_expiry.div_euclid(86_400),
        dns_names,
        ip_addresses,
    })
}

fn build_config_info(
    endpoint_override: Option<&str>,
    config_path: &str,
) -> Result<TalosConfigInfo, TalosError> {
    let config = TalosConfig::from_file(config_path)?;
    let context = config
        .current_context()
        .map_err(|_| TalosError::MissingContext)?;
    let context_name = config.context.clone();
    let context_endpoints = context.endpoints.clone();
    let context_nodes = context.nodes.clone();

    let endpoint = match endpoint_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(endpoint) => endpoint_url(endpoint)?,
        None => endpoint_url(
            context
                .endpoints
                .first()
                .ok_or(TalosError::MissingContextEndpoint)?,
        )?,
    };
    let server_name = node_address(&endpoint);
    let ca_pem = decode_pem("CA certificate", &context.ca)?;
    let client_pem = decode_pem("client certificate", &context.crt)?;

    let certificates = vec![
        parse_certificate("Talos CA", &ca_pem)?,
        parse_certificate("client", &client_pem)?,
    ];
    let ca_fingerprint = certificates
        .first()
        .map(|cert| cert.sha256_fingerprint.clone())
        .ok_or_else(|| TalosError::Config("Talos CA certificate missing".to_string()))?;
    let trusted_ca_fingerprint = read_keychain(TALOS_CA_FINGERPRINT_ACCOUNT)?;
    let ca_pin_status = match trusted_ca_fingerprint.as_deref() {
        Some(trusted) if trusted == ca_fingerprint => "matched",
        Some(_) => "mismatch",
        None => "untrusted",
    }
    .to_string();

    let mut warnings = Vec::new();
    if context_endpoints.is_empty() {
        warnings.push("talosconfig context has no endpoints".to_string());
    }
    if !context_endpoints.iter().any(|entry| {
        endpoint_url(entry)
            .map(|candidate| candidate == endpoint)
            .unwrap_or(false)
    }) {
        warnings.push("selected endpoint is not listed in the active context".to_string());
    }
    if ca_pin_status == "mismatch" {
        warnings.push("Talos CA fingerprint does not match the trusted fingerprint".to_string());
    }
    for cert in &certificates {
        if cert.expired {
            warnings.push(format!("{} certificate is expired", cert.role));
        }
        if cert.not_yet_valid {
            warnings.push(format!("{} certificate is not valid yet", cert.role));
        }
        if !cert.expired
            && !cert.not_yet_valid
            && cert.expires_in_days < TALOS_CERT_EXPIRY_WARNING_DAYS
        {
            warnings.push(format!(
                "{} certificate expires in {} day(s); rotate talosconfig before release validation",
                cert.role, cert.expires_in_days
            ));
        }
    }

    Ok(TalosConfigInfo {
        path: config_path.to_string(),
        context: context_name,
        endpoint,
        server_name,
        ca_fingerprint,
        trusted_ca_fingerprint,
        ca_pin_status,
        endpoints: context_endpoints,
        nodes: context_nodes,
        certificates,
        warnings,
    })
}

fn enforce_ca_pin(info: &TalosConfigInfo) -> Result<(), TalosError> {
    if info.ca_pin_status == "mismatch" {
        return Err(TalosError::Config(format!(
            "Talos CA fingerprint mismatch: trusted {}, current {}",
            info.trusted_ca_fingerprint
                .as_deref()
                .unwrap_or("<missing>"),
            info.ca_fingerprint
        )));
    }
    Ok(())
}

fn endpoint_matches_active_context(info: &TalosConfigInfo) -> bool {
    info.endpoints.iter().any(|entry| {
        endpoint_url(entry)
            .map(|candidate| candidate == info.endpoint)
            .unwrap_or(false)
    })
}

fn enforce_privileged_control_plane(info: &TalosConfigInfo) -> Result<(), TalosError> {
    match info.ca_pin_status.as_str() {
        "matched" => {}
        "mismatch" => enforce_ca_pin(info)?,
        "untrusted" => {
            return Err(TalosError::Config(format!(
                "Talos CA fingerprint is not trusted: {}. Trust this talosconfig before running privileged operations.",
                info.ca_fingerprint
            )));
        }
        other => {
            return Err(TalosError::Config(format!(
                "Talos CA pin status is not trusted for privileged operations: {other}"
            )));
        }
    }

    if !endpoint_matches_active_context(info) {
        return Err(TalosError::Config(format!(
            "selected Talos endpoint {} is not listed in the active talosconfig context",
            info.endpoint
        )));
    }

    for cert in &info.certificates {
        if cert.expired {
            return Err(TalosError::Config(format!(
                "{} certificate is expired; rotate talosconfig before running privileged operations",
                cert.role
            )));
        }
        if cert.not_yet_valid {
            return Err(TalosError::Config(format!(
                "{} certificate is not valid yet; check workstation time or rotate talosconfig before running privileged operations",
                cert.role
            )));
        }
    }

    Ok(())
}

fn connector_from_talosconfig(
    endpoint: &str,
    config_path: &str,
) -> Result<TalosConnector, TalosError> {
    let info = build_config_info(Some(endpoint), config_path)?;
    enforce_ca_pin(&info)?;

    let config = TalosConfig::from_file(config_path)?;
    let context = config
        .current_context()
        .map_err(|_| TalosError::MissingContext)?;

    let endpoint = if endpoint.trim().is_empty() {
        context
            .endpoints
            .first()
            .ok_or(TalosError::MissingContextEndpoint)?
            .clone()
    } else {
        endpoint.to_string()
    };
    let endpoint = endpoint_url(&endpoint)?;

    let ca = decode_pem("CA certificate", &context.ca)?;
    let cert = decode_pem("client certificate", &context.crt)?;
    let key = normalize_private_key_pem("client key", decode_pem("client key", &context.key)?)?;

    Ok(TalosConnector::new(&endpoint)
        .ca_pem(ca)
        .cert_pem(cert)
        .key_pem(key)
        .server_name(node_address(&endpoint)))
}

async fn machine_client(
    endpoint: &str,
    config_path: &str,
) -> Result<MachineServiceClient<talos_rust_client::Channel>, TalosError> {
    let connector = connector_from_talosconfig(endpoint, config_path)?;
    let channel = timeout(TALOS_TIMEOUT, connector.connect())
        .await
        .map_err(|_| TalosError::Timeout)?
        .map_err(TalosError::from)?;
    Ok(MachineServiceClient::new(channel))
}

async fn storage_client(
    endpoint: &str,
    config_path: &str,
) -> Result<StorageServiceClient<talos_rust_client::Channel>, TalosError> {
    let connector = connector_from_talosconfig(endpoint, config_path)?;
    let channel = timeout(TALOS_TIMEOUT, connector.connect())
        .await
        .map_err(|_| TalosError::Timeout)?
        .map_err(TalosError::from)?;
    Ok(StorageServiceClient::new(channel))
}

fn empty_request() -> google::protobuf::Empty {
    google::protobuf::Empty {}
}

fn timestamp(ts: Option<google::protobuf::Timestamp>) -> Option<String> {
    ts.map(|ts| {
        if ts.nanos == 0 {
            format!("{}", ts.seconds)
        } else {
            format!("{}.{:09}", ts.seconds, ts.nanos)
        }
    })
}

fn service_info(info: machine::ServiceInfo) -> TalosServiceInfo {
    let (healthy, health_unknown, health_message) = info
        .health
        .map(|health| {
            (
                Some(health.healthy),
                Some(health.unknown),
                if health.last_message.is_empty() {
                    None
                } else {
                    Some(health.last_message)
                },
            )
        })
        .unwrap_or((None, None, None));

    let events: Vec<TalosServiceEvent> = info
        .events
        .map(|events| {
            events
                .events
                .into_iter()
                .map(|event| TalosServiceEvent {
                    message: event.msg,
                    state: event.state,
                    timestamp: timestamp(event.ts),
                })
                .collect()
        })
        .unwrap_or_default();
    let last_event = events.last().cloned();
    let (display_state, severity, summary) = summarize_service_state(
        &info.id,
        &info.state,
        healthy,
        health_unknown,
        &health_message,
    );

    TalosServiceInfo {
        id: info.id,
        state: info.state,
        display_state,
        severity,
        summary,
        healthy,
        health_unknown,
        health_message,
        last_event,
        events,
    }
}

fn summarize_service_state(
    id: &str,
    state: &str,
    healthy: Option<bool>,
    health_unknown: Option<bool>,
    health_message: &Option<String>,
) -> (String, String, String) {
    let lower = state.to_ascii_lowercase();
    let display = if lower.contains("fail") {
        "failed"
    } else if matches!(healthy, Some(false)) && !matches!(health_unknown, Some(true)) {
        // "degraded" only when Talos KNOWS the service is unhealthy. A service
        // with no health check declared in its Talos spec — like the protocore
        // extension service — reports health.unknown=true with a default
        // healthy=false; that is NOT a degraded verdict, so fall through to the
        // run/state-based label (a Running, serving node must read "running").
        "degraded"
    } else if lower.contains("restart") || lower.contains("start") || lower.contains("pre") {
        "restarting"
    } else if lower.contains("stop") || lower.contains("down") {
        "stopped"
    } else if lower.contains("run") || matches!(healthy, Some(true)) {
        "running"
    } else if matches!(health_unknown, Some(true)) || lower.contains("wait") {
        "waiting-for-config"
    } else {
        "unknown"
    };

    let severity = match display {
        "running" => "ok",
        "failed" | "degraded" => "err",
        "stopped" | "waiting-for-config" => "warn",
        "restarting" => "info",
        _ => "info",
    };

    let summary = match health_message {
        Some(msg) if !msg.trim().is_empty() => {
            format!("{id} {display}: {}", msg.trim())
        }
        _ => format!("{id} {display} (raw state: {state})"),
    };

    (display.to_string(), severity.to_string(), summary)
}

fn format_service(service: &TalosServiceInfo) -> String {
    let health = match (service.healthy, service.health_unknown) {
        (_, Some(true)) => "unknown".to_string(),
        (Some(true), _) => "healthy".to_string(),
        (Some(false), _) => "unhealthy".to_string(),
        _ => "not reported".to_string(),
    };
    let mut output = format!(
        "{} display={} state={} health={}",
        service.id, service.display_state, service.state, health
    );
    if let Some(msg) = &service.health_message {
        output.push_str(&format!(" message={msg}"));
    }
    if let Some(event) = &service.last_event {
        output.push_str(&format!(" last_event={} {}", event.state, event.message));
    }
    output
}

/// Map the Talos `MachineStage` enum (the dashboard's Stage line) to a stable
/// operator-facing label. Pure — covers every variant the proto defines so a
/// future stage never silently renders blank.
fn machine_stage_label(stage: machine::machine_status_event::MachineStage) -> &'static str {
    use machine::machine_status_event::MachineStage;
    match stage {
        MachineStage::Unknown => "Unknown",
        MachineStage::Booting => "Booting",
        MachineStage::Installing => "Installing",
        MachineStage::Maintenance => "Maintenance",
        MachineStage::Running => "Running",
        MachineStage::Rebooting => "Rebooting",
        MachineStage::ShuttingDown => "Shutting down",
        MachineStage::Resetting => "Resetting",
        MachineStage::Upgrading => "Upgrading",
    }
}

/// Talos stamps event payloads into a `google.protobuf.Any` whose `type_url`
/// ends with the proto message name. We match on the suffix (not the full url)
/// so a registry-prefix change (`type.googleapis.com/…` vs `talos.dev/…`)
/// doesn't break the decode.
fn any_type_is(any: &google::protobuf::Any, message_name: &str) -> bool {
    any.type_url
        .rsplit('/')
        .next()
        .map(|tail| tail == message_name || tail.ends_with(&format!(".{message_name}")))
        .unwrap_or(false)
}

/// Best-effort, single-field extract of the first `VersionInfo` from a
/// `VersionResponse` — the tag + arch the header shows. `None` when the node
/// returned no version message.
fn first_version_info(response: &machine::VersionResponse) -> Option<&machine::VersionInfo> {
    response
        .messages
        .iter()
        .find_map(|msg| msg.version.as_ref())
}

fn format_version(response: machine::VersionResponse) -> String {
    let mut lines = Vec::new();
    for msg in response.messages {
        let node = msg
            .metadata
            .as_ref()
            .map(|meta| meta.hostname.as_str())
            .unwrap_or("node");
        if let Some(version) = msg.version {
            lines.push(format!(
                "{node}: {} {} {} {}",
                version.tag, version.sha, version.os, version.arch
            ));
        } else {
            lines.push(format!("{node}: version unavailable"));
        }
    }
    lines.join("\n")
}

fn metadata_host(metadata: Option<&common::Metadata>) -> String {
    metadata
        .and_then(|meta| {
            if meta.hostname.trim().is_empty() {
                None
            } else {
                Some(meta.hostname.clone())
            }
        })
        .unwrap_or_else(|| "node".to_string())
}

/// Marker the upgrade command stamps into `TalosTextResult.output` when the
/// upgrade request was dispatched but the control connection dropped because the
/// node started rebooting into the new image. The TS layer recognises this
/// prefix and drives a reconnect-poll instead of surfacing a hard failure.
/// A Talos image upgrade ALWAYS reboots, so a post-dispatch transport drop is
/// the expected, successful outcome — not "could not reach the node".
pub const UPGRADE_REBOOTING_MARKER: &str = "upgrade dispatched: node is rebooting into the new image";

/// Classify the error returned by `client.upgrade(...)` AFTER the gRPC channel
/// was already established (so the node was reachable when we sent the request).
///
/// A Talos image upgrade tears the machine down and reboots, so the unary call
/// frequently never receives a clean response — the connection is reset, the
/// stream is cancelled, or the call times out as the node goes away. Once the
/// request has been written to an established channel, every one of those is the
/// signature of the reboot, NOT a node that was never reached. Returns `true`
/// when the error is a post-dispatch reboot drop that should be reported as
/// "dispatched — rebooting".
fn is_post_dispatch_reboot_drop(status: &talos_rust_client::tonic::Status) -> bool {
    use talos_rust_client::tonic::Code;
    matches!(
        status.code(),
        Code::Unavailable
            | Code::Cancelled
            | Code::Unknown
            | Code::Aborted
            | Code::DeadlineExceeded
            | Code::Internal
    )
}

fn format_upgrade_response(response: machine::UpgradeResponse) -> String {
    let mut lines = Vec::new();
    for msg in response.messages {
        let host = metadata_host(msg.metadata.as_ref());
        let ack = if msg.ack.trim().is_empty() {
            "accepted".to_string()
        } else {
            msg.ack
        };
        let actor = if msg.actor_id.trim().is_empty() {
            "actor unavailable".to_string()
        } else {
            format!("actor {}", msg.actor_id)
        };
        lines.push(format!("{host}: upgrade {ack} ({actor})"));
    }
    if lines.is_empty() {
        "upgrade accepted".to_string()
    } else {
        lines.join("\n")
    }
}

fn format_rollback_response(response: machine::RollbackResponse) -> String {
    let mut lines = Vec::new();
    for msg in response.messages {
        let host = metadata_host(msg.metadata.as_ref());
        lines.push(format!("{host}: rollback accepted"));
    }
    if lines.is_empty() {
        "rollback accepted".to_string()
    } else {
        lines.join("\n")
    }
}

fn format_reset_response(response: machine::ResetResponse) -> String {
    let mut lines = Vec::new();
    for msg in response.messages {
        let host = metadata_host(msg.metadata.as_ref());
        let actor = if msg.actor_id.trim().is_empty() {
            "actor unavailable".to_string()
        } else {
            format!("actor {}", msg.actor_id)
        };
        lines.push(format!("{host}: reset accepted ({actor})"));
    }
    if lines.is_empty() {
        "reset accepted".to_string()
    } else {
        lines.join("\n")
    }
}

fn unix_now() -> Result<u64, TalosError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|err| TalosError::Config(format!("system clock is before UNIX epoch: {err}")))
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn sanitize_backup_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if sanitized.is_empty() {
        "node".to_string()
    } else {
        sanitized
    }
}

fn backup_directory() -> Result<PathBuf, TalosError> {
    let base = dirs::data_dir().ok_or_else(|| {
        TalosError::Backup("could not resolve a local data directory for backup output".to_string())
    })?;
    Ok(base.join("monarch-desktop").join("backups"))
}

fn backup_paths(node: &str, created_at_unix: u64) -> Result<(PathBuf, PathBuf), TalosError> {
    let dir = backup_directory()?;
    let node = sanitize_backup_component(node);
    let archive = dir.join(format!("protocore-{node}-{created_at_unix}.tar.gz"));
    let manifest = dir.join(format!("protocore-{node}-{created_at_unix}.backup.json"));
    Ok((archive, manifest))
}

fn service_allows_offline_backup(service: &TalosServiceInfo) -> bool {
    matches!(service.display_state.as_str(), "stopped")
        || service.state.to_ascii_lowercase().contains("stop")
        || service.state.to_ascii_lowercase().contains("down")
}

async fn write_talos_copy_archive(
    endpoint: &str,
    config_path: &str,
    root_path: &str,
    archive_path: &Path,
) -> Result<(u64, String), TalosError> {
    let mut client = machine_client(endpoint, config_path).await?;
    let response = timeout(
        TALOS_TIMEOUT,
        client.copy(machine::CopyRequest {
            root_path: root_path.to_string(),
        }),
    )
    .await
    .map_err(|_| TalosError::Timeout)?
    .map_err(TalosError::from)?;

    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(archive_path)
        .await
        .map_err(|err| TalosError::FileSystem(format!("create archive: {err}")))?;
    let mut stream = response.into_inner();
    let mut sha = Sha256::new();
    let mut size = 0_u64;

    while let Some(chunk) = timeout(TALOS_BACKUP_TIMEOUT, stream.next())
        .await
        .map_err(|_| TalosError::Timeout)?
    {
        let data = chunk.map_err(TalosError::from)?;
        if let Some(metadata) = data.metadata {
            if !metadata.error.trim().is_empty() {
                return Err(TalosError::Api(metadata.error));
            }
        }
        if data.bytes.is_empty() {
            continue;
        }
        file.write_all(&data.bytes)
            .await
            .map_err(|err| TalosError::FileSystem(format!("write archive: {err}")))?;
        sha.update(&data.bytes);
        size = size.saturating_add(data.bytes.len() as u64);
    }

    file.flush()
        .await
        .map_err(|err| TalosError::FileSystem(format!("flush archive: {err}")))?;
    if size == 0 {
        return Err(TalosError::Backup(
            "Talos Copy returned an empty Protocore archive".to_string(),
        ));
    }

    let archive_sha256 = sha
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    Ok((size, archive_sha256))
}

async fn read_talos_copy_archive(
    endpoint: &str,
    config_path: &str,
    root_path: &str,
) -> Result<Vec<u8>, TalosError> {
    let mut client = machine_client(endpoint, config_path).await?;
    let response = timeout(
        TALOS_TIMEOUT,
        client.copy(machine::CopyRequest {
            root_path: root_path.to_string(),
        }),
    )
    .await
    .map_err(|_| TalosError::Timeout)?
    .map_err(TalosError::from)?;

    let mut stream = response.into_inner();
    let mut out = Vec::new();
    while let Some(chunk) = timeout(TALOS_BACKUP_TIMEOUT, stream.next())
        .await
        .map_err(|_| TalosError::Timeout)?
    {
        let data = chunk.map_err(TalosError::from)?;
        if let Some(metadata) = data.metadata {
            if !metadata.error.trim().is_empty() {
                return Err(TalosError::Api(metadata.error));
            }
        }
        out.extend_from_slice(&data.bytes);
    }

    if out.is_empty() {
        return Err(TalosError::Api(format!(
            "Talos Copy returned no data for {root_path}"
        )));
    }
    Ok(out)
}

fn extract_talos_copy_file(
    archive_bytes: &[u8],
    expected_path: &str,
) -> Result<Vec<u8>, TalosError> {
    match extract_file_from_tar(GzDecoder::new(Cursor::new(archive_bytes)), expected_path) {
        Ok(bytes) => Ok(bytes),
        Err(gzip_err) => extract_file_from_tar(Cursor::new(archive_bytes), expected_path).map_err(
            |raw_err| {
                TalosError::Api(format!(
                    "could not decode Talos Copy archive for {expected_path}: gzip={gzip_err}; raw={raw_err}"
                ))
            },
        ),
    }
}

fn extract_file_from_tar<R: Read>(reader: R, expected_path: &str) -> Result<Vec<u8>, TalosError> {
    let mut archive = tar::Archive::new(reader);
    let expected = expected_path.trim_start_matches('/');
    let expected_name = Path::new(expected)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| TalosError::Api(format!("invalid expected path {expected_path}")))?;
    let entries = archive
        .entries()
        .map_err(|err| TalosError::Api(format!("read Talos Copy archive: {err}")))?;

    for entry in entries {
        let mut entry =
            entry.map_err(|err| TalosError::Api(format!("read Talos Copy entry: {err}")))?;
        let path = entry
            .path()
            .map_err(|err| TalosError::Api(format!("read Talos Copy entry path: {err}")))?
            .into_owned();
        let path_matches = path == Path::new(expected)
            || path.ends_with(expected)
            || path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == expected_name);
        if !path_matches {
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|err| TalosError::Api(format!("read Talos Copy file: {err}")))?;
        return Ok(bytes);
    }

    Err(TalosError::Api(format!(
        "Talos Copy archive did not contain {expected_path}"
    )))
}

fn normalize_operator_seal_ek(raw: &[u8]) -> Result<(String, String), TalosError> {
    let text = std::str::from_utf8(raw)
        .map_err(|err| TalosError::Api(format!("operator seal EK is not UTF-8 hex: {err}")))?;
    let clean = text
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    if clean.len() != PROTOCORE_OPERATOR_SEAL_EK_HEX_LEN {
        return Err(TalosError::Api(format!(
            "operator seal EK must be {PROTOCORE_OPERATOR_SEAL_EK_HEX_LEN} hex characters, got {}",
            clean.len()
        )));
    }
    if !clean.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(TalosError::Api(
            "operator seal EK contains non-hex characters".to_string(),
        ));
    }
    let hex = clean.to_ascii_lowercase();
    let bytes = decode_hex_bytes(&hex, "operator seal EK")?;
    if bytes.iter().all(|byte| *byte == 0) {
        return Err(TalosError::Api(
            "operator seal EK must not be all-zero".to_string(),
        ));
    }
    Ok((format!("0x{hex}"), hex_sha256(&bytes)))
}

fn decode_hex_bytes(hex: &str, label: &str) -> Result<Vec<u8>, TalosError> {
    if hex.len() % 2 != 0 {
        return Err(TalosError::Api(format!("{label} has odd hex length")));
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    for idx in (0..hex.len()).step_by(2) {
        let byte = u8::from_str_radix(&hex[idx..idx + 2], 16)
            .map_err(|err| TalosError::Api(format!("{label} has invalid hex: {err}")))?;
        out.push(byte);
    }
    Ok(out)
}

fn used_percent(total: u64, available: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    let used = total.saturating_sub(available);
    (used as f64 / total as f64) * 100.0
}

fn load_average(response: machine::LoadAvgResponse) -> Option<TalosLoadAverage> {
    response
        .messages
        .into_iter()
        .next()
        .map(|load| TalosLoadAverage {
            load1: load.load1,
            load5: load.load5,
            load15: load.load15,
        })
}

/// Total jiffies across every `CpuStat` field. Pure arithmetic on the node's
/// own counters.
fn cpu_total_jiffies(stat: &machine::CpuStat) -> f64 {
    stat.user
        + stat.nice
        + stat.system
        + stat.idle
        + stat.iowait
        + stat.irq
        + stat.soft_irq
        + stat.steal
        + stat.guest
        + stat.guest_nice
}

/// Non-idle jiffies (`idle` + `iowait` are the idle classes).
fn cpu_busy_jiffies(stat: &machine::CpuStat) -> f64 {
    (cpu_total_jiffies(stat) - stat.idle - stat.iowait).max(0.0)
}

/// CPU busy percent (0..100) from two `cpu_total` snapshots taken a short
/// interval apart: `busy_delta / total_delta`. `None` when the deltas are
/// non-positive (no movement / counter reset) — it returns nothing rather than
/// a guessed reading.
fn cpu_busy_percent(first: &machine::CpuStat, second: &machine::CpuStat) -> Option<f64> {
    let total_delta = cpu_total_jiffies(second) - cpu_total_jiffies(first);
    let busy_delta = cpu_busy_jiffies(second) - cpu_busy_jiffies(first);
    if total_delta <= 0.0 || busy_delta < 0.0 {
        return None;
    }
    Some(((busy_delta / total_delta) * 100.0).clamp(0.0, 100.0))
}

/// Pull the `cpu_total` CpuStat and the per-core count out of a `SystemStat`
/// read. `(cpu_total, core_count)` — either component may be `None`.
fn system_stat_cpu(
    response: &machine::SystemStatResponse,
) -> (Option<machine::CpuStat>, Option<u32>) {
    let stat = response.messages.first();
    let cpu_total = stat.and_then(|s| s.cpu_total);
    let count = stat
        .map(|s| s.cpu.len())
        .filter(|n| *n > 0)
        .map(|n| n as u32);
    (cpu_total, count)
}

/// Sample CPU busy% over a short window via two `SystemStat` reads. Best-effort:
/// any read failure (or no usable counters) yields `(None, count?)` so the rest
/// of the telemetry still returns. PURE READ — `SystemStat` is the same RPC the
/// node-status header already uses for uptime.
async fn sample_cpu_usage(
    client: &mut MachineServiceClient<talos_rust_client::Channel>,
) -> (Option<f64>, Option<u32>) {
    let first = match timeout(TALOS_TIMEOUT, client.system_stat(empty_request())).await {
        Ok(Ok(resp)) => resp.into_inner(),
        _ => return (None, None),
    };
    let (first_cpu, count) = system_stat_cpu(&first);
    // Short window so the command stays snappy; CPU jiffies move every tick.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let second = match timeout(TALOS_TIMEOUT, client.system_stat(empty_request())).await {
        Ok(Ok(resp)) => resp.into_inner(),
        _ => return (None, count),
    };
    let (second_cpu, count2) = system_stat_cpu(&second);
    let percent = match (first_cpu, second_cpu) {
        (Some(a), Some(b)) => cpu_busy_percent(&a, &b),
        _ => None,
    };
    (percent, count.or(count2))
}

fn memory_telemetry(response: machine::MemoryResponse) -> Option<TalosMemoryTelemetry> {
    let meminfo = response
        .messages
        .into_iter()
        .find_map(|message| message.meminfo)?;
    let available = if meminfo.memavailable > 0 {
        meminfo.memavailable
    } else {
        meminfo.memfree
    };
    let used = meminfo.memtotal.saturating_sub(available);
    Some(TalosMemoryTelemetry {
        total_bytes: meminfo.memtotal,
        available_bytes: available,
        used_bytes: used,
        used_percent: used_percent(meminfo.memtotal, available),
    })
}

fn mount_telemetry(response: machine::MountsResponse) -> Vec<TalosMountTelemetry> {
    response
        .messages
        .into_iter()
        .flat_map(|message| message.stats)
        .filter(|stat| stat.size > 0)
        .map(|stat| {
            let used = stat.size.saturating_sub(stat.available);
            TalosMountTelemetry {
                filesystem: stat.filesystem,
                mounted_on: stat.mounted_on,
                size_bytes: stat.size,
                available_bytes: stat.available,
                used_bytes: used,
                used_percent: used_percent(stat.size, stat.available),
            }
        })
        .collect()
}

fn network_telemetry(response: machine::NetworkDeviceStatsResponse) -> Vec<TalosNetworkTelemetry> {
    response
        .messages
        .into_iter()
        .flat_map(|message| {
            let mut rows = Vec::new();
            if let Some(total) = message.total {
                rows.push(total);
            }
            rows.extend(message.devices);
            rows
        })
        .filter(|dev| !dev.name.trim().is_empty() || dev.rx_bytes > 0 || dev.tx_bytes > 0)
        .map(|dev| TalosNetworkTelemetry {
            name: if dev.name.trim().is_empty() {
                "total".to_string()
            } else {
                dev.name
            },
            rx_bytes: dev.rx_bytes,
            tx_bytes: dev.tx_bytes,
            rx_errors: dev.rx_errors,
            tx_errors: dev.tx_errors,
            rx_dropped: dev.rx_dropped,
            tx_dropped: dev.tx_dropped,
        })
        .collect()
}

fn disk_io_telemetry(response: machine::DiskStatsResponse) -> Vec<TalosDiskIoTelemetry> {
    response
        .messages
        .into_iter()
        .flat_map(|message| {
            let mut rows = Vec::new();
            if let Some(total) = message.total {
                rows.push(total);
            }
            rows.extend(message.devices);
            rows
        })
        .filter(|disk| {
            !disk.name.trim().is_empty() || disk.read_sectors > 0 || disk.write_sectors > 0
        })
        .map(|disk| TalosDiskIoTelemetry {
            name: if disk.name.trim().is_empty() {
                "total".to_string()
            } else {
                disk.name
            },
            read_bytes: disk.read_sectors.saturating_mul(512),
            write_bytes: disk.write_sectors.saturating_mul(512),
            io_in_progress: disk.io_in_progress,
        })
        .collect()
}

pub(crate) fn disk_type_label(raw: i32) -> String {
    storage::disk::DiskType::try_from(raw)
        .map(|kind| kind.as_str_name().to_ascii_lowercase())
        .unwrap_or_else(|_| "unknown".to_string())
}

fn disk_inventory(response: storage::DisksResponse) -> Vec<TalosDiskTelemetry> {
    response
        .messages
        .into_iter()
        .flat_map(|message| message.disks)
        .map(|disk| TalosDiskTelemetry {
            device_name: disk.device_name,
            model: disk.model,
            size_bytes: disk.size,
            disk_type: disk_type_label(disk.r#type),
            system_disk: disk.system_disk,
            readonly: disk.readonly,
        })
        .collect()
}

async fn fetch_host_telemetry(
    endpoint: &str,
    config_path: &str,
) -> Result<TalosHostTelemetry, TalosError> {
    let mut machine = machine_client(endpoint, config_path).await?;
    // CPU busy% needs two SystemStat reads a short interval apart; do this first
    // so the sampling window overlaps the other reads rather than adding latency
    // serially. Best-effort — a failure leaves cpu_used_percent None.
    let (cpu_used_percent, cpu_count) = sample_cpu_usage(&mut machine).await;
    let load = timeout(TALOS_TIMEOUT, machine.load_avg(empty_request()))
        .await
        .map_err(|_| TalosError::Timeout)?
        .map_err(TalosError::from)?
        .into_inner();
    let memory = timeout(TALOS_TIMEOUT, machine.memory(empty_request()))
        .await
        .map_err(|_| TalosError::Timeout)?
        .map_err(TalosError::from)?
        .into_inner();
    let mounts = timeout(TALOS_TIMEOUT, machine.mounts(empty_request()))
        .await
        .map_err(|_| TalosError::Timeout)?
        .map_err(TalosError::from)?
        .into_inner();
    let network = timeout(TALOS_TIMEOUT, machine.network_device_stats(empty_request()))
        .await
        .map_err(|_| TalosError::Timeout)?
        .map_err(TalosError::from)?
        .into_inner();
    let disk_io = timeout(TALOS_TIMEOUT, machine.disk_stats(empty_request()))
        .await
        .map_err(|_| TalosError::Timeout)?
        .map_err(TalosError::from)?
        .into_inner();

    let mut storage = storage_client(endpoint, config_path).await?;
    let disks = timeout(TALOS_TIMEOUT, storage.disks(empty_request()))
        .await
        .map_err(|_| TalosError::Timeout)?
        .map_err(TalosError::from)?
        .into_inner();

    Ok(TalosHostTelemetry {
        endpoint: endpoint.to_string(),
        node_address: node_address(endpoint),
        load_average: load_average(load),
        cpu_used_percent,
        cpu_count,
        memory: memory_telemetry(memory),
        mounts: mount_telemetry(mounts),
        network: network_telemetry(network),
        disk_io: disk_io_telemetry(disk_io),
        disks: disk_inventory(disks),
    })
}

async fn fetch_service(
    endpoint: &str,
    config_path: &str,
    service: &str,
) -> Result<Option<TalosServiceInfo>, TalosError> {
    let mut client = machine_client(endpoint, config_path).await?;
    let response = timeout(TALOS_TIMEOUT, client.service_list(empty_request()))
        .await
        .map_err(|_| TalosError::Timeout)?
        .map_err(TalosError::from)?
        .into_inner();

    for message in response.messages {
        for info in message.services {
            if info.id == service {
                return Ok(Some(service_info(info)));
            }
        }
    }

    Ok(None)
}

/// Key services surfaced in the node-status header, in display order. These are
/// the "is my node OK at a glance" services — the protocore consensus extension
/// and the Talos kubelet. Any service the node doesn't report is simply omitted
/// (the header shows nothing for it rather than a fake "down").
const NODE_STATUS_KEY_SERVICES: &[&str] = &[DEFAULT_SERVICE_ID, "kubelet"];

/// How many trailing events to ask the `Events` stream for when reading the
/// last MachineStatus / Address event. Talos replays the tail and then would
/// block waiting for new events, so the reader takes the tail and stops — it
/// never holds the stream open.
const NODE_STATUS_EVENT_TAIL: i32 = 50;

/// Drain the `Events` stream tail for the most-recent `MachineStatusEvent`
/// (stage + ready + unmet conditions) and `AddressEvent` (node addresses).
/// Pure read: `tail_events` replays the recent history and we stop as soon as
/// the replayed tail is consumed, so the stream is never followed live. Returns
/// `(stage, ready, unmet_conditions, addresses)` — every component best-effort
/// (`None` / empty when no such event was in the tail).
#[allow(clippy::type_complexity)]
async fn read_machine_status_events(
    client: &mut MachineServiceClient<talos_rust_client::Channel>,
) -> Result<
    (
        Option<String>,
        Option<bool>,
        Vec<String>,
        Vec<String>,
    ),
    TalosError,
> {
    let response = timeout(
        TALOS_TIMEOUT,
        client.events(machine::EventsRequest {
            tail_events: NODE_STATUS_EVENT_TAIL,
            tail_id: String::new(),
            tail_seconds: 0,
            with_actor_id: String::new(),
        }),
    )
    .await
    .map_err(|_| TalosError::Timeout)?
    .map_err(TalosError::from)?;

    let mut stream = response.into_inner();
    let mut stage: Option<String> = None;
    let mut ready: Option<bool> = None;
    let mut unmet: Vec<String> = Vec::new();
    let mut addresses: Vec<String> = Vec::new();

    // The replayed tail arrives back-to-back; once it's drained the server
    // would block waiting for the next live event. A short per-chunk timeout
    // turns that expected block into a clean stop without following the stream.
    loop {
        let next = match timeout(Duration::from_secs(2), stream.next()).await {
            Ok(Some(item)) => item,
            // Stream ended, or no further replayed event within the window:
            // the tail is consumed — stop reading.
            Ok(None) | Err(_) => break,
        };
        let event = match next {
            Ok(event) => event,
            Err(_) => break,
        };
        let Some(any) = event.data else { continue };
        if any_type_is(&any, "MachineStatusEvent") {
            if let Ok(decoded) = machine::MachineStatusEvent::decode(any.value.as_slice()) {
                let parsed = machine::machine_status_event::MachineStage::try_from(decoded.stage)
                    .unwrap_or(machine::machine_status_event::MachineStage::Unknown);
                stage = Some(machine_stage_label(parsed).to_string());
                if let Some(status) = decoded.status {
                    ready = Some(status.ready);
                    unmet = status
                        .unmet_conditions
                        .into_iter()
                        .map(|cond| cond.name)
                        .filter(|name| !name.trim().is_empty())
                        .collect();
                }
            }
        } else if any_type_is(&any, "AddressEvent") {
            if let Ok(decoded) = machine::AddressEvent::decode(any.value.as_slice()) {
                // The latest AddressEvent carries the current address set;
                // replace rather than accumulate so a stale earlier event in
                // the tail doesn't re-add a since-removed address.
                addresses = decoded
                    .addresses
                    .into_iter()
                    .filter(|addr| !addr.trim().is_empty())
                    .collect();
            }
        }
    }

    Ok((stage, ready, unmet, addresses))
}

/// Assemble the READ-ONLY node-status snapshot from Talos read RPCs. Each source
/// is independent and best-effort: a failing read records a warning and leaves
/// its field `None`, so a partial-answer node still yields a useful header
/// instead of an all-or-nothing error.
async fn fetch_node_status(
    endpoint: &str,
    config_path: &str,
) -> Result<TalosNodeStatus, TalosError> {
    // One connection failure is fatal (nothing to report); per-RPC failures are
    // not — they degrade individual fields.
    let mut client = machine_client(endpoint, config_path).await?;
    let mut warnings: Vec<String> = Vec::new();

    let (hostname, talos_version, talos_arch) =
        match timeout(TALOS_TIMEOUT, client.version(empty_request())).await {
            Ok(Ok(resp)) => {
                let resp = resp.into_inner();
                let (version, arch) = first_version_info(&resp)
                    .map(|info| (Some(info.tag.clone()), Some(info.arch.clone())))
                    .unwrap_or((None, None));
                (None, version, arch)
            }
            Ok(Err(err)) => {
                warnings.push(format!("version: {err}"));
                (None, None, None)
            }
            Err(_) => {
                warnings.push("version: timed out".to_string());
                (None, None, None)
            }
        };

    let hostname = match timeout(TALOS_TIMEOUT, client.hostname(empty_request())).await {
        Ok(Ok(resp)) => resp
            .into_inner()
            .messages
            .into_iter()
            .find_map(|msg| {
                let name = msg.hostname.trim().to_string();
                if name.is_empty() {
                    None
                } else {
                    Some(name)
                }
            })
            .or(hostname),
        Ok(Err(err)) => {
            warnings.push(format!("hostname: {err}"));
            hostname
        }
        Err(_) => {
            warnings.push("hostname: timed out".to_string());
            hostname
        }
    };

    let uptime_seconds = match timeout(TALOS_TIMEOUT, client.system_stat(empty_request())).await {
        Ok(Ok(resp)) => resp
            .into_inner()
            .messages
            .into_iter()
            .find_map(|stat| {
                // `now - bootTime`. Guard against a future/zero boot time
                // (clock skew) by reporting nothing rather than a bogus value.
                unix_now().ok().and_then(|now| {
                    if stat.boot_time > 0 && now >= stat.boot_time {
                        Some(now - stat.boot_time)
                    } else {
                        None
                    }
                })
            }),
        Ok(Err(err)) => {
            warnings.push(format!("uptime: {err}"));
            None
        }
        Err(_) => {
            warnings.push("uptime: timed out".to_string());
            None
        }
    };

    let services = match timeout(TALOS_TIMEOUT, client.service_list(empty_request())).await {
        Ok(Ok(resp)) => {
            let mut found: Vec<TalosNodeServiceState> = Vec::new();
            for message in resp.into_inner().messages {
                for info in message.services {
                    if NODE_STATUS_KEY_SERVICES.contains(&info.id.as_str()) {
                        let summary = service_info(info);
                        found.push(TalosNodeServiceState {
                            id: summary.id,
                            state: summary.state,
                            display_state: summary.display_state,
                            severity: summary.severity,
                            healthy: summary.healthy,
                            health_unknown: summary.health_unknown,
                        });
                    }
                }
            }
            // Stable, predictable order regardless of how the node enumerated
            // them: ext-protocore first, then kubelet.
            found.sort_by_key(|svc| {
                NODE_STATUS_KEY_SERVICES
                    .iter()
                    .position(|id| *id == svc.id)
                    .unwrap_or(usize::MAX)
            });
            found
        }
        Ok(Err(err)) => {
            warnings.push(format!("services: {err}"));
            Vec::new()
        }
        Err(_) => {
            warnings.push("services: timed out".to_string());
            Vec::new()
        }
    };

    let (stage, ready, unmet_conditions, addresses) =
        match read_machine_status_events(&mut client).await {
            Ok(values) => values,
            Err(err) => {
                warnings.push(format!("events: {err}"));
                (None, None, Vec::new(), Vec::new())
            }
        };

    Ok(TalosNodeStatus {
        node_address: node_address(endpoint),
        endpoint: endpoint.to_string(),
        stage,
        ready,
        unmet_conditions,
        hostname,
        talos_version,
        talos_arch,
        uptime_seconds,
        addresses,
        services,
        warnings,
    })
}

#[derive(Debug, Default)]
struct ProtocoreRpcProbe {
    chain_id: Option<u64>,
    chain_id_error: Option<String>,
    block_number: Option<u64>,
    block_number_error: Option<String>,
    client_version: Option<String>,
    client_version_error: Option<String>,
    listening: Option<bool>,
    listening_error: Option<String>,
    syncing: Option<bool>,
    syncing_error: Option<String>,
    /// `true` once *any* probed method got a well-formed JSON-RPC answer from
    /// the node — a result OR a structured error (e.g. `-32045` "method
    /// disabled"). It stays `false` only when every call failed at the
    /// transport layer, i.e. the node never responded at all. This is the
    /// profile-independent "the node is up and serving RPC" signal: an
    /// operator that disables the whole `eth_*` namespace still answers, and
    /// must not be misread as "Booting".
    rpc_answered: bool,
}

fn parse_rpc_u64(value: &Value) -> Option<u64> {
    match value {
        Value::String(raw) => parse_u64_string(raw),
        Value::Number(number) => number.as_u64(),
        _ => None,
    }
}

fn parse_u64_string(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        u64::from_str_radix(hex, 16).ok()
    } else {
        trimmed.parse::<u64>().ok()
    }
}

fn parse_rpc_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        _ => None,
    }
}

fn parse_rpc_syncing(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::Object(_) => Some(true),
        _ => None,
    }
}

/// Failure mode of a single JSON-RPC call.
///
/// The distinction matters for readiness: a node that returns a well-formed
/// JSON-RPC *error* (e.g. `-32045` "method disabled" / `-32601` "method not
/// found") received and answered the request — it is up and serving — whereas
/// a transport failure (connection refused / timeout / no HTTP response) means
/// the node is genuinely unreachable. Only the latter should read as "down".
#[derive(Debug)]
enum RpcCallError {
    /// The node never produced a usable HTTP/JSON-RPC response (connection
    /// refused, timeout, malformed body). The node is unreachable.
    Transport(String),
    /// The node answered with a structured JSON-RPC error or a non-success
    /// HTTP status carrying a body. The node is up; the method just failed.
    Answered(String),
}

impl RpcCallError {
    /// Whether the node produced *any* well-formed answer (result or error).
    fn answered(&self) -> bool {
        matches!(self, RpcCallError::Answered(_))
    }

    fn message(&self) -> String {
        match self {
            RpcCallError::Transport(msg) | RpcCallError::Answered(msg) => msg.clone(),
        }
    }
}

impl std::fmt::Display for RpcCallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

async fn rpc_call_with_params(
    client: &reqwest::Client,
    endpoint: &str,
    method: &str,
    params: Value,
) -> Result<Value, RpcCallError> {
    let response = timeout(
        PROTOCORE_RPC_TIMEOUT,
        client
            .post(endpoint)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": params,
            }))
            .send(),
    )
    .await
    .map_err(|_| RpcCallError::Transport(format!("{method} timed out")))?
    .map_err(|err| RpcCallError::Transport(format!("{method} transport failed: {err}")))?;

    let status = response.status();
    let body = response.json::<Value>().await.map_err(|err| {
        // The connection succeeded but the payload was not parseable JSON —
        // treat it as a transport-level failure: we have no JSON-RPC answer to
        // trust, so this must not count as "the node answered".
        RpcCallError::Transport(format!("{method} returned invalid JSON: {err}"))
    })?;

    if !status.is_success() {
        // A non-2xx HTTP status still means the node spoke to us. It answered.
        return Err(RpcCallError::Answered(format!(
            "{method} returned HTTP {status}: {body}"
        )));
    }
    if let Some(error) = body.get("error") {
        // A structured JSON-RPC error is an answer: the node received and
        // processed the request (e.g. the method is disabled on this profile).
        return Err(RpcCallError::Answered(format!(
            "{method} returned RPC error: {error}"
        )));
    }
    body.get("result").cloned().ok_or_else(|| {
        RpcCallError::Answered(format!("{method} response missing result"))
    })
}

async fn rpc_call(
    client: &reqwest::Client,
    endpoint: &str,
    method: &str,
) -> Result<Value, RpcCallError> {
    rpc_call_with_params(client, endpoint, method, json!([])).await
}

async fn fetch_protocore_rpc_probe(endpoint: &str) -> ProtocoreRpcProbe {
    let client = match reqwest::Client::builder()
        .timeout(PROTOCORE_RPC_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            return ProtocoreRpcProbe {
                chain_id_error: Some(format!("failed to build RPC client: {err}")),
                block_number_error: Some(format!("failed to build RPC client: {err}")),
                client_version_error: Some(format!("failed to build RPC client: {err}")),
                listening_error: Some(format!("failed to build RPC client: {err}")),
                syncing_error: Some(format!("failed to build RPC client: {err}")),
                ..Default::default()
            };
        }
    };

    let mut probe = ProtocoreRpcProbe::default();

    match rpc_call(&client, endpoint, "web3_clientVersion").await {
        Ok(value) => {
            probe.rpc_answered = true;
            match value.as_str() {
                Some(value) => probe.client_version = Some(value.to_string()),
                None => {
                    probe.client_version_error =
                        Some("web3_clientVersion result was not a string".to_string())
                }
            }
        }
        Err(err) => {
            probe.rpc_answered |= err.answered();
            probe.client_version_error = Some(err.message());
        }
    }

    match rpc_call(&client, endpoint, "eth_chainId").await {
        Ok(value) => {
            probe.rpc_answered = true;
            match parse_rpc_u64(&value) {
                Some(value) => probe.chain_id = Some(value),
                None => {
                    probe.chain_id_error =
                        Some(format!("eth_chainId result was not numeric: {value}"))
                }
            }
        }
        Err(err) => {
            probe.rpc_answered |= err.answered();
            probe.chain_id_error = Some(err.message());
        }
    }

    match rpc_call(&client, endpoint, "eth_blockNumber").await {
        Ok(value) => {
            probe.rpc_answered = true;
            match parse_rpc_u64(&value) {
                Some(value) => probe.block_number = Some(value),
                None => {
                    probe.block_number_error =
                        Some(format!("eth_blockNumber result was not numeric: {value}"))
                }
            }
        }
        Err(err) => {
            probe.rpc_answered |= err.answered();
            probe.block_number_error = Some(err.message());
        }
    }

    match rpc_call(&client, endpoint, "eth_syncing").await {
        Ok(value) => {
            probe.rpc_answered = true;
            match parse_rpc_syncing(&value) {
                Some(value) => probe.syncing = Some(value),
                None => {
                    probe.syncing_error = Some(format!(
                        "eth_syncing result was not boolean/object: {value}"
                    ))
                }
            }
        }
        Err(err) => {
            probe.rpc_answered |= err.answered();
            probe.syncing_error = Some(err.message());
        }
    }

    match rpc_call(&client, endpoint, "net_listening").await {
        Ok(value) => {
            probe.rpc_answered = true;
            match parse_rpc_bool(&value) {
                Some(value) => probe.listening = Some(value),
                None => {
                    probe.listening_error =
                        Some(format!("net_listening result was not boolean: {value}"))
                }
            }
        }
        Err(err) => {
            probe.rpc_answered |= err.answered();
            probe.listening_error = Some(err.message());
        }
    }

    // Profile fallback: an operator node commonly disables the `eth_*` compat
    // namespace (the canonical "public-read" allow-list keeps it, but operators
    // routinely narrow their surface), so `eth_chainId` / `eth_blockNumber` /
    // `eth_syncing` come back as a `-32045`/`-32601` answer with no value. The
    // node chip reads the same facts from the `lyth_*` namespace, so mirror
    // that here before classifying. Only attempt this when the node is actually
    // answering — there is no point re-probing an unreachable endpoint.
    if probe.rpc_answered {
        if probe.chain_id.is_none() || probe.block_number.is_none() {
            match rpc_call(&client, endpoint, "lyth_chainStatus").await {
                Ok(value) => {
                    // Shape: { chainId, blockHeight, finalizedHeight } — the
                    // same object consumed by the node chip (useNodeStatus.ts).
                    if probe.chain_id.is_none() {
                        if let Some(chain_id) =
                            value.get("chainId").and_then(parse_rpc_u64)
                        {
                            probe.chain_id = Some(chain_id);
                            probe.chain_id_error = None;
                        }
                    }
                    if probe.block_number.is_none() {
                        if let Some(height) = value
                            .get("blockHeight")
                            .or_else(|| value.get("finalizedHeight"))
                            .and_then(parse_rpc_u64)
                        {
                            probe.block_number = Some(height);
                            probe.block_number_error = None;
                        }
                    }
                }
                Err(err) => {
                    // `lyth_chainStatus` itself may be disabled. That is fine —
                    // the `rpc_answered` signal already proves the node is up,
                    // and the syncing fallback below still runs.
                    probe.rpc_answered |= err.answered();
                }
            }
        }

        // Mirror the chip's "synced" read when `eth_syncing` was unavailable:
        // a healthy node is synced when its DAG round trails the committee head
        // by no more than SYNCED_LAG and has advanced past round 0
        // (useNodeStatus.ts:136-145).
        if probe.syncing.is_none() {
            match rpc_call(&client, endpoint, "lyth_syncStatus").await {
                Ok(value) => {
                    if let Some(synced) = sync_status_is_synced(&value) {
                        probe.syncing = Some(!synced);
                        probe.syncing_error = None;
                    }
                }
                Err(err) => {
                    probe.rpc_answered |= err.answered();
                }
            }
        }
    }

    probe
}

/// Within a few rounds of the committee head counts as caught up, mirroring
/// `SYNCED_LAG` in `useNodeStatus.ts`. The chain advances every few seconds, so
/// a healthy local round trails the freshest advertised round by a small margin.
const SYNC_STATUS_SYNCED_LAG: u64 = 5;

/// Decide whether a `lyth_syncStatus` payload reports a caught-up node, using
/// the same rule the node chip applies (`useNodeStatus.ts` / `SyncStep.tsx`):
/// synced when `lag <= SYNCED_LAG` and `localRound > 0`. Returns `None` when the
/// payload carries neither a usable `lag`/round nor an explicit `state` we can
/// read, so the caller can leave `syncing` unknown rather than guess.
fn sync_status_is_synced(value: &Value) -> Option<bool> {
    let local_round = value.get("localRound").and_then(parse_rpc_u64);
    let peer_max_round = value.get("peerMaxRound").and_then(parse_rpc_u64);
    let lag = value
        .get("lag")
        .and_then(parse_rpc_u64)
        .or_else(|| match (local_round, peer_max_round) {
            (Some(local), Some(peer)) => Some(peer.saturating_sub(local)),
            _ => None,
        });

    // An explicit "catching"/"syncing" state string is authoritative when present.
    if let Some(state) = value.get("state").and_then(Value::as_str) {
        let lowered = state.to_ascii_lowercase();
        if lowered.contains("catch") || lowered.contains("sync") {
            return Some(false);
        }
    }

    match (lag, local_round) {
        (Some(lag), Some(local_round)) => {
            Some(lag <= SYNC_STATUS_SYNCED_LAG && local_round > 0)
        }
        // No lag we can compute but the state string didn't flag catching-up:
        // treat a positive local round as caught up; otherwise unknown.
        (None, Some(local_round)) if local_round > 0 => Some(true),
        _ => None,
    }
}

fn readiness_check(name: &str, state: &str, message: impl Into<String>) -> TalosReadinessCheck {
    TalosReadinessCheck {
        name: name.to_string(),
        state: state.to_string(),
        message: message.into(),
    }
}

/// Detect the operator-quarantine signal in a probed RPC error.
///
/// A forked/diverged operator self-quarantines and answers chain-data RPC with
/// a `-32047` `CheckpointStateRootMismatch` (epoch-seed divergence). `-32047`
/// is OVERLOADED on the fleet — it ALSO means a sealed-mempool envelope
/// decrypt-failure — so we MUST message-gate on the text, never the bare code.
/// The RPC errors here are already rendered to `message` form (code is folded
/// in), so we match the substring case-insensitively.
fn rpc_error_is_quarantine(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("checkpointstaterootmismatch") || lower.contains("quarantin")
}

fn classify_protocore_readiness(
    mut service: Option<TalosServiceInfo>,
    rpc_endpoint: String,
    rpc: ProtocoreRpcProbe,
) -> ProtocoreReadiness {
    // Message-gated quarantine detection across the chain-data probes. A
    // diverged operator answers RPC (so it looks "serving") but every
    // chain-data method returns the CheckpointStateRootMismatch error — that
    // is the authoritative "this node is quarantined" signal.
    let quarantine_message = [
        rpc.block_number_error.as_deref(),
        rpc.chain_id_error.as_deref(),
        rpc.syncing_error.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find(|err| rpc_error_is_quarantine(err))
    .map(|err| err.to_string());

    let rpc_has_chain = rpc.chain_id.is_some() && rpc.block_number.is_some();
    // A node that returned ANY well-formed JSON-RPC answer (result OR a
    // structured error such as -32045 "method disabled") is up and serving the
    // request — even when every method we asked for is gated off and we could
    // read no chain data. That is the profile-independent "serving" signal.
    // The only downgrade we keep is when a *working* method actually reports
    // syncing=true.
    let rpc_answered = rpc.rpc_answered;
    let rpc_serving_chain_data = rpc_has_chain && rpc.syncing != Some(true);
    let rpc_serving = (rpc_serving_chain_data || rpc_answered) && rpc.syncing != Some(true);
    let p2p_degraded = rpc.listening == Some(false);

    if rpc_serving {
        if let Some(service) = service.as_mut() {
            // The Talos health flag is advisory for ext-protocore: a node that
            // answers RPC is authoritative proof it is up and serving, whether
            // it returns chain data outright or only proves liveness by
            // answering a (possibly gated) request. Recover the display whether
            // the health check is still pending (health_unknown) OR has
            // completed with healthy=false, since a stale/failed Talos health
            // probe must not paint a serving node "degraded". We deliberately
            // do NOT touch a genuinely down service: a raw state of
            // failed/stopped/down still wins, because those mean the process is
            // not running (so the RPC, if it answered, is some other endpoint
            // and the readiness arms below will treat it as such).
            let raw_lower = service.state.to_ascii_lowercase();
            let genuinely_down = raw_lower.contains("fail")
                || raw_lower.contains("stop")
                || raw_lower.contains("down");
            let health_pending = service.health_unknown == Some(true);
            let health_failed = service.healthy == Some(false);
            if !genuinely_down
                && (health_pending || health_failed)
                && matches!(
                    service.display_state.as_str(),
                    "degraded" | "waiting-for-config"
                )
            {
                service.display_state = "running".to_string();
                service.severity = "ok".to_string();
                let rpc_detail = if rpc_serving_chain_data {
                    "RPC is serving chain data"
                } else {
                    "RPC is answering (some namespaces are restricted on this node)"
                };
                service.summary = if health_pending {
                    format!("{} is running; Talos health is pending, {rpc_detail}", service.id)
                } else {
                    format!(
                        "{} is running; Talos health reports unhealthy but {rpc_detail} (treating RPC as authoritative)",
                        service.id
                    )
                };
            }
        }
    }

    let mut checks = Vec::new();
    match &service {
        Some(service) => checks.push(readiness_check(
            "talos-service",
            &service.severity,
            service.summary.clone(),
        )),
        None => checks.push(readiness_check(
            "talos-service",
            "warn",
            "ext-protocore is not registered in Talos service list",
        )),
    }

    checks.push(match (&rpc.client_version, &rpc.client_version_error) {
        (Some(version), _) => readiness_check("client-version", "ok", version.clone()),
        (_, Some(err)) => readiness_check("client-version", "warn", err.clone()),
        _ => readiness_check("client-version", "warn", "web3_clientVersion unavailable"),
    });
    checks.push(match (rpc.chain_id, &rpc.chain_id_error) {
        (Some(chain_id), _) => readiness_check("chain-id", "ok", format!("chain_id {chain_id}")),
        (_, Some(err)) => readiness_check("chain-id", "err", err.clone()),
        _ => readiness_check("chain-id", "err", "eth_chainId unavailable"),
    });
    checks.push(match (rpc.block_number, &rpc.block_number_error) {
        (Some(block), _) => readiness_check("block-number", "ok", format!("block {block}")),
        (_, Some(err)) => readiness_check("block-number", "err", err.clone()),
        _ => readiness_check("block-number", "err", "eth_blockNumber unavailable"),
    });
    checks.push(match (rpc.syncing, &rpc.syncing_error) {
        (Some(true), _) => readiness_check("syncing", "info", "node reports eth_syncing=true"),
        (Some(false), _) => readiness_check("syncing", "ok", "node reports eth_syncing=false"),
        (_, Some(err)) => readiness_check("syncing", "warn", err.clone()),
        _ => readiness_check("syncing", "warn", "eth_syncing unavailable"),
    });
    checks.push(match (rpc.listening, &rpc.listening_error) {
        (Some(true), _) => readiness_check("p2p-listening", "ok", "net_listening=true"),
        (Some(false), _) => readiness_check("p2p-listening", "warn", "net_listening=false"),
        (_, Some(err)) => readiness_check("p2p-listening", "warn", err.clone()),
        _ => readiness_check("p2p-listening", "warn", "net_listening unavailable"),
    });

    if quarantine_message.is_some() {
        checks.push(readiness_check(
            "quarantine",
            "err",
            "node self-quarantined: CheckpointStateRootMismatch (epoch-seed divergence; node release v0.1.60 carries the fix)",
        ));
    }

    let service_state = service
        .as_ref()
        .map(|service| service.display_state.as_str())
        .unwrap_or("waiting-for-config");

    let (display_state, severity, summary) = match service_state {
        "failed" => (
            "failed",
            "err",
            service
                .as_ref()
                .map(|service| service.summary.clone())
                .unwrap_or_else(|| "ext-protocore failed".to_string()),
        ),
        "degraded" => (
            "degraded",
            "err",
            service
                .as_ref()
                .map(|service| service.summary.clone())
                .unwrap_or_else(|| "ext-protocore health check failed".to_string()),
        ),
        "stopped" => (
            "stopped",
            "warn",
            "ext-protocore is stopped; RPC is not expected to serve chain data".to_string(),
        ),
        "restarting" => (
            "restarting",
            "info",
            "ext-protocore is starting or restarting; RPC readiness may still be pending"
                .to_string(),
        ),
        "waiting-for-config" => (
            "waiting-for-config",
            "warn",
            "ext-protocore is waiting for service config, secrets, or first-boot enrollment"
                .to_string(),
        ),
        // A diverged operator answers RPC (so the serving arms below would
        // otherwise paint it "ok") but every chain-data method returns the
        // CheckpointStateRootMismatch error. That self-quarantine is a hard
        // error and wins over any serving/syncing read. Message-gated above —
        // never on the bare -32047 code (overloaded with sealed-mempool
        // decryption).
        _ if quarantine_message.is_some() => (
            "quarantined",
            "err",
            "Quarantined — CheckpointStateRootMismatch (epoch-seed divergence; node release v0.1.60 carries the fix)".to_string(),
        ),
        _ if rpc_serving_chain_data && p2p_degraded => (
            "serving-rpc",
            "warn",
            format!(
                "Protocore RPC is serving chain_id {} at block {}, but P2P listening is false",
                rpc.chain_id.unwrap_or_default(),
                rpc.block_number.unwrap_or_default()
            ),
        ),
        _ if rpc_serving_chain_data => (
            "serving-rpc",
            "ok",
            format!(
                "Protocore RPC is serving chain_id {} at block {}",
                rpc.chain_id.unwrap_or_default(),
                rpc.block_number.unwrap_or_default()
            ),
        ),
        // The node answered RPC but the methods we read chain data from are
        // gated off on this profile. Answering is authoritative proof it is up
        // and serving, so report serving rather than the raw Talos boot state.
        _ if rpc_serving => (
            "serving-rpc",
            "ok",
            "Protocore RPC is serving — chain-data RPC namespaces are restricted on this node"
                .to_string(),
        ),
        _ if rpc.syncing == Some(true) => (
            "syncing",
            "info",
            "Protocore RPC is reachable and reports it is syncing".to_string(),
        ),
        _ => (
            "syncing",
            "warn",
            "ext-protocore is running, but RPC is not serving chain data yet".to_string(),
        ),
    };

    ProtocoreReadiness {
        service,
        rpc_endpoint,
        display_state: display_state.to_string(),
        severity: severity.to_string(),
        summary,
        chain_id: rpc.chain_id,
        block_number: rpc.block_number,
        client_version: rpc.client_version,
        listening: rpc.listening,
        syncing: rpc.syncing,
        checks,
    }
}

#[tauri::command]
pub async fn rpc_runtime_provenance(rpc_endpoint: String) -> Result<Value, String> {
    let parsed =
        reqwest::Url::parse(&rpc_endpoint).map_err(|err| format!("invalid RPC endpoint: {err}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("RPC endpoint must use http:// or https://".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(PROTOCORE_RPC_TIMEOUT)
        .build()
        .map_err(|err| format!("failed to build RPC client: {err}"))?;
    rpc_call(&client, &rpc_endpoint, "lyth_runtimeProvenance")
        .await
        .map_err(|err| err.message())
}

#[tauri::command]
pub async fn rpc_call_json(
    rpc_endpoint: String,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let parsed =
        reqwest::Url::parse(&rpc_endpoint).map_err(|err| format!("invalid RPC endpoint: {err}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("RPC endpoint must use http:// or https://".to_string());
    }
    let method = method.trim();
    if method.is_empty() {
        return Err("RPC method is required".to_string());
    }
    if !matches!(method, "lyth_clusterStatus" | "lyth_operatorInfo") {
        return Err(format!(
            "RPC method {method} is not allowed through this bridge"
        ));
    }
    let params = params.unwrap_or_else(|| json!([]));
    if !params.is_array() {
        return Err("RPC params must be a JSON array".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(PROTOCORE_RPC_TIMEOUT)
        .build()
        .map_err(|err| format!("failed to build RPC client: {err}"))?;
    rpc_call_with_params(&client, &rpc_endpoint, method, params)
        .await
        .map_err(|err| err.message())
}

/// General JSON-RPC read proxy for the in-app SDK transport.
///
/// The Tauri webview runs on a secure origin (`tauri://localhost`), so a
/// direct `fetch()` from the SDK's `RpcClient` to a node's plain-http
/// `:8545` is blocked as mixed content ("Load failed"). Routing the raw
/// JSON-RPC POST through the native HTTP stack avoids that entirely — and
/// since the node's RPC is read-only (writes require signed transactions
/// over other paths), proxying the operator's own endpoint is safe.
///
/// Returns `(http_status, body)`: the HTTP status so the SDK can report the
/// node's *real* status (a 404/502 from a wrong path or a downed reverse
/// proxy must not masquerade as 200), and the body verbatim (JSON-RPC
/// envelope intact, including any `error` member) so the SDK's own error
/// handling stays authoritative.
///
/// Trust boundary: this command deliberately bypasses the webview
/// CSP/mixed-content guard, so the endpoint it reaches is whatever the
/// operator configured (`monarch.rpcEndpoint`). That is intended — operators
/// legitimately point at arbitrary nodes — but it means any caller inside the
/// webview can reach an arbitrary http(s) host. Scheme is validated; no host
/// allowlist (would break legitimate node choice).
#[tauri::command]
pub async fn rpc_proxy(rpc_endpoint: String, body: String) -> Result<(u16, String), String> {
    let parsed =
        reqwest::Url::parse(&rpc_endpoint).map_err(|err| format!("invalid RPC endpoint: {err}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("RPC endpoint must use http:// or https://".to_string());
    }
    // The general read transport carries every dashboard read (including
    // heavier ranged queries to a possibly-distant node), so it gets a more
    // forgiving timeout than the narrow 4s health bridges. reqwest's
    // `.timeout` bounds the whole request, so no extra `tokio::timeout` wrap.
    let client = reqwest::Client::builder()
        .timeout(RPC_PROXY_TIMEOUT)
        .build()
        .map_err(|err| format!("failed to build RPC client: {err}"))?;
    let response = client
        .post(rpc_endpoint)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|err| format!("RPC transport failed: {err}"))?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|err| format!("RPC returned an unreadable body: {err}"))?;
    Ok((status, text))
}

async fn build_status(state: &TalosState) -> Result<TalosStatus, TalosError> {
    let (endpoint, config_path) = resolve_config(state).await?;
    let configured = endpoint.is_some() && config_path.is_some();

    let (endpoint, config_path) = match (endpoint, config_path) {
        (Some(endpoint), Some(config_path)) => (endpoint, config_path),
        (endpoint, config_path) => {
            return Ok(TalosStatus {
                configured,
                reachable: false,
                endpoint,
                node_address: None,
                config_path,
                client_mode: "native".to_string(),
                version: None,
                last_error: None,
            });
        }
    };

    let endpoint_url = endpoint_url(&endpoint)?;
    let node = node_address(&endpoint_url);
    match machine_client(&endpoint_url, &config_path).await {
        Ok(mut client) => match timeout(TALOS_TIMEOUT, client.version(empty_request())).await {
            Ok(Ok(version)) => Ok(TalosStatus {
                configured: true,
                reachable: true,
                endpoint: Some(endpoint_url),
                node_address: Some(node),
                config_path: Some(config_path),
                client_mode: "native".to_string(),
                version: Some(format_version(version.into_inner())),
                last_error: None,
            }),
            Ok(Err(err)) => Ok(TalosStatus {
                configured: true,
                reachable: false,
                endpoint: Some(endpoint_url),
                node_address: Some(node),
                config_path: Some(config_path),
                client_mode: "native".to_string(),
                version: None,
                last_error: Some(err.to_string()),
            }),
            Err(_) => Ok(TalosStatus {
                configured: true,
                reachable: false,
                endpoint: Some(endpoint_url),
                node_address: Some(node),
                config_path: Some(config_path),
                client_mode: "native".to_string(),
                version: None,
                last_error: Some(TalosError::Timeout.to_string()),
            }),
        },
        Err(err) => Ok(TalosStatus {
            configured: true,
            reachable: false,
            endpoint: Some(endpoint_url),
            node_address: Some(node),
            config_path: Some(config_path),
            client_mode: "native".to_string(),
            version: None,
            last_error: Some(err.to_string()),
        }),
    }
}

/// Persist + activate a talosconfig selection: store the endpoint and config
/// path in the keychain (the same accounts `resolve_config` reads back), drop
/// any log streams bound to the previous node, and update the in-memory state.
/// Shared by `talos_connect` and the post-provision registration path.
async fn store_talos_selection(
    state: &TalosState,
    endpoint: String,
    config_path: String,
) -> Result<(), TalosError> {
    keychain::store_credential(TALOS_ENDPOINT_ACCOUNT, &endpoint)?;
    keychain::store_credential(TALOS_CONFIG_PATH_ACCOUNT, &config_path)?;

    let mut guard = state.lock().await;
    for (_, stream) in guard.log_streams.drain() {
        stream.abort.abort();
    }
    guard.endpoint = Some(endpoint);
    guard.config_path = Some(config_path);
    Ok(())
}

/// Register a freshly provisioned node's talosconfig as the app's active Talos
/// identity, so `talos_status` / `talos_config_info` (and every view on top of
/// them) resolve it immediately — no manual connect step after provisioning.
///
/// Also pins the CA fingerprint (`talos:ca-fingerprint`): unlike a talosconfig
/// imported from elsewhere, this CA was minted by this app seconds ago for
/// this exact node, so trusting it is first-party — not trust-on-first-use of
/// unknown material. Privileged operations therefore work as soon as the node
/// is back up.
pub(crate) async fn register_provisioned_talosconfig(
    state: &TalosState,
    host: &str,
    config_path: &str,
) -> Result<(), TalosError> {
    let endpoint = endpoint_url(host)?;
    let config_path = validate_config_path(config_path)?;
    let info = build_config_info(Some(&endpoint), &config_path)?;
    keychain::store_credential(TALOS_CA_FINGERPRINT_ACCOUNT, &info.ca_fingerprint)?;
    store_talos_selection(state, endpoint, config_path).await
}

#[tauri::command]
pub async fn talos_connect(
    state: State<'_, TalosState>,
    endpoint: String,
    config_path: String,
) -> Result<TalosStatus, String> {
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let config_path = validate_config_path(&config_path).map_err(|e| e.to_string())?;

    store_talos_selection(&state, endpoint, config_path)
        .await
        .map_err(|e| e.to_string())?;

    build_status(&state).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn talos_status(state: State<'_, TalosState>) -> Result<TalosStatus, String> {
    build_status(&state).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn talos_config_info(
    state: State<'_, TalosState>,
    endpoint: Option<String>,
    config_path: Option<String>,
) -> Result<TalosConfigInfo, String> {
    let (saved_endpoint, saved_config_path) =
        resolve_config(&state).await.map_err(|e| e.to_string())?;
    let explicit_endpoint = endpoint.filter(|value| !value.trim().is_empty());
    let explicit_config_path = config_path.filter(|value| !value.trim().is_empty());
    let endpoint = explicit_endpoint.or_else(|| {
        if explicit_config_path.is_some() {
            None
        } else {
            saved_endpoint
        }
    });
    let config_path = explicit_config_path
        .or(saved_config_path)
        .ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let config_path = validate_config_path(&config_path).map_err(|e| e.to_string())?;

    build_config_info(endpoint.as_deref(), &config_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn talos_trust_config(
    state: State<'_, TalosState>,
    endpoint: Option<String>,
    config_path: Option<String>,
) -> Result<TalosConfigInfo, String> {
    let (saved_endpoint, saved_config_path) =
        resolve_config(&state).await.map_err(|e| e.to_string())?;
    let explicit_endpoint = endpoint.filter(|value| !value.trim().is_empty());
    let explicit_config_path = config_path.filter(|value| !value.trim().is_empty());
    let endpoint = explicit_endpoint.or_else(|| {
        if explicit_config_path.is_some() {
            None
        } else {
            saved_endpoint
        }
    });
    let config_path = explicit_config_path
        .or(saved_config_path)
        .ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let config_path = validate_config_path(&config_path).map_err(|e| e.to_string())?;
    let info = build_config_info(endpoint.as_deref(), &config_path).map_err(|e| e.to_string())?;
    keychain::store_credential(TALOS_CA_FINGERPRINT_ACCOUNT, &info.ca_fingerprint)
        .map_err(|e| e.to_string())?;
    build_config_info(Some(&info.endpoint), &config_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn talos_service(
    state: State<'_, TalosState>,
    service: String,
) -> Result<TalosTextResult, String> {
    let service = validate_service_name(&service).map_err(|e| e.to_string())?;
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let service_info = fetch_service(&endpoint, &config_path, &service)
        .await
        .map_err(|e| e.to_string())?;
    let output = service_info
        .as_ref()
        .map(format_service)
        .unwrap_or_else(|| format!("{service} not found"));
    Ok(TalosTextResult {
        node_address: node_address(&endpoint),
        endpoint,
        command: format!("talos service {service} status"),
        output,
        service: service_info,
    })
}

#[tauri::command]
pub async fn talos_protocore_readiness(
    state: State<'_, TalosState>,
    rpc_endpoint: Option<String>,
) -> Result<ProtocoreReadiness, String> {
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let rpc_endpoint =
        protocore_rpc_endpoint(&endpoint, rpc_endpoint.as_deref()).map_err(|e| e.to_string())?;
    let service = fetch_service(&endpoint, &config_path, DEFAULT_SERVICE_ID)
        .await
        .map_err(|e| e.to_string())?;
    let rpc_probe = fetch_protocore_rpc_probe(&rpc_endpoint).await;
    Ok(classify_protocore_readiness(
        service,
        rpc_endpoint,
        rpc_probe,
    ))
}

#[tauri::command]
pub async fn talos_host_telemetry(
    state: State<'_, TalosState>,
) -> Result<TalosHostTelemetry, String> {
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    fetch_host_telemetry(&endpoint, &config_path)
        .await
        .map_err(|e| e.to_string())
}

/// READ-ONLY node-status header feed: the same at-a-glance fields the Talos
/// console/VNC dashboard shows (Stage, ready, hostname, version, uptime, key
/// service states, node addresses), pulled over Talos *read* RPCs only. This
/// command issues NO state-changing call — no service control, no config patch,
/// no upgrade/reboot/wipe. Polled by the in-app header so operators don't have
/// to open the VNC console to check node health. Field-level reads are
/// best-effort: an unreachable node errors, but a partially-answering node
/// returns whatever it could and records the rest in `warnings`.
#[tauri::command]
pub async fn talos_node_status(
    state: State<'_, TalosState>,
) -> Result<TalosNodeStatus, String> {
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    fetch_node_status(&endpoint, &config_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn talos_export_protocore_backup(
    state: State<'_, TalosState>,
) -> Result<TalosBackupResult, String> {
    let created_at_unix = unix_now().map_err(|e| e.to_string())?;
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let control_plane =
        build_config_info(Some(&endpoint), &config_path).map_err(|e| e.to_string())?;
    enforce_privileged_control_plane(&control_plane).map_err(|e| e.to_string())?;

    let service = fetch_service(&endpoint, &config_path, DEFAULT_SERVICE_ID)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            TalosError::Backup(format!(
                "{DEFAULT_SERVICE_ID} is not registered in the Talos service list"
            ))
            .to_string()
        })?;
    if !service_allows_offline_backup(&service) {
        return Err(TalosError::Backup(format!(
            "offline backup refused because {DEFAULT_SERVICE_ID} is {}; stop Protocore before exporting /var/lib/protocore",
            service.display_state
        ))
        .to_string());
    }

    let node = node_address(&endpoint);
    let (archive_path, manifest_path) =
        backup_paths(&node, created_at_unix).map_err(|e| e.to_string())?;
    let backup_dir = archive_path.parent().ok_or_else(|| {
        TalosError::Backup("backup archive path has no parent directory".to_string()).to_string()
    })?;
    fs::create_dir_all(backup_dir).map_err(|err| {
        TalosError::FileSystem(format!("create backup directory: {err}")).to_string()
    })?;

    let (archive_size_bytes, archive_sha256) =
        write_talos_copy_archive(&endpoint, &config_path, PROTOCORE_DATA_DIR, &archive_path)
            .await
            .map_err(|err| {
                let _ = fs::remove_file(&archive_path);
                err.to_string()
            })?;

    let archive_abs = archive_path.display().to_string();
    let manifest_abs = manifest_path.display().to_string();
    let command = format!("talos copy {PROTOCORE_DATA_DIR} > {archive_abs}");
    let service_display_state = service.display_state.clone();
    let service_raw_state = service.state.clone();
    let manifest = json!({
        "schema_version": "monarch-desktop-protocore-backup/v1",
        "created_at_unix_seconds": created_at_unix,
        "ok": true,
        "hot_backup": false,
        "source": {
            "path": PROTOCORE_DATA_DIR,
            "expected_restore_path": PROTOCORE_DATA_DIR,
        },
        "talos": {
            "endpoint": endpoint.clone(),
            "node_address": node.clone(),
            "service_id": DEFAULT_SERVICE_ID,
            "service_state": service_display_state,
            "service_raw_state": service_raw_state,
            "command": command.clone(),
        },
        "backup": {
            "mode": "stopped-protocore-talos-copy",
            "archive_path": archive_abs.clone(),
            "archive_sha256": archive_sha256.clone(),
            "archive_size_bytes": archive_size_bytes,
            "manifest_path": manifest_abs.clone(),
            "encrypted_by_this_tool": false,
        },
        "restore": {
            "service_stopped_before_backup": true,
            "service_stopped_before_restore": true,
            "post_restore_checks": [
                "release-digest-match",
                "genesis-match",
                "chain-id-match",
                "protocore-rpc-healthy"
            ],
        },
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|err| TalosError::Backup(format!("serialize manifest: {err}")).to_string())?;
    fs::write(&manifest_path, &manifest_bytes).map_err(|err| {
        TalosError::FileSystem(format!("write backup manifest: {err}")).to_string()
    })?;
    let manifest_sha256 = hex_sha256(&manifest_bytes);

    Ok(TalosBackupResult {
        endpoint,
        node_address: node,
        command,
        output: format!(
            "offline Protocore backup exported: {archive_abs} ({archive_size_bytes} bytes)"
        ),
        archive_path: archive_abs,
        archive_sha256,
        archive_size_bytes,
        manifest_path: manifest_abs,
        manifest_sha256,
        source_path: PROTOCORE_DATA_DIR.to_string(),
        service: Some(service),
    })
}

#[tauri::command]
pub async fn talos_operator_seal_ek(
    state: State<'_, TalosState>,
) -> Result<TalosOperatorSealEkResult, String> {
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let archive = read_talos_copy_archive(&endpoint, &config_path, PROTOCORE_OPERATOR_SEAL_EK_PATH)
        .await
        .map_err(|e| e.to_string())?;
    let raw = extract_talos_copy_file(&archive, PROTOCORE_OPERATOR_SEAL_EK_PATH)
        .map_err(|e| e.to_string())?;
    let (seal_ek_hex, sha256) = normalize_operator_seal_ek(&raw).map_err(|e| e.to_string())?;
    let node = node_address(&endpoint);

    Ok(TalosOperatorSealEkResult {
        endpoint: endpoint.clone(),
        node_address: node,
        command: format!("talos copy {PROTOCORE_OPERATOR_SEAL_EK_PATH}"),
        path: PROTOCORE_OPERATOR_SEAL_EK_PATH.to_string(),
        seal_ek_hex,
        sha256,
    })
}

#[tauri::command]
pub async fn talos_upgrade(
    state: State<'_, TalosState>,
    image: String,
    stage: bool,
    reboot_mode: String,
) -> Result<TalosTextResult, String> {
    let image = validate_upgrade_image(&image).map_err(|e| e.to_string())?;
    let reboot_mode = parse_reboot_mode(&reboot_mode).map_err(|e| e.to_string())?;
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let control_plane =
        build_config_info(Some(&endpoint), &config_path).map_err(|e| e.to_string())?;
    enforce_privileged_control_plane(&control_plane).map_err(|e| e.to_string())?;
    let mut client = machine_client(&endpoint, &config_path)
        .await
        .map_err(|e| e.to_string())?;

    let reboot_mode_value = match reboot_mode {
        TalosRebootMode::Default => machine::upgrade_request::RebootMode::Default as i32,
        TalosRebootMode::Powercycle => machine::upgrade_request::RebootMode::Powercycle as i32,
    };

    let stage_arg = if stage { " --stage" } else { "" };
    let reboot_arg = match reboot_mode {
        TalosRebootMode::Default => "",
        TalosRebootMode::Powercycle => " --reboot-mode powercycle",
    };
    let command = format!("talos upgrade --image {image} --preserve{stage_arg}{reboot_arg}");

    // The gRPC channel is already established (`machine_client` connected), so
    // the node WAS reachable when we sent this request. A Talos image upgrade
    // then reboots the node — so the connection legitimately drops as the box
    // restarts into the new image. The output we hand back distinguishes:
    //   * clean `UpgradeResponse`        -> accepted, formatted as usual.
    //   * post-dispatch transport drop   -> dispatched, node rebooting (marker).
    //   * outer timeout after dispatch   -> dispatched, node rebooting (marker).
    // A `--stage`d upgrade does NOT reboot, so its errors are reported verbatim.
    let output = match timeout(
        TALOS_TIMEOUT,
        client.upgrade(machine::UpgradeRequest {
            image: image.clone(),
            preserve: true,
            stage,
            force: false,
            reboot_mode: reboot_mode_value,
        }),
    )
    .await
    {
        // The node acknowledged the upgrade before rebooting — clean success.
        Ok(Ok(response)) => format_upgrade_response(response.into_inner()),
        // The node answered with a gRPC error. If we staged (no reboot), that is
        // a genuine failure. Otherwise a transport-class drop is the reboot.
        Ok(Err(status)) => {
            if !stage && is_post_dispatch_reboot_drop(&status) {
                format!(
                    "{UPGRADE_REBOOTING_MARKER}\n(control connection dropped: {})",
                    status.message()
                )
            } else {
                return Err(TalosError::from(status).to_string());
            }
        }
        // The call timed out. After a successful connect+dispatch, a non-staged
        // upgrade timing out means the node went away mid-reboot, not unreachable.
        Err(_) => {
            if stage {
                return Err(TalosError::Timeout.to_string());
            }
            UPGRADE_REBOOTING_MARKER.to_string()
        }
    };

    Ok(TalosTextResult {
        node_address: node_address(&endpoint),
        endpoint,
        command,
        output,
        service: None,
    })
}

/// One-time etcd bootstrap for a freshly-provisioned single controlplane node —
/// the in-app equivalent of `talosctl bootstrap`. The maintenance-mode install
/// path produces a controlplane that wedges in "Booting" waiting for etcd; until
/// the machine reaches "ready", extension services (including `ext-protocore`)
/// never start and `:8545` never serves. Retries through the post-install reboot
/// until the node's secured API answers, then bootstraps. An already-bootstrapped
/// node is idempotent success.
#[tauri::command]
pub async fn talos_bootstrap(host: String, talosconfig_path: String) -> Result<String, String> {
    let endpoint = endpoint_url(&host).map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
    let mut last_err = String::from("node did not answer its secured API");
    loop {
        if let Ok(mut client) = machine_client(&endpoint, &talosconfig_path).await {
            match timeout(
                TALOS_TIMEOUT,
                client.bootstrap(machine::BootstrapRequest {
                    recover_etcd: false,
                    recover_skip_hash_check: false,
                }),
            )
            .await
            {
                Ok(Ok(_)) => return Ok("etcd bootstrap requested".to_string()),
                Ok(Err(status)) => {
                    let m = status.message().to_ascii_lowercase();
                    if m.contains("already")
                        || m.contains("not empty")
                        || m.contains("data directory")
                    {
                        return Ok("node already bootstrapped".to_string());
                    }
                    last_err = status.message().to_string();
                }
                Err(_) => last_err = "bootstrap call timed out".to_string(),
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "etcd bootstrap did not complete within the reboot window: {last_err}"
            ));
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

#[tauri::command]
pub async fn talos_rollback(state: State<'_, TalosState>) -> Result<TalosTextResult, String> {
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let control_plane =
        build_config_info(Some(&endpoint), &config_path).map_err(|e| e.to_string())?;
    enforce_privileged_control_plane(&control_plane).map_err(|e| e.to_string())?;
    let mut client = machine_client(&endpoint, &config_path)
        .await
        .map_err(|e| e.to_string())?;
    let response = timeout(TALOS_TIMEOUT, client.rollback(machine::RollbackRequest {}))
        .await
        .map_err(|_| TalosError::Timeout.to_string())?
        .map_err(|e| e.to_string())?
        .into_inner();

    Ok(TalosTextResult {
        node_address: node_address(&endpoint),
        endpoint,
        command: "talos rollback".to_string(),
        output: format_rollback_response(response),
        service: None,
    })
}

/// Wipe the node's `EPHEMERAL` partition and reboot — an in-place
/// re-provision. `EPHEMERAL` (`/var`) holds `/var/lib/protocore` (the chain DB,
/// the resolved `genesis.toml`, and `config.toml`); the `STATE` partition that
/// carries the Talos machine config is left intact, so the node reboots,
/// re-applies its existing config, and the protocore entrypoint runs its
/// first-boot path again (genesis + cold-start fast-sync seeds re-resolved from
/// the chain-registry, fresh DB → fast-sync fires). This is the recovery for a
/// node wedged off the chain head — e.g. an operator stuck behind its own
/// proposer anchor (M3-L-14), or a node whose `[fast_sync]` seeds never landed
/// in config so fast-sync never fired and it dag-syncs from round 0 forever.
/// `graceful=false` because a single self-hosted node has no peer to hand etcd
/// to; `reboot=true` so it comes back on its own.
#[tauri::command]
pub async fn talos_wipe_protocore(state: State<'_, TalosState>) -> Result<TalosTextResult, String> {
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let control_plane =
        build_config_info(Some(&endpoint), &config_path).map_err(|e| e.to_string())?;
    enforce_privileged_control_plane(&control_plane).map_err(|e| e.to_string())?;
    let mut client = machine_client(&endpoint, &config_path)
        .await
        .map_err(|e| e.to_string())?;

    let response = timeout(
        TALOS_TIMEOUT,
        client.reset(machine::ResetRequest {
            graceful: false,
            reboot: true,
            // Wipe only EPHEMERAL (/var, holds /var/lib/protocore). Leaving
            // system_partitions_to_wipe empty would erase EVERY partition —
            // including STATE (the machine config) — turning this into a full
            // reinstall instead of a data re-provision.
            system_partitions_to_wipe: vec![machine::ResetPartitionSpec {
                label: "EPHEMERAL".to_string(),
                wipe: true,
            }],
            user_disks_to_wipe: vec![],
            mode: machine::reset_request::WipeMode::SystemDisk as i32,
        }),
    )
    .await
    .map_err(|_| TalosError::Timeout.to_string())?
    .map_err(|e| e.to_string())?
    .into_inner();

    Ok(TalosTextResult {
        node_address: node_address(&endpoint),
        endpoint,
        command: "talos reset --graceful=false --reboot --system-labels-to-wipe EPHEMERAL"
            .to_string(),
        output: format_reset_response(response),
        service: None,
    })
}

#[tauri::command]
pub async fn talos_service_action(
    state: State<'_, TalosState>,
    service: String,
    action: String,
) -> Result<TalosTextResult, String> {
    let service = validate_service_name(&service).map_err(|e| e.to_string())?;
    let action = parse_service_action(&action).map_err(|e| e.to_string())?;
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let control_plane =
        build_config_info(Some(&endpoint), &config_path).map_err(|e| e.to_string())?;
    enforce_privileged_control_plane(&control_plane).map_err(|e| e.to_string())?;
    let mut client = machine_client(&endpoint, &config_path)
        .await
        .map_err(|e| e.to_string())?;

    let action_name = match action {
        ServiceAction::Start => "start",
        ServiceAction::Stop => "stop",
        ServiceAction::Restart => "restart",
    };

    let output = match action {
        ServiceAction::Start => {
            let response = timeout(
                TALOS_TIMEOUT,
                client.service_start(machine::ServiceStartRequest {
                    id: service.clone(),
                }),
            )
            .await
            .map_err(|_| TalosError::Timeout.to_string())?
            .map_err(|e| e.to_string())?
            .into_inner();
            response
                .messages
                .into_iter()
                .map(|msg| msg.resp)
                .collect::<Vec<_>>()
                .join("\n")
        }
        ServiceAction::Stop => {
            let response = timeout(
                TALOS_TIMEOUT,
                client.service_stop(machine::ServiceStopRequest {
                    id: service.clone(),
                }),
            )
            .await
            .map_err(|_| TalosError::Timeout.to_string())?
            .map_err(|e| e.to_string())?
            .into_inner();
            response
                .messages
                .into_iter()
                .map(|msg| msg.resp)
                .collect::<Vec<_>>()
                .join("\n")
        }
        ServiceAction::Restart => {
            let response = timeout(
                TALOS_TIMEOUT,
                client.service_restart(machine::ServiceRestartRequest {
                    id: service.clone(),
                }),
            )
            .await
            .map_err(|_| TalosError::Timeout.to_string())?
            .map_err(|e| e.to_string())?
            .into_inner();
            response
                .messages
                .into_iter()
                .map(|msg| msg.resp)
                .collect::<Vec<_>>()
                .join("\n")
        }
    };

    let service_info = fetch_service(&endpoint, &config_path, &service)
        .await
        .ok()
        .flatten();

    Ok(TalosTextResult {
        node_address: node_address(&endpoint),
        endpoint,
        command: format!("talos service {service} {action_name}"),
        output: if output.trim().is_empty() {
            format!("{service} {action_name} submitted")
        } else {
            output
        },
        service: service_info,
    })
}

#[tauri::command]
pub async fn talos_logs(
    state: State<'_, TalosState>,
    service: String,
    lines: Option<u32>,
) -> Result<TalosTextResult, String> {
    let service = validate_service_name(&service).map_err(|e| e.to_string())?;
    let line_count = lines.unwrap_or(200).clamp(1, 5000) as i32;
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let mut client = machine_client(&endpoint, &config_path)
        .await
        .map_err(|e| e.to_string())?;

    let log_bytes = timeout(TALOS_TIMEOUT, async {
        let response = client
            .logs(talos_logs_request(service.clone(), false, line_count))
            .await?;
        let mut stream = response.into_inner();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            bytes.extend(chunk?.bytes);
        }
        Ok::<Vec<u8>, talos_rust_client::tonic::Status>(bytes)
    })
    .await
    .map_err(|_| TalosError::Timeout.to_string())?
    .map_err(|e| e.to_string())?;

    Ok(TalosTextResult {
        node_address: node_address(&endpoint),
        endpoint,
        command: format!("talos logs {service} --tail {line_count}"),
        output: String::from_utf8_lossy(&log_bytes).to_string(),
        service: None,
    })
}

#[tauri::command]
pub async fn talos_log_stream(
    app: AppHandle,
    state: State<'_, TalosState>,
    service: String,
    lines: Option<u32>,
    session_id: Option<u64>,
) -> Result<u64, String> {
    let service = validate_service_name(&service).map_err(|e| e.to_string())?;
    let line_count = lines.unwrap_or(200).clamp(1, 5000) as i32;
    if let Some(session_id) = session_id.filter(|id| *id > 0) {
        let guard = state.lock().await;
        if guard.log_streams.contains_key(&session_id) {
            return Err(format!("Talos log stream id {session_id} already exists"));
        }
    }
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let mut client = machine_client(&endpoint, &config_path)
        .await
        .map_err(|e| e.to_string())?;

    let response = timeout(
        TALOS_TIMEOUT,
        client.logs(talos_logs_request(service.clone(), true, line_count)),
    )
    .await
    .map_err(|_| TalosError::Timeout.to_string())?
    .map_err(|e| e.to_string())?;

    let session_id = if let Some(session_id) = session_id.filter(|id| *id > 0) {
        session_id
    } else {
        let mut guard = state.lock().await;
        let session_id = guard.next_session_id;
        guard.next_session_id += 1;
        session_id
    };

    let event_channel = format!("monarch://talos-log/{session_id}");
    let end_channel = format!("monarch://talos-log/{session_id}/end");
    let error_channel = format!("monarch://talos-log/{session_id}/error");
    let app_for_task = app.clone();
    let mut stream = response.into_inner();
    let abort = tokio::spawn(async move {
        let mut buffer = TalosLineBuffer::default();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(data) => {
                    for line in buffer.feed(&data.bytes) {
                        let _ = app_for_task.emit(&event_channel, line);
                    }
                }
                Err(err) => {
                    let _ = app_for_task.emit(&error_channel, err.to_string());
                    break;
                }
            }
        }
        if let Some(line) = buffer.flush() {
            let _ = app_for_task.emit(&event_channel, line);
        }
        let _ = app_for_task.emit(&end_channel, "stream-closed");
    });

    let mut guard = state.lock().await;
    if guard.log_streams.contains_key(&session_id) {
        abort.abort();
        return Err(format!("Talos log stream id {session_id} already exists"));
    }
    guard
        .log_streams
        .insert(session_id, TalosLogStreamHandle { session_id, abort });

    Ok(session_id)
}

#[tauri::command]
pub async fn talos_log_cancel(state: State<'_, TalosState>, session_id: u64) -> Result<(), String> {
    let mut guard = state.lock().await;
    if let Some(handle) = guard.log_streams.remove(&session_id) {
        handle.abort.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn talos_protocore_restart(
    state: State<'_, TalosState>,
) -> Result<TalosTextResult, String> {
    talos_service_action(state, DEFAULT_SERVICE_ID.to_string(), "restart".to_string()).await
}

/// Read the disk usage of the protocore log directory
/// (`/var/lib/protocore/logs`) via the Talos `DiskUsage` + `List` RPCs.
///
/// PURE READ. The `append:` redirect that protocore's extension unit uses for
/// stdout/stderr never rotates, so this file grows unbounded; this command lets
/// the Logs view show the real size and per-file breakdown so an operator can
/// see when it has ballooned (it reached 10GB on the live fleet). Every number
/// is the node's own — nothing is synthesised.
#[tauri::command]
pub async fn talos_log_disk_usage(
    state: State<'_, TalosState>,
) -> Result<TalosLogDiskUsage, String> {
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let mut client = machine_client(&endpoint, &config_path)
        .await
        .map_err(|e| e.to_string())?;

    // `du` for the directory total. recursion_depth=0 == no limit; all=true so
    // regular files (not just directories) are summed.
    let total_bytes = timeout(TALOS_TIMEOUT, async {
        let response = client
            .disk_usage(machine::DiskUsageRequest {
                recursion_depth: 0,
                all: true,
                threshold: 0,
                paths: vec![PROTOCORE_LOG_DIR.to_string()],
            })
            .await?;
        let mut stream = response.into_inner();
        // The directory's own entry (relative_name "." / name == the dir) carries
        // the aggregate; take the largest reported size as the total, ignoring
        // per-file rows that also stream through.
        let mut total: i64 = 0;
        while let Some(item) = stream.next().await {
            let info = item?;
            if !info.error.is_empty() {
                continue;
            }
            let is_dir_entry =
                info.relative_name == "." || info.name.trim_end_matches('/') == PROTOCORE_LOG_DIR;
            if is_dir_entry {
                total = total.max(info.size);
            }
        }
        Ok::<i64, talos_rust_client::tonic::Status>(total)
    })
    .await
    .map_err(|_| TalosError::Timeout.to_string())?
    .map_err(|e| e.to_string())?;

    // Per-file breakdown (regular files only) via `List`.
    let files = timeout(TALOS_TIMEOUT, async {
        let response = client
            .list(machine::ListRequest {
                root: PROTOCORE_LOG_DIR.to_string(),
                recurse: false,
                recursion_depth: 1,
                types: vec![machine::list_request::Type::Regular as i32],
                report_xattrs: false,
            })
            .await?;
        let mut stream = response.into_inner();
        let mut out: Vec<TalosLogFile> = Vec::new();
        while let Some(item) = stream.next().await {
            let info = item?;
            if info.is_dir || !info.error.is_empty() {
                continue;
            }
            let name = if info.relative_name.is_empty() {
                info.name.clone()
            } else {
                info.relative_name.clone()
            };
            if name.is_empty() || name == "." {
                continue;
            }
            out.push(TalosLogFile {
                name,
                size: info.size,
                modified: if info.modified > 0 {
                    Some(info.modified)
                } else {
                    None
                },
            });
        }
        Ok::<Vec<TalosLogFile>, talos_rust_client::tonic::Status>(out)
    })
    .await
    .map_err(|_| TalosError::Timeout.to_string())?
    .map_err(|e| e.to_string())?;

    // Largest file first — the operator cares about the biggest offender.
    let mut files = files;
    files.sort_by_key(|f| std::cmp::Reverse(f.size));

    // Fall back to summing the per-file rows if the directory aggregate did not
    // come through (some Talos builds omit the dir entry from `du`).
    let total_bytes = if total_bytes > 0 {
        total_bytes
    } else {
        files.iter().map(|f| f.size).sum()
    };

    Ok(TalosLogDiskUsage {
        node_address: node_address(&endpoint),
        endpoint,
        path: PROTOCORE_LOG_DIR.to_string(),
        total_bytes,
        files,
    })
}

/// Sum the bytes under `path` via the Talos `DiskUsage` (`du`) RPC. Returns the
/// directory aggregate when the node emits the dir entry, else the sum of the
/// per-file rows it streamed. PURE READ.
async fn disk_usage_total(
    client: &mut MachineServiceClient<talos_rust_client::Channel>,
    path: &str,
) -> Result<i64, TalosError> {
    timeout(TALOS_TIMEOUT, async {
        let response = client
            .disk_usage(machine::DiskUsageRequest {
                recursion_depth: 0,
                all: true,
                threshold: 0,
                paths: vec![path.to_string()],
            })
            .await?;
        let mut stream = response.into_inner();
        let mut dir_total: i64 = 0;
        let mut file_sum: i64 = 0;
        while let Some(item) = stream.next().await {
            let info = item?;
            if !info.error.is_empty() {
                continue;
            }
            let is_dir_entry =
                info.relative_name == "." || info.name.trim_end_matches('/') == path;
            if is_dir_entry {
                dir_total = dir_total.max(info.size);
            } else {
                file_sum += info.size;
            }
        }
        Ok::<i64, talos_rust_client::tonic::Status>(if dir_total > 0 { dir_total } else { file_sum })
    })
    .await
    .map_err(|_| TalosError::Timeout)?
    .map_err(TalosError::from)
}

/// READ-ONLY size of the protocore DATA directory (`/var/lib/protocore`) via the
/// Talos `DiskUsage` (`du`) RPC. Pure read — issues no state-changing call. The
/// Hardware view divides this by the node's uptime for an immediate disk-growth
/// pace so the "full in ~N days" projection has something to show before the
/// local time-series has accrued enough points.
#[tauri::command]
pub async fn talos_data_dir_usage(
    state: State<'_, TalosState>,
) -> Result<TalosDataDirUsage, String> {
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let mut client = machine_client(&endpoint, &config_path)
        .await
        .map_err(|e| e.to_string())?;
    let total_bytes = disk_usage_total(&mut client, PROTOCORE_DATA_DIR)
        .await
        .map_err(|e| e.to_string())?;
    Ok(TalosDataDirUsage {
        node_address: node_address(&endpoint),
        endpoint,
        path: PROTOCORE_DATA_DIR.to_string(),
        total_bytes,
    })
}

// Where Talos persists the node's machine configuration. `ApplyConfiguration`
// replaces this document set wholesale, so a retention change must re-apply the
// COMPLETE config (v1alpha1 `Config` + the `ExtensionServiceConfig` doc), not a
// bare partial — Talos rejects a partial full-apply with "the applied machine
// configuration doesn't contain v1alpha1 config, did you mean to patch the
// machine config instead?".
const TALOS_MACHINE_CONFIG_PATH: &str = "/system/state/config.yaml";

/// Validate the operator-supplied retention bound and return the two env entries
/// (`PROTOCORE_LOG_MAX_BYTES` / `PROTOCORE_LOG_MAX_FILES`) plus the byte bound.
/// `max_megabytes` caps the log size and `max_files` caps the rotated-file
/// count; both must be sane. These entries are merged into the node's existing
/// `ExtensionServiceConfig` document by `merge_log_retention_into_config`.
fn build_log_retention_env(
    max_megabytes: u32,
    max_files: u32,
) -> Result<(u64, u32, u64), TalosError> {
    if max_megabytes == 0 {
        return Err(TalosError::InvalidLogRetention(
            "max size must be at least 1 MB".to_string(),
        ));
    }
    if max_megabytes > 1_048_576 {
        return Err(TalosError::InvalidLogRetention(
            "max size must be 1 TB or less".to_string(),
        ));
    }
    if max_files == 0 || max_files > 64 {
        return Err(TalosError::InvalidLogRetention(
            "rotated file count must be between 1 and 64".to_string(),
        ));
    }
    let max_bytes = max_megabytes as u64 * 1_048_576;
    Ok((max_bytes, max_files, max_bytes))
}

/// Result of merging the retention bound into a node's machine config.
struct LogRetentionMerge {
    /// The COMPLETE machine config (multi-document YAML) to re-apply.
    config: String,
    /// The byte bound recorded (`PROTOCORE_LOG_MAX_BYTES`).
    max_bytes: u64,
    /// The rotated-file cap recorded (`PROTOCORE_LOG_MAX_FILES`).
    max_files: u32,
}

/// Merge the protocore log-retention env (`PROTOCORE_LOG_MAX_BYTES` /
/// `PROTOCORE_LOG_MAX_FILES`) into the node's CURRENT machine config and return
/// the COMPLETE multi-document config to re-apply.
///
/// Why a full merge-and-reapply instead of a bare partial apply: Talos's
/// `ApplyConfiguration` replaces the whole config document set. Applying just an
/// `ExtensionServiceConfig` document is rejected ("the applied machine
/// configuration doesn't contain v1alpha1 config, did you mean to patch the
/// machine config instead?") because a full apply must carry the v1alpha1
/// `Config` document. So we read the node's persisted config, set the two env
/// keys inside the EXISTING `protocore` `ExtensionServiceConfig` document
/// (preserving every other document, key, and comment byte-for-byte), and hand
/// back the complete config. If the config has no `protocore`
/// `ExtensionServiceConfig` document yet, one is appended as a new document so
/// the result still carries the original v1alpha1 `Config`.
///
/// The edit is deliberately line-scoped rather than a YAML round-trip: the Talos
/// machine config embeds PEM certs and ordered fields that a parse/re-emit cycle
/// would reorder or reflow, so we touch only the protocore environment list.
fn merge_log_retention_into_config(
    current: &str,
    max_megabytes: u32,
    max_files: u32,
) -> Result<LogRetentionMerge, TalosError> {
    let (max_bytes, max_files, _) = build_log_retention_env(max_megabytes, max_files)?;
    if current.trim().is_empty() {
        return Err(TalosError::InvalidLogRetention(
            "node returned an empty machine configuration".to_string(),
        ));
    }
    // A valid Talos config to full-apply must carry the v1alpha1 Config document.
    if !current.contains("version: v1alpha1") {
        return Err(TalosError::InvalidLogRetention(
            "node machine configuration is missing its v1alpha1 config document".to_string(),
        ));
    }

    // Split into documents on `---` separators (column 0), preserving each
    // document's exact bytes. Find the `protocore` ExtensionServiceConfig doc.
    let documents: Vec<&str> = split_yaml_documents(current);
    let mut rebuilt: Vec<String> = Vec::with_capacity(documents.len() + 1);
    let mut patched = false;
    for doc in &documents {
        if !patched && is_protocore_extension_service_config(doc) {
            rebuilt.push(set_retention_env_in_extension_doc(doc, max_bytes, max_files));
            patched = true;
        } else {
            rebuilt.push((*doc).to_string());
        }
    }

    if !patched {
        // No protocore ExtensionServiceConfig yet — append a fresh document. The
        // original v1alpha1 Config is preserved as document 0, so the full apply
        // is still valid.
        rebuilt.push(format!(
            "apiVersion: v1alpha1\n\
             kind: ExtensionServiceConfig\n\
             name: protocore\n\
             environment:\n\
             \x20\x20- PROTOCORE_LOG_MAX_BYTES={max_bytes}\n\
             \x20\x20- PROTOCORE_LOG_MAX_FILES={max_files}\n"
        ));
    }

    let config = rebuilt.join("---\n");
    Ok(LogRetentionMerge {
        config,
        max_bytes,
        max_files,
    })
}

/// Split a multi-document YAML string on `---` document separators that sit at
/// column 0 (their own line), keeping each document's bytes intact. A leading
/// `---` is treated as an empty preamble and dropped from the document list.
fn split_yaml_documents(text: &str) -> Vec<&str> {
    let mut docs = Vec::new();
    let mut start = 0usize;
    let bytes = text.as_bytes();
    let mut idx = 0usize;
    // Walk line by line; a line equal to "---" (optionally with trailing CR /
    // spaces) starts a new document.
    while idx <= bytes.len() {
        let line_end = match text[idx..].find('\n') {
            Some(off) => idx + off,
            None => bytes.len(),
        };
        let line = text[idx..line_end].trim_end_matches('\r').trim_end();
        if line == "---" {
            docs.push(&text[start..idx]);
            start = (line_end + 1).min(bytes.len());
        }
        if line_end >= bytes.len() {
            break;
        }
        idx = line_end + 1;
    }
    docs.push(&text[start..]);
    // Drop an empty leading preamble (when the config begins with `---`).
    docs.into_iter()
        .filter(|doc| !doc.trim().is_empty())
        .collect()
}

/// True when a single YAML document is the protocore `ExtensionServiceConfig`.
fn is_protocore_extension_service_config(doc: &str) -> bool {
    let mut is_ext = false;
    let mut is_protocore = false;
    for line in doc.lines() {
        let t = line.trim();
        if t == "kind: ExtensionServiceConfig" {
            is_ext = true;
        } else if t == "name: protocore" {
            is_protocore = true;
        }
    }
    is_ext && is_protocore
}

/// Set `PROTOCORE_LOG_MAX_BYTES` / `PROTOCORE_LOG_MAX_FILES` inside the
/// `environment:` list of a protocore `ExtensionServiceConfig` document,
/// replacing any existing entries for those keys in place (so re-applying is
/// idempotent) and appending the missing ones. Every other line is preserved.
fn set_retention_env_in_extension_doc(doc: &str, max_bytes: u64, max_files: u32) -> String {
    let bytes_line = format!("PROTOCORE_LOG_MAX_BYTES={max_bytes}");
    let files_line = format!("PROTOCORE_LOG_MAX_FILES={max_files}");

    let mut out: Vec<String> = Vec::with_capacity(doc.lines().count() + 4);
    let mut in_environment = false;
    let mut env_indent = String::new();
    let mut item_indent: Option<String> = None;
    let mut wrote_bytes = false;
    let mut wrote_files = false;

    // Emit any retention keys not yet written, using the list-item indent we
    // observed (or two spaces past the `environment:` key when the list is
    // empty).
    let flush_missing =
        |out: &mut Vec<String>, item_indent: &str, wrote_bytes: bool, wrote_files: bool| {
            if !wrote_bytes {
                out.push(format!("{item_indent}- {bytes_line}"));
            }
            if !wrote_files {
                out.push(format!("{item_indent}- {files_line}"));
            }
        };

    for line in doc.split('\n') {
        let trimmed = line.trim();
        let indent: String = line.chars().take_while(|c| *c == ' ').collect();

        if !in_environment {
            if trimmed == "environment:" {
                in_environment = true;
                env_indent = indent.clone();
            }
            out.push(line.to_string());
            continue;
        }

        // Inside the environment block. A list item is more-indented than the
        // `environment:` key and starts with `-`.
        let is_list_item = indent.len() > env_indent.len() && trimmed.starts_with('-');
        if is_list_item {
            if item_indent.is_none() {
                item_indent = Some(indent.clone());
            }
            let value = trimmed.trim_start_matches('-').trim();
            if value.starts_with("PROTOCORE_LOG_MAX_BYTES=") {
                out.push(format!("{indent}- {bytes_line}"));
                wrote_bytes = true;
            } else if value.starts_with("PROTOCORE_LOG_MAX_FILES=") {
                out.push(format!("{indent}- {files_line}"));
                wrote_files = true;
            } else {
                out.push(line.to_string());
            }
            continue;
        }

        // First line that is NOT part of the environment list ends the block:
        // append any retention keys we have not yet written, then emit it.
        let resolved = item_indent
            .clone()
            .unwrap_or_else(|| format!("{env_indent}  "));
        flush_missing(&mut out, &resolved, wrote_bytes, wrote_files);
        wrote_bytes = true;
        wrote_files = true;
        in_environment = false;
        out.push(line.to_string());
    }

    // The environment block ran to the end of the document.
    if in_environment {
        let resolved = item_indent.unwrap_or_else(|| format!("{env_indent}  "));
        flush_missing(&mut out, &resolved, wrote_bytes, wrote_files);
    }

    out.join("\n")
}

/// Strip the seat-preserving recovery mnemonic out of a node's persisted
/// machine config (#7 part a).
///
/// After a seat-preserving recovery the operator's 24-word PLAINTEXT mnemonic
/// lingers in the node's STATE config (`/system/state/config.yaml`): the
/// `machine.files` block staged it (the protocore entrypoint securely deletes
/// only the on-node FILE, never the STATE copy) and the protocore extension
/// `PROTOCORE_OPERATOR_MNEMONIC_FILE` env still points at it. This reads the
/// CURRENT config and removes EXACTLY those two recovery additions, leaving
/// every other byte (PKI, certs, the talosconfig validity) untouched — the same
/// read→line-scoped-edit→re-apply shape `merge_log_retention_into_config` uses,
/// so re-applying does NOT re-mint a CA / invalidate the talosconfig.
///
/// Returns `None` when neither the recovery `machine.files` block NOR the env is
/// present (already scrubbed / non-recovery node) so the caller can skip the
/// apply (idempotent / no-op).
///
/// The `machine.files` removal is ANCHORED to `RECOVERY_MNEMONIC_PATH`: only a
/// `files:` block whose item carries that exact `path:` is dropped, so an
/// UNRELATED operator-authored `machine.files` block is never collaterally
/// removed.
fn strip_recovery_mnemonic_from_config(current: &str) -> Option<String> {
    if current.trim().is_empty() {
        return None;
    }
    let recovery_path = crate::provision::RECOVERY_MNEMONIC_PATH;
    let recovery_env = crate::provision::RECOVERY_MNEMONIC_ENV;
    let env_line = format!("- {recovery_env}={recovery_path}");
    let path_line = format!("path: {recovery_path}");

    let documents: Vec<&str> = split_yaml_documents(current);
    let mut rebuilt: Vec<String> = Vec::with_capacity(documents.len());
    let mut removed_files = false;
    let mut removed_env = false;

    for doc in &documents {
        let lines: Vec<&str> = doc.split('\n').collect();
        let mut out_lines: Vec<&str> = Vec::with_capacity(lines.len());
        let mut idx = 0usize;
        while idx < lines.len() {
            let line = lines[idx];
            let trimmed = line.trim();

            // A `files:` block (any indentation) whose item targets the recovery
            // path is the staged-mnemonic block. Drop the `files:` line and every
            // more-indented child line until indentation returns to the `files:`
            // key's level (or shallower).
            if trimmed == "files:" {
                let files_indent = indent_width(line);
                let mut j = idx + 1;
                while j < lines.len() {
                    let child = lines[j];
                    if !child.trim().is_empty() && indent_width(child) <= files_indent {
                        break;
                    }
                    j += 1;
                }
                let block_targets_recovery =
                    lines[idx..j].iter().any(|l| l.trim() == path_line);
                if block_targets_recovery {
                    removed_files = true;
                    idx = j;
                    continue;
                }
                out_lines.push(line);
                idx += 1;
                continue;
            }

            // The protocore extension env entry pointing at the recovery file.
            if trimmed == env_line {
                removed_env = true;
                idx += 1;
                continue;
            }

            out_lines.push(line);
            idx += 1;
        }
        rebuilt.push(out_lines.join("\n"));
    }

    if !removed_files && !removed_env {
        return None;
    }
    Some(rebuilt.join("---\n"))
}

/// Leading-space count for a line (block-indent depth).
fn indent_width(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ').count()
}

/// Read the node's persisted machine configuration (`/system/state/config.yaml`)
/// over the Talos `Read` RPC and return it as a UTF-8 string. This is the
/// current COMPLETE config (v1alpha1 `Config` + any extra documents) that a
/// `merge`-then-`ApplyConfiguration` re-applies.
async fn read_machine_config(
    client: &mut MachineServiceClient<talos_rust_client::Channel>,
) -> Result<String, TalosError> {
    let bytes = timeout(TALOS_TIMEOUT, async {
        let response = client
            .read(machine::ReadRequest {
                path: TALOS_MACHINE_CONFIG_PATH.to_string(),
            })
            .await?;
        let mut stream = response.into_inner();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            bytes.extend(chunk?.bytes);
        }
        Ok::<Vec<u8>, talos_rust_client::tonic::Status>(bytes)
    })
    .await
    .map_err(|_| TalosError::Timeout)?
    .map_err(|e| {
        TalosError::Config(format!(
            "could not read machine config at {TALOS_MACHINE_CONFIG_PATH}: {}",
            e.message()
        ))
    })?;
    String::from_utf8(bytes)
        .map_err(|e| TalosError::Config(format!("machine config is not valid UTF-8: {e}")))
}

/// Install / refresh the protocore log retention policy on a running node.
///
/// Talos is immutable — you cannot edit a unit file in place — so retention is
/// set the Talos-blessed way. `ApplyConfiguration` replaces the node's WHOLE
/// config document set, and a full apply must carry the v1alpha1 `Config`
/// document, so we cannot send a bare `ExtensionServiceConfig` (Talos rejects
/// that with "the applied machine configuration doesn't contain v1alpha1
/// config, did you mean to patch the machine config instead?"). Instead we read
/// the node's current config, set `PROTOCORE_LOG_MAX_BYTES` /
/// `PROTOCORE_LOG_MAX_FILES` inside its existing protocore
/// `ExtensionServiceConfig` document (preserving every other document and key),
/// and re-apply the COMPLETE merged config with `NoReboot` so the node does not
/// cycle. The node's own apply warnings/messages are returned verbatim (real
/// success/failure), and `talos_clean_protocore_logs` restarts ext-protocore so
/// the new bound takes effect on the running process. HONEST: this records the
/// retention bound at the config layer; the extension's log writer enforces the
/// actual rotation.
#[tauri::command]
pub async fn talos_set_log_retention(
    state: State<'_, TalosState>,
    max_megabytes: u32,
    max_files: u32,
    dry_run: Option<bool>,
) -> Result<TalosTextResult, String> {
    // Validate the bound up front so a bad request never touches the node.
    build_log_retention_env(max_megabytes, max_files).map_err(|e| e.to_string())?;
    let dry_run = dry_run.unwrap_or(false);

    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let control_plane =
        build_config_info(Some(&endpoint), &config_path).map_err(|e| e.to_string())?;
    enforce_privileged_control_plane(&control_plane).map_err(|e| e.to_string())?;
    let mut client = machine_client(&endpoint, &config_path)
        .await
        .map_err(|e| e.to_string())?;

    // Read the node's CURRENT machine config and merge the retention bound into
    // its existing protocore ExtensionServiceConfig document — the apply below
    // ships the complete config, not a partial.
    let current = read_machine_config(&mut client)
        .await
        .map_err(|e| e.to_string())?;
    let merged = merge_log_retention_into_config(&current, max_megabytes, max_files)
        .map_err(|e| e.to_string())?;
    let max_bytes = merged.max_bytes;
    let max_files = merged.max_files;

    let response = timeout(
        TALOS_TIMEOUT,
        client.apply_configuration(machine::ApplyConfigurationRequest {
            data: merged.config.into_bytes(),
            // NoReboot — a retention patch must not cycle the node.
            mode: machine::apply_configuration_request::Mode::NoReboot as i32,
            dry_run,
            try_mode_timeout: None,
        }),
    )
    .await
    .map_err(|_| TalosError::Timeout.to_string())?
    .map_err(|e| format!("apply rejected: {}", e.message()))?
    .into_inner();

    let messages = response
        .messages
        .into_iter()
        .flat_map(|m| {
            let mut lines = Vec::new();
            if !m.mode_details.is_empty() {
                lines.push(m.mode_details);
            }
            lines.extend(m.warnings);
            lines
        })
        .collect::<Vec<_>>()
        .join("\n");

    let run_label = if dry_run { "dry-run" } else { "commit" };
    let output = if messages.trim().is_empty() {
        format!(
            "Retention patch applied ({run_label}): PROTOCORE_LOG_MAX_BYTES={max_bytes}, \
             PROTOCORE_LOG_MAX_FILES={max_files}. Restart ext-protocore for the bound to take effect."
        )
    } else {
        messages
    };

    Ok(TalosTextResult {
        node_address: node_address(&endpoint),
        endpoint,
        command: format!("talos apply-config --mode no-reboot ({run_label})"),
        output,
        service: None,
    })
}

/// Apply (or refresh) the log retention bound and restart ext-protocore so the
/// growing append target is re-opened under the new policy.
///
/// HONEST NOTE: Talos exposes no file-truncate RPC, and the EPHEMERAL `reset`
/// that would reclaim the bytes also nukes the chain DB, so this does NOT zero
/// the existing file by itself. What it does is real: it records the retention
/// bound on the protocore extension (config patch) and restarts the service so
/// the bound is enforced going forward. The bytes already on disk are reclaimed
/// by the extension's own rotation under that bound. The caller sees the real
/// before/after sizes from `talos_log_disk_usage`.
#[tauri::command]
pub async fn talos_clean_protocore_logs(
    state: State<'_, TalosState>,
    max_megabytes: u32,
    max_files: u32,
) -> Result<TalosTextResult, String> {
    // 1) Set the retention bound (commit, not dry-run).
    let applied =
        talos_set_log_retention(state.clone(), max_megabytes, max_files, Some(false)).await?;
    // 2) Restart ext-protocore so the appender re-opens under the new bound.
    let restarted =
        talos_service_action(state, DEFAULT_SERVICE_ID.to_string(), "restart".to_string()).await?;

    Ok(TalosTextResult {
        node_address: applied.node_address,
        endpoint: applied.endpoint,
        command: format!("{} && {}", applied.command, restarted.command),
        output: format!(
            "{}\n{}\nLog retention applied and ext-protocore restarted. Existing bytes are reclaimed \
             by the extension's rotation under the new bound; Talos has no file-truncate RPC, so this \
             does not zero the file directly.",
            applied.output.trim(),
            restarted.output.trim()
        ),
        service: restarted.service,
    })
}

/// Scrub the seat-preserving recovery mnemonic out of a node's persisted STATE
/// config after a confirmed re-sync (#7 part a).
///
/// The seat-preserving recovery stages the operator's 24-word PLAINTEXT mnemonic
/// onto the node via a `machine.files` block (which is copied into
/// `/system/state/config.yaml`) and a `PROTOCORE_OPERATOR_MNEMONIC_FILE` env.
/// The protocore entrypoint securely deletes the on-node FILE after re-deriving
/// the key, but NOT the STATE copy — so the plaintext mnemonic lingers in the
/// persisted machine config indefinitely. This reads the current config, strips
/// EXACTLY those two recovery additions, and re-applies the COMPLETE config with
/// `NoReboot` (scrubbing must not cycle a freshly re-synced node). Every other
/// byte — PKI, certs, the talosconfig validity — is preserved, exactly like the
/// log-retention patch. NEVER logs the config.
///
/// Best-effort / defence-in-depth: if no recovery additions are present the
/// node is already clean and this is a no-op. The recovery orchestrator calls
/// this AFTER the recovery is already settled and the on-node file is already
/// entrypoint-deleted, so a failure here must never fail the recovery itself.
#[tauri::command]
pub async fn talos_scrub_recovery_mnemonic(
    state: State<'_, TalosState>,
) -> Result<TalosTextResult, String> {
    let (endpoint, config_path) = resolve_config(&state).await.map_err(|e| e.to_string())?;
    let endpoint = endpoint.ok_or_else(|| TalosError::MissingEndpoint.to_string())?;
    let config_path = config_path.ok_or_else(|| TalosError::MissingConfigPath.to_string())?;
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let control_plane =
        build_config_info(Some(&endpoint), &config_path).map_err(|e| e.to_string())?;
    enforce_privileged_control_plane(&control_plane).map_err(|e| e.to_string())?;
    let mut client = machine_client(&endpoint, &config_path)
        .await
        .map_err(|e| e.to_string())?;

    let current = read_machine_config(&mut client)
        .await
        .map_err(|e| e.to_string())?;

    let Some(scrubbed) = strip_recovery_mnemonic_from_config(&current) else {
        return Ok(TalosTextResult {
            node_address: node_address(&endpoint),
            endpoint,
            command: "talos read /system/state/config.yaml (scrub: no-op)".to_string(),
            output: "No staged recovery mnemonic found in the node config — nothing to scrub."
                .to_string(),
            service: None,
        });
    };

    let response = timeout(
        TALOS_TIMEOUT,
        client.apply_configuration(machine::ApplyConfigurationRequest {
            data: scrubbed.into_bytes(),
            // NoReboot — scrubbing must not cycle a freshly re-synced node.
            mode: machine::apply_configuration_request::Mode::NoReboot as i32,
            dry_run: false,
            try_mode_timeout: None,
        }),
    )
    .await
    .map_err(|_| TalosError::Timeout.to_string())?
    .map_err(|e| format!("apply rejected: {}", e.message()))?
    .into_inner();

    let messages = response
        .messages
        .into_iter()
        .flat_map(|m| {
            let mut lines = Vec::new();
            if !m.mode_details.is_empty() {
                lines.push(m.mode_details);
            }
            lines.extend(m.warnings);
            lines
        })
        .collect::<Vec<_>>()
        .join("\n");

    let output = if messages.trim().is_empty() {
        "Recovery mnemonic scrubbed from the node's persisted config (machine.files block + \
         PROTOCORE_OPERATOR_MNEMONIC_FILE env removed); PKI and the talosconfig are unchanged."
            .to_string()
    } else {
        messages
    };

    Ok(TalosTextResult {
        node_address: node_address(&endpoint),
        endpoint,
        command: "talos apply-config --mode no-reboot (scrub recovery mnemonic)".to_string(),
        output,
        service: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        any_type_is, backup_paths, build_log_retention_env, classify_protocore_readiness,
        cpu_busy_percent, endpoint_url, enforce_privileged_control_plane, first_version_info,
        format_fingerprint,
        is_post_dispatch_reboot_drop, machine_stage_label, merge_log_retention_into_config,
        node_address, normalize_private_key_pem, parse_reboot_mode, parse_rpc_u64,
        parse_service_action, parse_u64_string, protocore_rpc_endpoint, sanitize_backup_component,
        service_allows_offline_backup, strip_recovery_mnemonic_from_config,
        summarize_service_state, sync_status_is_synced,
        talos_logs_request, validate_service_name, validate_upgrade_image, ProtocoreRpcProbe,
        TalosCertificateInfo, TalosConfigInfo, TalosLineBuffer, TalosRebootMode, TalosServiceInfo,
        UPGRADE_REBOOTING_MARKER,
    };
    use prost::Message as _;
    use serde_json::json;
    use talos_rust_client::generated::{google, machine};
    use talos_rust_client::tonic::{Code, Status};

    fn cpu_stat(user: f64, system: f64, idle: f64, iowait: f64) -> machine::CpuStat {
        machine::CpuStat {
            user,
            system,
            idle,
            iowait,
            ..Default::default()
        }
    }

    #[test]
    fn cpu_busy_percent_from_jiffy_delta() {
        // Over the window: idle +60, busy (user+system) +40 → 40% busy.
        let first = cpu_stat(100.0, 50.0, 1000.0, 0.0);
        let second = cpu_stat(130.0, 60.0, 1060.0, 0.0);
        let pct = cpu_busy_percent(&first, &second).unwrap();
        assert!((pct - 40.0).abs() < 1e-9, "got {pct}");
    }

    #[test]
    fn cpu_busy_percent_none_on_no_movement_or_reset() {
        let stat = cpu_stat(100.0, 50.0, 1000.0, 0.0);
        // No movement between reads → no usable delta.
        assert!(cpu_busy_percent(&stat, &stat).is_none());
        // Counter reset (second < first) → non-positive total delta.
        let later = cpu_stat(10.0, 5.0, 100.0, 0.0);
        assert!(cpu_busy_percent(&stat, &later).is_none());
    }

    #[test]
    fn endpoint_url_adds_scheme_and_default_port() {
        assert_eq!(
            endpoint_url("192.0.2.20").unwrap(),
            "https://192.0.2.20:50000"
        );
        assert_eq!(
            endpoint_url("192.0.2.20:50000").unwrap(),
            "https://192.0.2.20:50000"
        );
        assert_eq!(
            endpoint_url("https://node.example.com:50000").unwrap(),
            "https://node.example.com:50000"
        );
    }

    #[test]
    fn node_address_strips_scheme_port_and_path() {
        assert_eq!(node_address("https://192.0.2.20:50000"), "192.0.2.20");
        assert_eq!(
            node_address("http://node.example.com:50000/api"),
            "node.example.com"
        );
        assert_eq!(node_address("192.0.2.21"), "192.0.2.21");
    }

    #[test]
    fn node_address_preserves_ipv6_host() {
        assert_eq!(node_address("https://[fd00::1]:50000"), "fd00::1");
        assert_eq!(node_address("fd00::2"), "fd00::2");
    }

    #[test]
    fn talos_ed25519_private_key_is_pkcs8_labelled_for_rustls() {
        let input = b"-----BEGIN ED25519 PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END ED25519 PRIVATE KEY-----\n".to_vec();

        let normalized = normalize_private_key_pem("client key", input).unwrap();
        let text = String::from_utf8(normalized).unwrap();

        assert!(text.contains("-----BEGIN PRIVATE KEY-----"));
        assert!(text.contains("-----END PRIVATE KEY-----"));
        assert!(!text.contains("ED25519 PRIVATE KEY"));
    }

    #[test]
    fn service_names_are_restricted() {
        assert!(validate_service_name("ext-protocore").is_ok());
        assert!(validate_service_name("apid").is_ok());
        assert!(validate_service_name("bad service").is_err());
        assert!(validate_service_name("$(rm -rf /)").is_err());
    }

    #[test]
    fn service_action_is_restricted() {
        assert!(parse_service_action("start").is_ok());
        assert!(parse_service_action("STOP").is_ok());
        assert!(parse_service_action("restart").is_ok());
        assert!(parse_service_action("reboot").is_err());
    }

    #[test]
    fn machine_stage_label_covers_every_variant() {
        use machine::machine_status_event::MachineStage;
        assert_eq!(machine_stage_label(MachineStage::Running), "Running");
        assert_eq!(machine_stage_label(MachineStage::Booting), "Booting");
        assert_eq!(machine_stage_label(MachineStage::Upgrading), "Upgrading");
        assert_eq!(machine_stage_label(MachineStage::Installing), "Installing");
        assert_eq!(machine_stage_label(MachineStage::Maintenance), "Maintenance");
        assert_eq!(machine_stage_label(MachineStage::Rebooting), "Rebooting");
        assert_eq!(machine_stage_label(MachineStage::ShuttingDown), "Shutting down");
        assert_eq!(machine_stage_label(MachineStage::Resetting), "Resetting");
        assert_eq!(machine_stage_label(MachineStage::Unknown), "Unknown");
    }

    #[test]
    fn any_type_is_matches_on_message_name_suffix() {
        // Talos stamps the message name as the last path segment; match it
        // regardless of the registry prefix so a prefix change doesn't break
        // the decode.
        let make = |url: &str| google::protobuf::Any {
            type_url: url.to_string(),
            value: Vec::new(),
        };
        assert!(any_type_is(
            &make("type.googleapis.com/machine.MachineStatusEvent"),
            "MachineStatusEvent"
        ));
        assert!(any_type_is(
            &make("talos.dev/v1alpha1/MachineStatusEvent"),
            "MachineStatusEvent"
        ));
        assert!(any_type_is(
            &make("type.googleapis.com/machine.AddressEvent"),
            "AddressEvent"
        ));
        assert!(!any_type_is(
            &make("type.googleapis.com/machine.AddressEvent"),
            "MachineStatusEvent"
        ));
        // A different message under the same package must not match.
        assert!(!any_type_is(
            &make("type.googleapis.com/machine.SequenceEvent"),
            "MachineStatusEvent"
        ));
    }

    #[test]
    fn first_version_info_extracts_tag_and_arch_best_effort() {
        // No messages → None.
        let empty = machine::VersionResponse { messages: vec![] };
        assert!(first_version_info(&empty).is_none());

        // A message with no version payload is skipped; the first with one wins.
        let resp = machine::VersionResponse {
            messages: vec![
                machine::Version {
                    metadata: None,
                    version: None,
                    platform: None,
                    features: None,
                },
                machine::Version {
                    metadata: None,
                    version: Some(machine::VersionInfo {
                        tag: "v1.9.0".to_string(),
                        sha: "abc".to_string(),
                        built: String::new(),
                        go_version: String::new(),
                        os: "linux".to_string(),
                        arch: "amd64".to_string(),
                    }),
                    platform: None,
                    features: None,
                },
            ],
        };
        let info = first_version_info(&resp).expect("version info present");
        assert_eq!(info.tag, "v1.9.0");
        assert_eq!(info.arch, "amd64");
    }

    #[test]
    fn machine_status_event_decodes_from_any_value() {
        // Prove the Any-payload decode path the events reader relies on: encode
        // a MachineStatusEvent, wrap it in an Any with the Talos type_url, and
        // confirm we recover the stage label + ready + unmet condition names.
        let event = machine::MachineStatusEvent {
            stage: machine::machine_status_event::MachineStage::Running as i32,
            status: Some(machine::machine_status_event::MachineStatus {
                ready: false,
                unmet_conditions: vec![
                    machine::machine_status_event::machine_status::UnmetCondition {
                        name: "ext-protocore".to_string(),
                        reason: "not healthy yet".to_string(),
                    },
                ],
            }),
        };
        let any = google::protobuf::Any {
            type_url: "type.googleapis.com/machine.MachineStatusEvent".to_string(),
            value: event.encode_to_vec(),
        };

        assert!(any_type_is(&any, "MachineStatusEvent"));
        let decoded =
            machine::MachineStatusEvent::decode(any.value.as_slice()).expect("decodes");
        let stage = machine::machine_status_event::MachineStage::try_from(decoded.stage).unwrap();
        assert_eq!(machine_stage_label(stage), "Running");
        let status = decoded.status.expect("status present");
        assert!(!status.ready);
        assert_eq!(status.unmet_conditions[0].name, "ext-protocore");
    }

    #[test]
    fn talos_logs_request_reads_service_logs() {
        let req = talos_logs_request("ext-protocore".to_string(), true, 128);

        // Service-log shape: the `system` containerd namespace keyed on the
        // service `id`, mirroring `talosctl logs ext-protocore`. An empty
        // namespace is rejected by Talos with `InvalidArgument: "namespace
        // can't be empty"` (v1.13.0), so it MUST be non-empty.
        assert_eq!(req.namespace, "system");
        assert_eq!(req.id, "ext-protocore");
        assert!(req.follow);
        assert_eq!(req.tail_lines, 128);
    }

    #[test]
    fn no_health_check_running_service_is_not_degraded() {
        // The protocore extension declares no Talos health check, so Talos
        // reports health.unknown=true with a default healthy=false. A Running,
        // serving node must read "running" — never the alarming "degraded".
        let (display, severity, _) =
            summarize_service_state("ext-protocore", "Running", Some(false), Some(true), &None);
        assert_eq!(display, "running");
        assert_eq!(severity, "ok");
    }

    #[test]
    fn known_failing_health_still_reads_degraded() {
        // A service WITH a health check that genuinely fails
        // (health.unknown=false, healthy=false) still surfaces as degraded.
        let (display, severity, _) = summarize_service_state(
            "ext-protocore",
            "Running",
            Some(false),
            Some(false),
            &Some("rpc probe failed".to_string()),
        );
        assert_eq!(display, "degraded");
        assert_eq!(severity, "err");
    }

    #[test]
    fn log_retention_env_encodes_bytes_and_files() {
        let (max_bytes, max_files, bound) = build_log_retention_env(512, 5).unwrap();
        assert_eq!(max_bytes, 512 * 1_048_576);
        assert_eq!(bound, 512 * 1_048_576);
        assert_eq!(max_files, 5);
    }

    #[test]
    fn log_retention_env_rejects_out_of_range() {
        assert!(build_log_retention_env(0, 5).is_err());
        assert!(build_log_retention_env(512, 0).is_err());
        assert!(build_log_retention_env(512, 65).is_err());
        assert!(build_log_retention_env(2_000_000, 5).is_err());
    }

    // A minimal-but-realistic two-document machine config: the v1alpha1 Config
    // document plus the protocore ExtensionServiceConfig the installer bakes in.
    const SAMPLE_MACHINE_CONFIG: &str = "version: v1alpha1\n\
machine:\n\
\x20\x20type: controlplane\n\
\x20\x20install:\n\
\x20\x20\x20\x20disk: /dev/sda\n\
cluster:\n\
\x20\x20id: abc\n\
---\n\
apiVersion: v1alpha1\n\
kind: ExtensionServiceConfig\n\
name: protocore\n\
environment:\n\
\x20\x20- PROTOCORE_NODE_MODE=operator\n\
\x20\x20- PROTOCORE_P2P_LISTEN=/ip4/0.0.0.0/tcp/29898\n";

    #[test]
    fn merge_log_retention_produces_complete_v1alpha1_config_not_a_partial() {
        let merged = merge_log_retention_into_config(SAMPLE_MACHINE_CONFIG, 512, 5).unwrap();
        // The applied payload is the COMPLETE config: it MUST carry the
        // v1alpha1 Config document so Talos's full apply accepts it. This is the
        // regression guard for the "doesn't contain v1alpha1 config" rejection.
        assert!(merged.config.contains("version: v1alpha1"));
        assert!(merged.config.contains("machine:"));
        assert!(merged.config.contains("cluster:"));
        // It is NOT a bare ExtensionServiceConfig document.
        assert!(merged.config.starts_with("version: v1alpha1"));
        // The original protocore env is preserved...
        assert!(merged.config.contains("PROTOCORE_NODE_MODE=operator"));
        assert!(merged
            .config
            .contains("PROTOCORE_P2P_LISTEN=/ip4/0.0.0.0/tcp/29898"));
        // ...and the retention bound is recorded inside that same document.
        assert!(merged
            .config
            .contains(&format!("PROTOCORE_LOG_MAX_BYTES={}", 512 * 1_048_576)));
        assert!(merged.config.contains("PROTOCORE_LOG_MAX_FILES=5"));
        assert_eq!(merged.max_bytes, 512 * 1_048_576);
        assert_eq!(merged.max_files, 5);
        // Exactly one document separator (two documents total).
        assert_eq!(merged.config.matches("\n---\n").count(), 1);
    }

    #[test]
    fn merge_log_retention_replaces_existing_keys_idempotently() {
        let with_existing = format!(
            "{}\x20\x20- PROTOCORE_LOG_MAX_BYTES=1\n\x20\x20- PROTOCORE_LOG_MAX_FILES=1\n",
            SAMPLE_MACHINE_CONFIG
        );
        let merged = merge_log_retention_into_config(&with_existing, 256, 9).unwrap();
        // Old values are gone, replaced in place (no duplicates).
        assert_eq!(
            merged
                .config
                .matches("PROTOCORE_LOG_MAX_BYTES=")
                .count(),
            1
        );
        assert_eq!(
            merged
                .config
                .matches("PROTOCORE_LOG_MAX_FILES=")
                .count(),
            1
        );
        assert!(merged
            .config
            .contains(&format!("PROTOCORE_LOG_MAX_BYTES={}", 256 * 1_048_576)));
        assert!(merged.config.contains("PROTOCORE_LOG_MAX_FILES=9"));
        // Applying the SAME bound again is a no-op on the key set.
        let again = merge_log_retention_into_config(&merged.config, 256, 9).unwrap();
        assert_eq!(again.config, merged.config);
    }

    #[test]
    fn merge_log_retention_appends_extension_doc_when_absent() {
        let only_v1alpha1 = "version: v1alpha1\nmachine:\n  type: controlplane\ncluster:\n  id: x\n";
        let merged = merge_log_retention_into_config(only_v1alpha1, 64, 3).unwrap();
        // Original v1alpha1 Config preserved...
        assert!(merged.config.contains("version: v1alpha1"));
        assert!(merged.config.contains("machine:"));
        // ...and a fresh protocore ExtensionServiceConfig document was appended.
        assert!(merged.config.contains("kind: ExtensionServiceConfig"));
        assert!(merged.config.contains("name: protocore"));
        assert!(merged
            .config
            .contains(&format!("PROTOCORE_LOG_MAX_BYTES={}", 64 * 1_048_576)));
        assert!(merged.config.contains("PROTOCORE_LOG_MAX_FILES=3"));
        assert_eq!(merged.config.matches("\n---\n").count(), 1);
    }

    #[test]
    fn merge_log_retention_rejects_config_without_v1alpha1() {
        // A bare ExtensionServiceConfig (no v1alpha1 Config) must be rejected —
        // re-applying it as a full config is exactly the bug we are fixing.
        let bare = "apiVersion: v1alpha1\nkind: ExtensionServiceConfig\nname: protocore\nenvironment:\n  - PROTOCORE_NODE_MODE=operator\n";
        assert!(merge_log_retention_into_config(bare, 512, 5).is_err());
        assert!(merge_log_retention_into_config("", 512, 5).is_err());
    }

    #[test]
    fn merge_log_retention_validates_bound_before_touching_config() {
        assert!(merge_log_retention_into_config(SAMPLE_MACHINE_CONFIG, 0, 5).is_err());
        assert!(merge_log_retention_into_config(SAMPLE_MACHINE_CONFIG, 512, 0).is_err());
        assert!(merge_log_retention_into_config(SAMPLE_MACHINE_CONFIG, 512, 65).is_err());
    }

    // #7 — recovery-mnemonic STATE scrub.
    const SCRUB_TEST_MNEMONIC: &str = "abandon ability able about above absent absorb \
abstract absurd abuse access accident account accuse achieve acid acoustic \
acquire across act action actor actress address";

    #[test]
    fn strip_removes_recovery_block_and_env_but_keeps_pki() {
        let recovery = crate::provision::generate_recovery_node_config(
            "10.0.0.5",
            "/dev/sda",
            SCRUB_TEST_MNEMONIC,
        )
        .expect("recovery config generates");
        let yaml = recovery.config_yaml;
        // Sanity: the staged mnemonic + env are present before scrubbing.
        assert!(yaml.contains(SCRUB_TEST_MNEMONIC));
        assert!(yaml.contains(crate::provision::RECOVERY_MNEMONIC_PATH));
        assert!(yaml.contains(crate::provision::RECOVERY_MNEMONIC_ENV));

        let scrubbed = strip_recovery_mnemonic_from_config(&yaml)
            .expect("a recovery config has something to scrub");
        // The plaintext mnemonic + env + recovery path are GONE.
        assert!(!scrubbed.contains(SCRUB_TEST_MNEMONIC), "mnemonic must be gone");
        assert!(
            !scrubbed.contains(crate::provision::RECOVERY_MNEMONIC_ENV),
            "recovery env must be gone"
        );
        assert!(
            !scrubbed.contains(crate::provision::RECOVERY_MNEMONIC_PATH),
            "recovery path must be gone"
        );
        // PKI / config skeleton preserved (byte-for-byte for everything else).
        assert!(scrubbed.contains("version: v1alpha1"), "v1alpha1 doc preserved");
        assert!(scrubbed.contains("    ca:\n        crt: "), "machine CA preserved");
        assert!(
            scrubbed.contains("    - PROTOCORE_NODE_MODE=full"),
            "protocore full-node env preserved"
        );
        // Still three documents.
        assert_eq!(scrubbed.split("\n---\n").count(), 3);
    }

    #[test]
    fn strip_is_idempotent_and_noop_on_clean_config() {
        let recovery = crate::provision::generate_recovery_node_config(
            "10.0.0.5",
            "/dev/sda",
            SCRUB_TEST_MNEMONIC,
        )
        .expect("recovery config generates")
        .config_yaml;
        let scrubbed = strip_recovery_mnemonic_from_config(&recovery).unwrap();
        // Re-running on the already-scrubbed config is a no-op (returns None).
        assert!(
            strip_recovery_mnemonic_from_config(&scrubbed).is_none(),
            "second scrub finds nothing to remove"
        );
        // A fresh (non-recovery) config also returns None.
        let fresh =
            crate::provision::generate_full_node_config("10.0.0.5", "/dev/sda").unwrap().config_yaml;
        assert!(strip_recovery_mnemonic_from_config(&fresh).is_none());
        // An empty config returns None.
        assert!(strip_recovery_mnemonic_from_config("").is_none());
    }

    #[test]
    fn strip_preserves_an_unrelated_files_block() {
        // A config carrying an operator-authored machine.files block targeting a
        // DIFFERENT path must NOT be touched (anchored to the recovery path).
        let config = format!(
            "version: v1alpha1\nmachine:\n    type: controlplane\n    files:\n        \
             - content: hello\n          permissions: 0o644\n          path: /var/etc/motd\n          \
             op: create\n    files:\n        - content: {m}\n          permissions: 0o600\n          \
             path: {p}\n          op: create\n---\napiVersion: v1alpha1\nkind: ExtensionServiceConfig\n\
             name: protocore\nenvironment:\n    - PROTOCORE_NODE_MODE=full\n    - {e}={p}\n",
            m = SCRUB_TEST_MNEMONIC,
            p = crate::provision::RECOVERY_MNEMONIC_PATH,
            e = crate::provision::RECOVERY_MNEMONIC_ENV,
        );
        let scrubbed = strip_recovery_mnemonic_from_config(&config).unwrap();
        // Unrelated motd file survives.
        assert!(scrubbed.contains("path: /var/etc/motd"), "unrelated files block preserved");
        assert!(scrubbed.contains("content: hello"));
        // Recovery additions gone.
        assert!(!scrubbed.contains(SCRUB_TEST_MNEMONIC));
        assert!(!scrubbed.contains(crate::provision::RECOVERY_MNEMONIC_PATH));
        assert!(!scrubbed.contains(crate::provision::RECOVERY_MNEMONIC_ENV));
    }

    #[test]
    fn upgrade_image_reference_is_restricted() {
        assert_eq!(
            validate_upgrade_image("ghcr.io/monolythium/monarch-os:2026.06.01").unwrap(),
            "ghcr.io/monolythium/monarch-os:2026.06.01"
        );
        assert!(validate_upgrade_image(
            "registry.example/monarch/os@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        )
        .is_ok());
        assert!(validate_upgrade_image("monarch-os").is_err());
        assert!(validate_upgrade_image("ghcr.io/monolythium/monarch os:latest").is_err());
        assert!(validate_upgrade_image("ghcr.io/monolythium/monarch-os").is_err());
        assert!(validate_upgrade_image("registry.example/monarch/os@sha256:not-a-digest").is_err());
        assert!(validate_upgrade_image("ghcr.io/../monarch-os:latest").is_err());
    }

    #[test]
    fn reboot_mode_is_restricted() {
        assert_eq!(
            parse_reboot_mode("default").unwrap(),
            TalosRebootMode::Default
        );
        assert_eq!(
            parse_reboot_mode("powercycle").unwrap(),
            TalosRebootMode::Powercycle
        );
        assert!(parse_reboot_mode("halt").is_err());
    }

    #[test]
    fn service_state_summary_promotes_health() {
        let (display, severity, summary) =
            summarize_service_state("ext-protocore", "Running", Some(true), Some(false), &None);
        assert_eq!(display, "running");
        assert_eq!(severity, "ok");
        assert!(summary.contains("ext-protocore running"));

        let (display, severity, _) = summarize_service_state(
            "ext-protocore",
            "Running",
            Some(false),
            Some(false),
            &Some("probe failed".to_string()),
        );
        assert_eq!(display, "degraded");
        assert_eq!(severity, "err");
    }

    #[test]
    fn backup_filename_components_are_sanitized() {
        assert_eq!(
            sanitize_backup_component("node-01.example"),
            "node-01.example"
        );
        assert_eq!(
            sanitize_backup_component("https://node 01"),
            "https___node_01"
        );
        assert_eq!(sanitize_backup_component("///"), "node");

        let (archive, manifest) = backup_paths("node/01", 1_812_345_678).unwrap();
        assert!(archive
            .display()
            .to_string()
            .ends_with("protocore-node_01-1812345678.tar.gz"));
        assert!(manifest
            .display()
            .to_string()
            .ends_with("protocore-node_01-1812345678.backup.json"));
    }

    #[test]
    fn offline_backup_requires_stopped_service_state() {
        assert!(service_allows_offline_backup(&service("stopped", "warn")));
        assert!(service_allows_offline_backup(&service("down", "warn")));
        assert!(!service_allows_offline_backup(&service("running", "ok")));
        assert!(!service_allows_offline_backup(&service("degraded", "err")));
    }

    #[test]
    fn protocore_rpc_endpoint_defaults_from_talos_endpoint() {
        assert_eq!(
            protocore_rpc_endpoint("https://192.0.2.20:50000", None).unwrap(),
            "http://192.0.2.20:8545"
        );
        assert_eq!(
            protocore_rpc_endpoint("https://[fd00::1]:50000", None).unwrap(),
            "http://[fd00::1]:8545"
        );
        assert_eq!(
            protocore_rpc_endpoint("https://192.0.2.20:50000", Some("127.0.0.1:18545")).unwrap(),
            "http://127.0.0.1:18545"
        );
        assert!(protocore_rpc_endpoint("https://192.0.2.20:50000", Some("ftp://host")).is_err());
    }

    #[test]
    fn rpc_u64_parser_accepts_hex_and_decimal() {
        assert_eq!(parse_u64_string("0x10"), Some(16));
        assert_eq!(parse_u64_string("16"), Some(16));
        assert_eq!(parse_rpc_u64(&json!("0x10f2c")), Some(69420));
        assert_eq!(parse_rpc_u64(&json!(69420)), Some(69420));
        assert_eq!(parse_rpc_u64(&json!("not-a-number")), None);
    }

    #[test]
    fn protocore_readiness_classifies_serving_rpc() {
        let readiness = classify_protocore_readiness(
            Some(service("running", "ok")),
            "http://127.0.0.1:8545".to_string(),
            ProtocoreRpcProbe {
                chain_id: Some(69420),
                block_number: Some(42),
                client_version: Some("protocore/test".to_string()),
                listening: Some(true),
                syncing: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(readiness.display_state, "serving-rpc");
        assert_eq!(readiness.severity, "ok");
        assert_eq!(readiness.chain_id, Some(69420));
        assert!(readiness.summary.contains("block 42"));
    }

    #[test]
    fn protocore_readiness_accepts_health_unknown_when_rpc_serves() {
        let mut service = service("degraded", "err");
        service.state = "Running".to_string();
        service.healthy = Some(false);
        service.health_unknown = Some(true);
        service.summary = "ext-protocore degraded (raw state: Running)".to_string();

        let readiness = classify_protocore_readiness(
            Some(service),
            "http://127.0.0.1:8545".to_string(),
            ProtocoreRpcProbe {
                chain_id: Some(69420),
                block_number: Some(42),
                client_version: Some("protocore/test".to_string()),
                listening: Some(true),
                syncing: Some(false),
                ..Default::default()
            },
        );

        assert_eq!(readiness.display_state, "serving-rpc");
        assert_eq!(readiness.severity, "ok");
        assert_eq!(
            readiness
                .service
                .as_ref()
                .map(|service| service.severity.as_str()),
            Some("ok")
        );
    }

    #[test]
    fn protocore_readiness_overrides_unhealthy_flag_when_rpc_serves() {
        // Regression for monarch-desktop #3: Talos health check has COMPLETED
        // (health_unknown=false) and reports healthy=false, so summarize_service_state
        // painted the service "degraded"/"err". But the RPC is confirmably serving
        // chain data, which is authoritative -> the readiness must read "serving-rpc"
        // (ok), not "degraded".
        let mut service = service("degraded", "err");
        service.state = "Running".to_string();
        service.healthy = Some(false);
        service.health_unknown = Some(false);
        service.summary = "ext-protocore degraded (raw state: Running)".to_string();

        let readiness = classify_protocore_readiness(
            Some(service),
            "http://127.0.0.1:8545".to_string(),
            ProtocoreRpcProbe {
                chain_id: Some(69420),
                block_number: Some(42),
                client_version: Some("protocore/test".to_string()),
                listening: Some(true),
                syncing: Some(false),
                ..Default::default()
            },
        );

        assert_eq!(readiness.display_state, "serving-rpc");
        assert_eq!(readiness.severity, "ok");
        assert_eq!(
            readiness
                .service
                .as_ref()
                .map(|service| service.severity.as_str()),
            Some("ok")
        );
        assert_eq!(
            readiness
                .service
                .as_ref()
                .map(|service| service.display_state.as_str()),
            Some("running")
        );
    }

    #[test]
    fn protocore_readiness_keeps_degraded_when_unhealthy_and_rpc_down() {
        // Guard: an unhealthy Talos report with NO serving RPC must still surface as
        // degraded/err -- we only treat RPC as authoritative when it actually serves.
        let mut service = service("degraded", "err");
        service.state = "Running".to_string();
        service.healthy = Some(false);
        service.health_unknown = Some(false);
        service.summary = "ext-protocore degraded (raw state: Running)".to_string();

        let readiness = classify_protocore_readiness(
            Some(service),
            "http://127.0.0.1:8545".to_string(),
            ProtocoreRpcProbe {
                chain_id_error: Some("eth_chainId transport failed".to_string()),
                block_number_error: Some("eth_blockNumber transport failed".to_string()),
                ..Default::default()
            },
        );

        assert_eq!(readiness.display_state, "degraded");
        assert_eq!(readiness.severity, "err");
    }

    #[test]
    fn protocore_readiness_keeps_stopped_service_when_unhealthy() {
        // A genuinely-stopped service must not be promoted even if some RPC answers:
        // raw state "stopped" wins, so readiness stays "stopped"/warn.
        let mut service = service("stopped", "warn");
        service.state = "Stopped".to_string();
        service.healthy = Some(false);
        service.health_unknown = Some(false);

        let readiness = classify_protocore_readiness(
            Some(service),
            "http://127.0.0.1:8545".to_string(),
            ProtocoreRpcProbe {
                chain_id: Some(69420),
                block_number: Some(42),
                syncing: Some(false),
                ..Default::default()
            },
        );

        assert_eq!(readiness.display_state, "stopped");
        assert_eq!(readiness.severity, "warn");
    }

    #[test]
    fn protocore_readiness_keeps_failed_service_fatal() {
        let readiness = classify_protocore_readiness(
            Some(service("failed", "err")),
            "http://127.0.0.1:8545".to_string(),
            ProtocoreRpcProbe {
                chain_id: Some(69420),
                block_number: Some(42),
                syncing: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(readiness.display_state, "failed");
        assert_eq!(readiness.severity, "err");
    }

    #[test]
    fn protocore_readiness_serves_when_node_answers_with_all_namespaces_restricted() {
        // Regression for the "STAGE Booting / READY False on a healthy node"
        // report: an operator gates the eth_* (and lyth_chainStatus/syncStatus)
        // read namespaces off, so every chain-data probe came back as a
        // structured JSON-RPC error (-32045 "method disabled"). The node still
        // ANSWERED every request, so it is up and serving and must classify as
        // serving-rpc/ok -- NOT fall back to the raw Talos boot state.
        let mut service = service("waiting-for-config", "warn");
        service.state = "Running".to_string();
        service.healthy = Some(false);
        service.health_unknown = Some(true);
        service.summary =
            "ext-protocore is waiting for service config (raw state: Running)".to_string();

        let readiness = classify_protocore_readiness(
            Some(service),
            "http://127.0.0.1:8545".to_string(),
            ProtocoreRpcProbe {
                // The node answered, but every value-bearing method was gated.
                rpc_answered: true,
                chain_id_error: Some(
                    "eth_chainId returned RPC error: method disabled".to_string(),
                ),
                block_number_error: Some(
                    "eth_blockNumber returned RPC error: method disabled".to_string(),
                ),
                syncing_error: Some(
                    "eth_syncing returned RPC error: method disabled".to_string(),
                ),
                ..Default::default()
            },
        );

        assert_eq!(readiness.display_state, "serving-rpc");
        assert_eq!(readiness.severity, "ok");
        assert!(readiness.chain_id.is_none());
        assert!(readiness.block_number.is_none());
        // The Talos boot-state display must be recovered to running, not left
        // as the "waiting-for-config" that produced "Booting".
        assert_eq!(
            readiness
                .service
                .as_ref()
                .map(|service| service.display_state.as_str()),
            Some("running")
        );
        assert_eq!(
            readiness
                .service
                .as_ref()
                .map(|service| service.severity.as_str()),
            Some("ok")
        );
    }

    #[test]
    fn protocore_readiness_booting_only_when_node_never_answers() {
        // Guard the inverse: a node that answers NOTHING (pure transport
        // failure, rpc_answered=false) and whose Talos state is the first-boot
        // "waiting-for-config" must still read as not-yet-serving.
        let readiness = classify_protocore_readiness(
            Some(service("waiting-for-config", "warn")),
            "http://127.0.0.1:8545".to_string(),
            ProtocoreRpcProbe {
                rpc_answered: false,
                chain_id_error: Some("eth_chainId transport failed".to_string()),
                block_number_error: Some("eth_blockNumber transport failed".to_string()),
                ..Default::default()
            },
        );
        assert_eq!(readiness.display_state, "waiting-for-config");
        assert_ne!(readiness.display_state, "serving-rpc");
    }

    #[test]
    fn protocore_readiness_downgrades_to_syncing_even_when_answered() {
        // An answering node whose working sync probe reports syncing=true must
        // still surface as syncing -- rpc_answered does not paper over a real
        // "catching up" signal.
        let readiness = classify_protocore_readiness(
            Some(service("running", "ok")),
            "http://127.0.0.1:8545".to_string(),
            ProtocoreRpcProbe {
                rpc_answered: true,
                chain_id_error: Some("eth_chainId returned RPC error: method disabled".to_string()),
                block_number_error: Some(
                    "eth_blockNumber returned RPC error: method disabled".to_string(),
                ),
                syncing: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(readiness.display_state, "syncing");
    }

    #[test]
    fn sync_status_synced_rule_matches_node_chip() {
        // Caught up: small lag, positive local round.
        assert_eq!(
            sync_status_is_synced(&json!({ "localRound": 1200, "lag": 2 })),
            Some(true)
        );
        // Behind: lag past the threshold.
        assert_eq!(
            sync_status_is_synced(&json!({ "localRound": 1200, "lag": 40 })),
            Some(false)
        );
        // Round 0 with peers ahead is not synced.
        assert_eq!(
            sync_status_is_synced(&json!({ "localRound": 0, "peerMaxRound": 1200 })),
            Some(false)
        );
        // Explicit catching-up state wins.
        assert_eq!(
            sync_status_is_synced(&json!({ "localRound": 1200, "state": "catching" })),
            Some(false)
        );
        // No usable signal -> unknown.
        assert_eq!(sync_status_is_synced(&json!({})), None);
    }

    #[test]
    fn protocore_readiness_reports_syncing_when_rpc_not_serving_blocks() {
        let readiness = classify_protocore_readiness(
            Some(service("running", "ok")),
            "http://127.0.0.1:8545".to_string(),
            ProtocoreRpcProbe {
                chain_id: Some(69420),
                block_number_error: Some("eth_blockNumber transport failed".to_string()),
                syncing: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(readiness.display_state, "syncing");
        assert_eq!(readiness.severity, "info");
    }

    #[test]
    fn talos_line_buffer_splits_chunks() {
        let mut buf = TalosLineBuffer::default();
        assert_eq!(buf.feed(b"one\ntw"), vec!["one".to_string()]);
        assert_eq!(buf.feed(b"o\r\nthree"), vec!["two".to_string()]);
        assert_eq!(buf.flush(), Some("three".to_string()));
    }

    #[test]
    fn fingerprint_formats_uppercase_sha256() {
        assert_eq!(
            format_fingerprint(b"abc"),
            "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD"
        );
    }

    #[test]
    fn privileged_control_plane_requires_trusted_ca_pin() {
        let mut info = config_info();
        info.ca_pin_status = "untrusted".to_string();

        let err = enforce_privileged_control_plane(&info).unwrap_err();
        assert!(err
            .to_string()
            .contains("Talos CA fingerprint is not trusted"));
    }

    #[test]
    fn privileged_control_plane_rejects_endpoint_outside_context() {
        let mut info = config_info();
        info.endpoint = "https://198.51.100.20:50000".to_string();

        let err = enforce_privileged_control_plane(&info).unwrap_err();
        assert!(err
            .to_string()
            .contains("not listed in the active talosconfig context"));
    }

    #[test]
    fn privileged_control_plane_rejects_expired_certificates() {
        let mut info = config_info();
        info.certificates[1].expired = true;

        let err = enforce_privileged_control_plane(&info).unwrap_err();
        assert!(err.to_string().contains("client certificate is expired"));
    }

    #[test]
    fn privileged_control_plane_accepts_matched_pin_and_valid_certs() {
        assert!(enforce_privileged_control_plane(&config_info()).is_ok());
    }

    #[test]
    fn post_dispatch_transport_drops_classify_as_reboot() {
        // A Talos image upgrade reboots the node, so the control connection drops
        // AFTER the request was dispatched on an already-connected channel. Every
        // transport-class gRPC status here is the signature of that reboot, not a
        // node that was never reached — they must read as "dispatched, rebooting".
        for code in [
            Code::Unavailable,
            Code::Cancelled,
            Code::Unknown,
            Code::Aborted,
            Code::DeadlineExceeded,
            Code::Internal,
        ] {
            assert!(
                is_post_dispatch_reboot_drop(&Status::new(code, "connection reset")),
                "{code:?} should classify as a post-dispatch reboot drop"
            );
        }
    }

    #[test]
    fn post_dispatch_application_errors_are_not_reboots() {
        // A genuine application-level rejection (the node answered with a real
        // error, e.g. an invalid image) is NOT the reboot path — it must surface
        // as a failure, not be masked as "rebooting".
        for code in [
            Code::InvalidArgument,
            Code::PermissionDenied,
            Code::Unauthenticated,
            Code::NotFound,
            Code::FailedPrecondition,
        ] {
            assert!(
                !is_post_dispatch_reboot_drop(&Status::new(code, "rejected")),
                "{code:?} must not be masked as a reboot drop"
            );
        }
    }

    #[test]
    fn upgrade_rebooting_marker_is_stable_and_recognisable() {
        // The TS layer keys off this exact text — keep it byte-stable and on the
        // "rebooting into the new image" phrasing the front-end also matches.
        assert_eq!(
            UPGRADE_REBOOTING_MARKER,
            "upgrade dispatched: node is rebooting into the new image"
        );
        assert!(UPGRADE_REBOOTING_MARKER.contains("rebooting into the new image"));
    }

    fn service(display_state: &str, severity: &str) -> TalosServiceInfo {
        TalosServiceInfo {
            id: "ext-protocore".to_string(),
            state: display_state.to_string(),
            display_state: display_state.to_string(),
            severity: severity.to_string(),
            summary: format!("ext-protocore {display_state}"),
            healthy: Some(severity == "ok"),
            health_unknown: Some(false),
            health_message: None,
            last_event: None,
            events: Vec::new(),
        }
    }

    fn config_info() -> TalosConfigInfo {
        TalosConfigInfo {
            path: "/tmp/talosconfig".to_string(),
            context: "monarch".to_string(),
            endpoint: "https://192.0.2.20:50000".to_string(),
            server_name: "192.0.2.20".to_string(),
            ca_fingerprint: "AA:BB".to_string(),
            trusted_ca_fingerprint: Some("AA:BB".to_string()),
            ca_pin_status: "matched".to_string(),
            endpoints: vec!["192.0.2.20:50000".to_string()],
            nodes: vec!["192.0.2.20".to_string()],
            certificates: vec![certificate("Talos CA"), certificate("client")],
            warnings: Vec::new(),
        }
    }

    fn certificate(role: &str) -> TalosCertificateInfo {
        TalosCertificateInfo {
            role: role.to_string(),
            subject: format!("CN={role}"),
            issuer: "CN=Talos CA".to_string(),
            not_before: "2026-01-01T00:00:00Z".to_string(),
            not_after: "2027-01-01T00:00:00Z".to_string(),
            sha256_fingerprint: "AA:BB".to_string(),
            expired: false,
            not_yet_valid: false,
            expires_in_days: 365,
            dns_names: Vec::new(),
            ip_addresses: Vec::new(),
        }
    }
}
