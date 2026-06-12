//! Maintenance-mode Talos bridge for in-app node provisioning.
//!
//! A freshly flashed Monarch OS node boots Talos straight into *maintenance
//! mode*: the gRPC API on `:50000` answers with a self-signed certificate and
//! does **not** require a client certificate, because the cluster PKI does not
//! exist yet. The trusted [`talos::TalosConnector`](crate::talos) path cannot
//! talk to such a node — it hard-requires a CA, client cert and key. This
//! module builds the insecure channel by hand and exposes three commands the
//! Setup wizard uses to detect, inspect, and provision a node:
//!
//!   * [`talos_maintenance_probe`] — unauthenticated `Version` call; a success
//!     means the node is reachable and in maintenance mode.
//!   * [`talos_maintenance_disks`] — `StorageService.Disks` enumeration to back
//!     the install-disk picker (falls back to manual entry when unavailable).
//!   * [`talos_maintenance_apply`] — `MachineService.ApplyConfiguration`, with
//!     an in-app reject scan that mirrors the protocore entrypoint so a bad
//!     config is refused before it can brick the node.
//!
//! # Trust boundary
//!
//! The accept-any-server-cert verifier ([`AcceptAnyServerCert`]) lives **only**
//! here and is never imported by `talos.rs`. The trusted mTLS connector keeps
//! its CA-pin / privileged-control-plane checks untouched. Maintenance-mode
//! safety comes from explicit operator confirmation, a mandatory dry run, disk
//! validation, and the config reject scan — not from certificate trust, which
//! does not exist on a node that has never been provisioned.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use talos_rust_client::generated::{google, machine, storage};
use talos_rust_client::{MachineServiceClient, StorageServiceClient};
use tokio::net::TcpStream;
use tokio::time::timeout;
// tonic is not a direct dependency; it is re-exported by talos-rust-client so
// the maintenance channel uses the exact same tonic the generated clients were
// built against.
use talos_rust_client::tonic;
use tonic::transport::{Channel, Endpoint, Uri};

use rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};

use crate::talos::{disk_type_label, endpoint_url, node_address, TalosTextResult};

/// Short ceiling for the unauthenticated handshake + RPC. A fresh node either
/// answers quickly or is unreachable; we never want the wizard to hang.
const MAINTENANCE_TIMEOUT: Duration = Duration::from_secs(5);

/// The apply call can take longer than a probe (the node validates and, for a
/// committing apply, writes config and schedules a reboot).
const APPLY_TIMEOUT: Duration = Duration::from_secs(30);

/// Refuse machine configs above this size; a Monarch full-node config is a few
/// kilobytes. A multi-megabyte blob is a mistake, not a config.
const MAX_CONFIG_BYTES: usize = 512 * 1024;

// ---------------------------------------------------------------------------
// Wire shapes returned to the frontend.
// ---------------------------------------------------------------------------

/// Result of an unauthenticated probe against the Talos maintenance API.
///
/// `maintenance: true` is inferred from a successful unauthenticated `Version`
/// response — a provisioned node enforcing mTLS would refuse the no-client-cert
/// call. A connection error yields `reachable: false` with the cause in
/// `error`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceProbe {
    pub reachable: bool,
    pub maintenance: bool,
    pub talos_version: Option<String>,
    pub error: Option<String>,
}

/// A single disk reported by the node, normalised for the install-disk picker.
///
/// `device_name` is normalised to an absolute path (`/dev/sda`) because the
/// Talos proto reports the bare kernel name (`sda`) while the machine-config
/// `install.disk` field and the frontend validator both use the `/dev/` form.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TalosDisk {
    pub device_name: String,
    pub model: String,
    pub size_bytes: u64,
    pub size_human: String,
    pub disk_type: String,
    pub readonly: bool,
    pub system_disk_hint: bool,
}

// ---------------------------------------------------------------------------
// Insecure channel.
// ---------------------------------------------------------------------------

/// rustls verifier that accepts any server certificate and any handshake
/// signature. This is the `--insecure` semantics talosctl uses against a
/// maintenance-mode node: there is no CA to pin a self-signed cert against yet.
///
/// Confined to this module by design — see the module-level trust-boundary
/// note. Never construct or reference this from the trusted `talos.rs` path.
#[derive(Debug)]
struct AcceptAnyServerCert {
    /// Borrowed from the ring provider so the reported scheme list matches the
    /// algorithms we can actually verify with, rather than a hand-maintained
    /// constant that could drift from the crypto provider.
    schemes: Vec<SignatureScheme>,
}

impl AcceptAnyServerCert {
    fn new() -> Self {
        Self {
            schemes: rustls::crypto::ring::default_provider()
                .signature_verification_algorithms
                .supported_schemes(),
        }
    }
}

impl ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.schemes.clone()
    }
}

/// Build the rustls client config for the maintenance channel: accept any
/// server cert, present no client identity, advertise HTTP/2 over ALPN (gRPC
/// requires h2).
fn insecure_rustls_config() -> ClientConfig {
    let mut config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert::new()))
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec()];
    config
}

/// Open an insecure tonic [`Channel`] to a node's maintenance API.
///
/// tonic 0.12 exposes no way to inject a custom rustls verifier through
/// `ClientTlsConfig`, so the TLS layer is hand-rolled: a [`tower::Service`]
/// (`MaintenanceConnector`) dials TCP, performs a tokio-rustls handshake with
/// [`insecure_rustls_config`], and hands tonic the resulting stream wrapped in
/// [`hyper_util::rt::TokioIo`] (the adapter tonic's connector contract
/// expects). `Endpoint::connect_with_connector` drives the HTTP/2 client over
/// it.
async fn maintenance_channel(host: &str) -> Result<Channel, String> {
    let url = endpoint_url(host).map_err(|e| e.to_string())?;

    let tls = Arc::new(insecure_rustls_config());
    let connector = MaintenanceConnector { tls };

    let endpoint = Endpoint::from_shared(url.clone())
        .map_err(|e| format!("invalid maintenance endpoint {url}: {e}"))?
        .connect_timeout(MAINTENANCE_TIMEOUT);

    timeout(MAINTENANCE_TIMEOUT, endpoint.connect_with_connector(connector))
        .await
        .map_err(|_| format!("timed out connecting to {url}"))?
        .map_err(|e| format!("failed to connect to {url}: {e}"))
}

/// tower connector that produces an insecure (accept-any-cert, no client
/// identity) TLS stream tonic can run HTTP/2 over.
#[derive(Clone)]
struct MaintenanceConnector {
    tls: Arc<ClientConfig>,
}

impl tower::Service<Uri> for MaintenanceConnector {
    type Response = hyper_util::rt::TokioIo<
        tokio_rustls::client::TlsStream<TcpStream>,
    >;
    type Error = std::io::Error;
    type Future = std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<Self::Response, Self::Error>>
                + Send,
        >,
    >;

    fn poll_ready(
        &mut self,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        let tls = self.tls.clone();
        Box::pin(async move {
            let host = uri.host().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "maintenance endpoint has no host",
                )
            })?;
            let port = uri.port_u16().unwrap_or(50000);

            // Talos serves a self-signed cert that does not carry the node's IP
            // as a SAN, and we accept any cert anyway — but rustls still needs a
            // syntactically valid ServerName for SNI/handshake. A bare IP host
            // is wrapped as an IpAddress; anything else is treated as a DNS
            // name.
            let server_name = ServerName::try_from(host.to_string()).map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("invalid server name: {host}"),
                )
            })?;

            let tcp = TcpStream::connect((host, port)).await?;
            tcp.set_nodelay(true).ok();

            let connector = tokio_rustls::TlsConnector::from(tls);
            let stream = connector.connect(server_name, tcp).await?;
            Ok(hyper_util::rt::TokioIo::new(stream))
        })
    }
}

// ---------------------------------------------------------------------------
// Core logic (shared by the Tauri commands and the example binary).
// ---------------------------------------------------------------------------

/// Probe a node's maintenance API. Never returns `Err`: a connection failure is
/// reported as `reachable: false` with the cause, so the frontend can branch on
/// the structured result rather than parsing an error string.
pub async fn probe(host: &str) -> MaintenanceProbe {
    let channel = match maintenance_channel(host).await {
        Ok(channel) => channel,
        Err(error) => {
            return MaintenanceProbe {
                reachable: false,
                maintenance: false,
                talos_version: None,
                error: Some(error),
            };
        }
    };

    let mut client = MachineServiceClient::new(channel);
    match timeout(MAINTENANCE_TIMEOUT, client.version(google::protobuf::Empty {})).await {
        Ok(Ok(response)) => {
            let talos_version = response
                .into_inner()
                .messages
                .into_iter()
                .find_map(|msg| msg.version)
                .map(|info| {
                    if info.tag.trim().is_empty() {
                        "unknown".to_string()
                    } else {
                        info.tag
                    }
                });
            MaintenanceProbe {
                reachable: true,
                maintenance: true,
                talos_version,
                error: None,
            }
        }
        Ok(Err(status)) => MaintenanceProbe {
            // The TLS handshake and TCP connect succeeded (we hold a channel),
            // but the unauthenticated Version RPC was rejected. That is what a
            // provisioned, mTLS-enforcing node does — reachable, not in
            // maintenance mode.
            reachable: true,
            maintenance: false,
            talos_version: None,
            error: Some(format!("Version RPC rejected: {}", status.message())),
        },
        Err(_) => MaintenanceProbe {
            reachable: false,
            maintenance: false,
            talos_version: None,
            error: Some("timed out waiting for Version response".to_string()),
        },
    }
}

/// Enumerate the node's disks over the insecure channel.
///
/// `StorageService` is not always served pre-config in maintenance mode; an
/// `Err` here is expected on some Talos versions and the frontend falls back to
/// manual disk entry. We never panic.
pub async fn disks(host: &str) -> Result<Vec<TalosDisk>, String> {
    let channel = maintenance_channel(host).await?;
    let mut client = StorageServiceClient::new(channel);

    let response = timeout(MAINTENANCE_TIMEOUT, client.disks(google::protobuf::Empty {}))
        .await
        .map_err(|_| "timed out waiting for disk enumeration".to_string())?
        .map_err(|status| {
            format!(
                "disk enumeration not available in maintenance mode: {}",
                status.message()
            )
        })?
        .into_inner();

    let disks = response
        .messages
        .into_iter()
        .flat_map(|message| message.disks)
        .map(map_disk)
        .collect();
    Ok(disks)
}

fn map_disk(disk: storage::Disk) -> TalosDisk {
    TalosDisk {
        device_name: normalise_device(&disk.device_name),
        model: disk.model,
        size_human: humanize_bytes(disk.size),
        size_bytes: disk.size,
        disk_type: disk_type_label(disk.r#type),
        readonly: disk.readonly,
        system_disk_hint: disk.system_disk,
    }
}

/// Normalise a disk identifier to the `/dev/<name>` form used by the
/// machine-config `install.disk` field. The Talos proto reports bare names
/// (`sda`); pass through anything that is already an absolute path.
fn normalise_device(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        return name.to_string();
    }
    if name.starts_with('/') {
        name.to_string()
    } else {
        format!("/dev/{name}")
    }
}

fn humanize_bytes(bytes: u64) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    if bytes == 0 {
        return "0 B".to_string();
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// Apply a machine config over the insecure channel.
///
/// Runs the in-app reject scan ([`scan_config`]) before transmitting, maps the
/// `mode` string to the proto enum, and returns the node's own
/// warnings/messages verbatim. The config YAML is never logged (it may, in a
/// future operator path, carry sensitive material).
pub async fn apply(
    host: &str,
    config_yaml: &str,
    dry_run: bool,
    mode: &str,
) -> Result<TalosTextResult, String> {
    if config_yaml.trim().is_empty() {
        return Err("machine config is empty".to_string());
    }
    if config_yaml.len() > MAX_CONFIG_BYTES {
        return Err(format!(
            "machine config is {} bytes; refusing anything over {} bytes",
            config_yaml.len(),
            MAX_CONFIG_BYTES
        ));
    }
    scan_config(config_yaml)?;

    let mode_enum = parse_mode(mode);

    let url = endpoint_url(host).map_err(|e| e.to_string())?;
    let channel = maintenance_channel(host).await?;
    let mut client = MachineServiceClient::new(channel);

    let request = machine::ApplyConfigurationRequest {
        data: config_yaml.as_bytes().to_vec(),
        mode: mode_enum as i32,
        dry_run,
        try_mode_timeout: None,
    };

    let response = timeout(APPLY_TIMEOUT, client.apply_configuration(request))
        .await
        .map_err(|_| "timed out waiting for apply-configuration response".to_string())?
        .map_err(|status| format!("apply rejected: {}", status.message()))?
        .into_inner();

    let mode_label = mode_label(mode_enum);
    let run_label = if dry_run { "dry-run" } else { "commit" };
    Ok(TalosTextResult {
        node_address: node_address(&url),
        endpoint: url,
        command: format!("talos apply-config --insecure --mode {mode_label} ({run_label})"),
        output: format_apply_response(&response, dry_run),
        service: None,
    })
}

fn parse_mode(mode: &str) -> machine::apply_configuration_request::Mode {
    use machine::apply_configuration_request::Mode;
    match mode.trim().to_ascii_lowercase().as_str() {
        "auto" => Mode::Auto,
        "try" => Mode::Try,
        "no-reboot" | "noreboot" => Mode::NoReboot,
        "staged" => Mode::Staged,
        _ => Mode::Reboot,
    }
}

fn mode_label(mode: machine::apply_configuration_request::Mode) -> &'static str {
    use machine::apply_configuration_request::Mode;
    match mode {
        Mode::Reboot => "reboot",
        Mode::Auto => "auto",
        Mode::NoReboot => "no-reboot",
        Mode::Staged => "staged",
        Mode::Try => "try",
    }
}

fn format_apply_response(
    response: &machine::ApplyConfigurationResponse,
    dry_run: bool,
) -> String {
    let mut lines = Vec::new();
    for message in &response.messages {
        let applied = mode_label(
            machine::apply_configuration_request::Mode::try_from(message.mode)
                .unwrap_or(machine::apply_configuration_request::Mode::Reboot),
        );
        let detail = if message.mode_details.trim().is_empty() {
            format!("mode applied: {applied}")
        } else {
            format!("mode applied: {applied} — {}", message.mode_details.trim())
        };
        lines.push(detail);
        for warning in &message.warnings {
            lines.push(format!("warning: {}", warning.trim()));
        }
    }

    if lines.is_empty() {
        lines.push(if dry_run {
            "dry-run accepted; no validation warnings reported".to_string()
        } else {
            "configuration accepted".to_string()
        });
    }

    if dry_run {
        lines.push("dry-run only — nothing was written to the node".to_string());
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Config reject scan.
// ---------------------------------------------------------------------------

/// Inline-secret env keys that must never be carried in a machine config; they
/// belong in enrollment/secret files. Mirrors the protocore entrypoint reject
/// list. `_SHARE` suffixes (BLS / cluster-key / key shares) are matched
/// separately by suffix so future share keys are also caught.
const FORBIDDEN_SECRET_ENVS: [&str; 3] = [
    "PROTOCORE_KEYSTORE_PASSPHRASE",
    "PROTOCORE_OPERATOR_MNEMONIC",
    "PROTOCORE_OPERATOR_PRIVATE_KEY",
];

/// Unfilled-placeholder markers. Mirrors the entrypoint's `is_placeholder_value`
/// check so a template that was never filled in is refused in-app rather than
/// boot-looping the node.
const PLACEHOLDER_MARKERS: [&str; 5] = [
    "<",
    "replace-with",
    "changeme",
    "placeholder",
    "example-secret",
];

/// Refuse a config that carries inline secrets, unfilled placeholders, or the
/// full-node-with-enrollment trap before it reaches the node.
fn scan_config(config_yaml: &str) -> Result<(), String> {
    let lower = config_yaml.to_ascii_lowercase();

    for marker in PLACEHOLDER_MARKERS {
        if lower.contains(marker) {
            return Err(format!(
                "config contains an unfilled placeholder ('{marker}'); fill it in before applying"
            ));
        }
    }

    for secret in FORBIDDEN_SECRET_ENVS {
        if lower.contains(&secret.to_ascii_lowercase()) {
            return Err(format!(
                "config carries inline secret material ({secret}); use an enrollment/secret file path instead"
            ));
        }
    }

    // Any `*_SHARE` env (PROTOCORE_BLS_SHARE / PROTOCORE_CLUSTER_KEY_SHARE /
    // PROTOCORE_KEY_SHARE / …) is share material and must never be inlined.
    for token in config_yaml.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
        let upper = token.to_ascii_uppercase();
        if upper.starts_with("PROTOCORE_") && upper.ends_with("_SHARE") {
            return Err(format!(
                "config carries inline share material ({token}); use an enrollment/secret file path instead"
            ));
        }
    }

    // The shipped-example trap: a full (non-signing) node that also demands
    // enrollment will fail closed and never serve RPC.
    let requires_enrollment = env_flag_true(config_yaml, "PROTOCORE_REQUIRE_ENROLLMENT");
    let node_mode_full = env_value(config_yaml, "PROTOCORE_NODE_MODE")
        .map(|v| v.eq_ignore_ascii_case("full"))
        .unwrap_or(false);
    if node_mode_full && requires_enrollment {
        return Err(
            "PROTOCORE_NODE_MODE=full together with PROTOCORE_REQUIRE_ENROLLMENT=true \
             fails closed (a full node carries no enrollment material); drop the \
             enrollment requirement for a full node"
                .to_string(),
        );
    }

    Ok(())
}

/// Read the value of a `KEY=value` env entry from the YAML/text, ignoring quotes
/// and surrounding whitespace. Returns the first match. This is a deliberately
/// simple scan over the raw text — it does not parse YAML structure, only spots
/// the `KEY=VALUE` tokens that ExtensionServiceConfig env entries take.
fn env_value(config_yaml: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=");
    for line in config_yaml.lines() {
        let trimmed = line.trim().trim_start_matches('-').trim();
        let trimmed = trimmed.trim_matches('"').trim_matches('\'');
        if let Some(rest) = trimmed.strip_prefix(&needle) {
            return Some(rest.trim().trim_matches('"').trim_matches('\'').to_string());
        }
    }
    None
}

fn env_flag_true(config_yaml: &str, key: &str) -> bool {
    env_value(config_yaml, key)
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "true" || v == "1" || v == "yes"
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Tauri commands.
// ---------------------------------------------------------------------------

/// Detect whether a node is reachable and in maintenance mode.
#[tauri::command]
pub async fn talos_maintenance_probe(host: String) -> MaintenanceProbe {
    probe(&host).await
}

/// Enumerate the node's disks for the install-disk picker. `Err` ⇒ the frontend
/// falls back to manual disk entry.
#[tauri::command]
pub async fn talos_maintenance_disks(host: String) -> Result<Vec<TalosDisk>, String> {
    disks(&host).await
}

/// Apply a machine config (dry-run or commit) over the insecure channel.
#[tauri::command]
pub async fn talos_maintenance_apply(
    host: String,
    config_yaml: String,
    dry_run: bool,
    mode: String,
) -> Result<TalosTextResult, String> {
    apply(&host, &config_yaml, dry_run, &mode).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalise_device_adds_dev_prefix() {
        assert_eq!(normalise_device("sda"), "/dev/sda");
        assert_eq!(normalise_device("/dev/vda"), "/dev/vda");
        assert_eq!(normalise_device("nvme0n1"), "/dev/nvme0n1");
        assert_eq!(normalise_device(""), "");
    }

    #[test]
    fn humanize_bytes_scales() {
        assert_eq!(humanize_bytes(0), "0 B");
        assert_eq!(humanize_bytes(512), "512 B");
        assert_eq!(humanize_bytes(2048), "2.0 KB");
        assert_eq!(humanize_bytes(500 * 1024 * 1024 * 1024), "500.0 GB");
    }

    #[test]
    fn parse_mode_defaults_to_reboot() {
        use machine::apply_configuration_request::Mode;
        assert_eq!(parse_mode("reboot"), Mode::Reboot);
        assert_eq!(parse_mode("AUTO"), Mode::Auto);
        assert_eq!(parse_mode("try"), Mode::Try);
        assert_eq!(parse_mode("staged"), Mode::Staged);
        assert_eq!(parse_mode("no-reboot"), Mode::NoReboot);
        assert_eq!(parse_mode("bogus"), Mode::Reboot);
        assert_eq!(parse_mode(""), Mode::Reboot);
    }

    #[test]
    fn scan_accepts_a_clean_full_node_config() {
        let yaml = "\
version: v1alpha1
machine:
  type: controlplane
  install:
    disk: /dev/sda
---
apiVersion: v1alpha1
kind: ExtensionServiceConfig
name: protocore
environment:
  - PROTOCORE_NODE_MODE=full
  - PROTOCORE_RPC_LISTEN=0.0.0.0:8545
  - PROTOCORE_CHAIN_ID=69420
";
        assert!(scan_config(yaml).is_ok());
    }

    #[test]
    fn scan_rejects_inline_secret() {
        let yaml = "environment:\n  - PROTOCORE_KEYSTORE_PASSPHRASE=hunter2\n";
        let err = scan_config(yaml).unwrap_err();
        assert!(err.contains("PROTOCORE_KEYSTORE_PASSPHRASE"), "{err}");
    }

    #[test]
    fn scan_rejects_share_suffix() {
        let yaml = "environment:\n  - PROTOCORE_CLUSTER_KEY_SHARE=abc123\n";
        let err = scan_config(yaml).unwrap_err();
        assert!(err.to_lowercase().contains("share"), "{err}");
    }

    #[test]
    fn scan_rejects_placeholder() {
        let yaml = "environment:\n  - PROTOCORE_NODE_MODE=replace-with-mode\n";
        let err = scan_config(yaml).unwrap_err();
        assert!(err.contains("placeholder"), "{err}");
    }

    #[test]
    fn scan_rejects_angle_bracket_placeholder() {
        let yaml = "machine:\n  install:\n    disk: <disk>\n";
        let err = scan_config(yaml).unwrap_err();
        assert!(err.contains("placeholder"), "{err}");
    }

    #[test]
    fn scan_rejects_full_node_with_enrollment() {
        let yaml = "\
environment:
  - PROTOCORE_NODE_MODE=full
  - PROTOCORE_REQUIRE_ENROLLMENT=true
";
        let err = scan_config(yaml).unwrap_err();
        assert!(err.contains("fails closed"), "{err}");
    }

    #[test]
    fn scan_allows_operator_node_with_enrollment() {
        // Enrollment is fine when the node is NOT a full node.
        let yaml = "\
environment:
  - PROTOCORE_NODE_MODE=operator
  - PROTOCORE_REQUIRE_ENROLLMENT=true
";
        assert!(scan_config(yaml).is_ok());
    }
}
