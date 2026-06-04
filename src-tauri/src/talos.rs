// Talos control bridge for Monarch OS.
//
// Monarch OS does not expose SSH. This module gives the desktop app a
// native mTLS control path over the Talos API using the operator's
// `talosconfig`. It intentionally avoids shelling out to `talosctl` so
// signed releases can be self-contained.

use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures_util::StreamExt;
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
const DEFAULT_SERVICE_ID: &str = "ext-protocore";
const PROTOCORE_DATA_DIR: &str = "/var/lib/protocore";
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
    pub memory: Option<TalosMemoryTelemetry>,
    pub mounts: Vec<TalosMountTelemetry>,
    pub network: Vec<TalosNetworkTelemetry>,
    #[serde(rename = "diskIo")]
    pub disk_io: Vec<TalosDiskIoTelemetry>,
    pub disks: Vec<TalosDiskTelemetry>,
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

fn endpoint_url(endpoint: &str) -> Result<String, TalosError> {
    let endpoint = normalise_endpoint(endpoint)?;
    if endpoint.contains("://") {
        return Ok(endpoint);
    }
    if endpoint.contains(':') {
        return Ok(format!("https://{endpoint}"));
    }
    Ok(format!("https://{endpoint}:50000"))
}

fn node_address(endpoint: &str) -> String {
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
    let key = decode_pem("client key", &context.key)?;

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
    } else if matches!(healthy, Some(false)) {
        "degraded"
    } else if lower.contains("restart") || lower.contains("start") || lower.contains("pre") {
        "restarting"
    } else if lower.contains("stop") || lower.contains("down") {
        "stopped"
    } else if matches!(health_unknown, Some(true)) || lower.contains("wait") {
        "waiting-for-config"
    } else if lower.contains("run") || matches!(healthy, Some(true)) {
        "running"
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

fn disk_type_label(raw: i32) -> String {
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

async fn rpc_call(client: &reqwest::Client, endpoint: &str, method: &str) -> Result<Value, String> {
    let response = timeout(
        PROTOCORE_RPC_TIMEOUT,
        client
            .post(endpoint)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": [],
            }))
            .send(),
    )
    .await
    .map_err(|_| format!("{method} timed out"))?
    .map_err(|err| format!("{method} transport failed: {err}"))?;

    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|err| format!("{method} returned invalid JSON: {err}"))?;

    if !status.is_success() {
        return Err(format!("{method} returned HTTP {status}: {body}"));
    }
    if let Some(error) = body.get("error") {
        return Err(format!("{method} returned RPC error: {error}"));
    }
    body.get("result")
        .cloned()
        .ok_or_else(|| format!("{method} response missing result"))
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
        Ok(value) => match value.as_str() {
            Some(value) => probe.client_version = Some(value.to_string()),
            None => {
                probe.client_version_error =
                    Some("web3_clientVersion result was not a string".to_string())
            }
        },
        Err(err) => probe.client_version_error = Some(err),
    }

    match rpc_call(&client, endpoint, "eth_chainId").await {
        Ok(value) => match parse_rpc_u64(&value) {
            Some(value) => probe.chain_id = Some(value),
            None => {
                probe.chain_id_error = Some(format!("eth_chainId result was not numeric: {value}"))
            }
        },
        Err(err) => probe.chain_id_error = Some(err),
    }

    match rpc_call(&client, endpoint, "eth_blockNumber").await {
        Ok(value) => match parse_rpc_u64(&value) {
            Some(value) => probe.block_number = Some(value),
            None => {
                probe.block_number_error =
                    Some(format!("eth_blockNumber result was not numeric: {value}"))
            }
        },
        Err(err) => probe.block_number_error = Some(err),
    }

    match rpc_call(&client, endpoint, "eth_syncing").await {
        Ok(value) => match parse_rpc_syncing(&value) {
            Some(value) => probe.syncing = Some(value),
            None => {
                probe.syncing_error = Some(format!(
                    "eth_syncing result was not boolean/object: {value}"
                ))
            }
        },
        Err(err) => probe.syncing_error = Some(err),
    }

    match rpc_call(&client, endpoint, "net_listening").await {
        Ok(value) => match parse_rpc_bool(&value) {
            Some(value) => probe.listening = Some(value),
            None => {
                probe.listening_error =
                    Some(format!("net_listening result was not boolean: {value}"))
            }
        },
        Err(err) => probe.listening_error = Some(err),
    }

    probe
}

fn readiness_check(name: &str, state: &str, message: impl Into<String>) -> TalosReadinessCheck {
    TalosReadinessCheck {
        name: name.to_string(),
        state: state.to_string(),
        message: message.into(),
    }
}

fn classify_protocore_readiness(
    service: Option<TalosServiceInfo>,
    rpc_endpoint: String,
    rpc: ProtocoreRpcProbe,
) -> ProtocoreReadiness {
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

    let service_state = service
        .as_ref()
        .map(|service| service.display_state.as_str())
        .unwrap_or("waiting-for-config");
    let rpc_has_chain = rpc.chain_id.is_some() && rpc.block_number.is_some();
    let rpc_serving = rpc_has_chain && rpc.syncing != Some(true);
    let p2p_degraded = rpc.listening == Some(false);

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
        _ if rpc_serving && p2p_degraded => (
            "serving-rpc",
            "warn",
            format!(
                "Protocore RPC is serving chain_id {} at block {}, but P2P listening is false",
                rpc.chain_id.unwrap_or_default(),
                rpc.block_number.unwrap_or_default()
            ),
        ),
        _ if rpc_serving => (
            "serving-rpc",
            "ok",
            format!(
                "Protocore RPC is serving chain_id {} at block {}",
                rpc.chain_id.unwrap_or_default(),
                rpc.block_number.unwrap_or_default()
            ),
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

#[tauri::command]
pub async fn talos_connect(
    state: State<'_, TalosState>,
    endpoint: String,
    config_path: String,
) -> Result<TalosStatus, String> {
    let endpoint = endpoint_url(&endpoint).map_err(|e| e.to_string())?;
    let config_path = validate_config_path(&config_path).map_err(|e| e.to_string())?;

    keychain::store_credential(TALOS_ENDPOINT_ACCOUNT, &endpoint).map_err(|e| e.to_string())?;
    keychain::store_credential(TALOS_CONFIG_PATH_ACCOUNT, &config_path)
        .map_err(|e| e.to_string())?;

    {
        let mut guard = state.lock().await;
        for (_, stream) in guard.log_streams.drain() {
            stream.abort.abort();
        }
        guard.endpoint = Some(endpoint);
        guard.config_path = Some(config_path);
    }

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
    let response = timeout(
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
    .map_err(|_| TalosError::Timeout.to_string())?
    .map_err(|e| e.to_string())?
    .into_inner();

    let stage_arg = if stage { " --stage" } else { "" };
    let reboot_arg = match reboot_mode {
        TalosRebootMode::Default => "",
        TalosRebootMode::Powercycle => " --reboot-mode powercycle",
    };

    Ok(TalosTextResult {
        node_address: node_address(&endpoint),
        endpoint,
        command: format!("talos upgrade --image {image} --preserve{stage_arg}{reboot_arg}"),
        output: format_upgrade_response(response),
        service: None,
    })
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
            .logs(machine::LogsRequest {
                namespace: String::new(),
                id: service.clone(),
                driver: common::ContainerDriver::Containerd as i32,
                follow: false,
                tail_lines: line_count,
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
        client.logs(machine::LogsRequest {
            namespace: String::new(),
            id: service.clone(),
            driver: common::ContainerDriver::Containerd as i32,
            follow: true,
            tail_lines: line_count,
        }),
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

#[cfg(test)]
mod tests {
    use super::{
        backup_paths, classify_protocore_readiness, endpoint_url, enforce_privileged_control_plane,
        format_fingerprint, node_address, parse_reboot_mode, parse_rpc_u64, parse_service_action,
        parse_u64_string, protocore_rpc_endpoint, sanitize_backup_component,
        service_allows_offline_backup, summarize_service_state, validate_service_name,
        validate_upgrade_image, ProtocoreRpcProbe, TalosCertificateInfo, TalosConfigInfo,
        TalosLineBuffer, TalosRebootMode, TalosServiceInfo,
    };
    use serde_json::json;

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
