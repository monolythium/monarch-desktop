//! Full-node machine-config + talosconfig generation for in-app provisioning.
//!
//! This is the `talosctl gen config` equivalent for a Monarch OS FULL node,
//! grounded in a reference config that was validated end-to-end on a live node
//! (ext-protocore Running, eth_chainId served, no `talosctl bootstrap`):
//!
//!   talosctl gen config monarch-node https://<host>:6443 \
//!     --install-disk <disk> --talos-version v1.13.0 --additional-sans <host> \
//!     --with-docs=false --with-examples=false --config-patch @protocore-patch.yaml
//!
//! Two production lessons are baked in here; do not "simplify" them away:
//!
//!   1. The machine config MUST carry the complete Talos cluster PKI
//!      (`cluster.id/secret/ca/aggregatorCA/etcd.ca/serviceAccount` + tokens).
//!      Talos's dry-run validator accepts a config without them, but at
//!      RUNTIME a controlplane node wedges on "missing cluster aggregatorCA
//!      secret" / "missing accepted Kubernetes CA". The dry run cannot catch
//!      this — only the full PKI shape below is known-good.
//!   2. The protocore ExtensionServiceConfig MUST set every enrollment/TPM
//!      *_FILE env to an EMPTY string. The OS image's embedded service config
//!      bakes file paths (e.g. PROTOCORE_EXPECTED_DIGEST_FILE=
//!      /var/lib/protocore/enrollment/protocore.sha256) and the entrypoint
//!      runs the digest check whenever that env is non-empty — independent of
//!      PROTOCORE_REQUIRE_ENROLLMENT. ExtensionServiceConfig env MERGES over
//!      the embedded env, so the only way to clear a baked path is an explicit
//!      `KEY=` empty value (the entrypoint treats empty as unset).
//!
//! Alongside the machine config, the generator mints a working talosconfig
//! (admin client cert signed by the freshly minted machine CA). Monarch OS has
//! no SSH — without this file a provisioned node is unmanageable forever, so
//! the talosconfig is a first-class output, persisted by the apply command.
//!
//! Every secret is generated fresh per call (OS CSPRNG); nothing here is ever
//! cached, shared between nodes, or copied from a reference config.

use base64::Engine as _;
use rand::RngCore as _;
use serde::Serialize;

/// Talos release the static template below is coupled to. The kubelet /
/// apiServer / controllerManager / proxy / scheduler image pins, the
/// `grubUseUKICmdline` install flag, and the features block all mirror what
/// `talosctl gen config` (v1.13.0) emits — revisit the whole template when
/// bumping this.
pub const TALOS_VERSION: &str = "v1.13.0";

/// Kubernetes version paired with [`TALOS_VERSION`] by talosctl v1.13.0.
pub const KUBERNETES_VERSION: &str = "v1.36.0";

/// Cluster name used for the (single-node) Talos cluster and the talosconfig
/// context, mirroring the validated reference.
pub const CLUSTER_NAME: &str = "monarch-node";

/// Chain the provision flow pins a fresh node to.
pub const PROVISION_CHAIN_ID: u32 = 69_420;

/// chain-registry network key a fresh node resolves genesis + peers from.
pub const PROVISION_REGISTRY_NETWORK: &str = "testnet-69420";

/// Installer image that `machine.install.image` MUST use — a Talos installer
/// baked WITH the protocore system extension, published by monarch-os-talos's
/// `build-installer` workflow to ghcr.
///
/// 🛑 Do NOT use the plain `ghcr.io/siderolabs/installer`: the ISO/raw bake the
/// extension for BOOT, but a maintenance-mode fresh install pulls THIS image to
/// write the system to disk. The plain installer has no extension, so the
/// installed node runs vanilla Talos — `ext-protocore` never registers and
/// `:8545` never serves. Pinned to the protocore release the chain runs; bump
/// alongside the OS/protocore version.
pub const MONARCH_OS_INSTALLER_IMAGE: &str =
    "ghcr.io/monolythium/monarch-os-installer:v0.1.51-testnet";

/// CA validity mirroring `talosctl gen secrets` (10 years).
const CA_VALIDITY_DAYS: i64 = 3650;

/// Admin client-cert validity. talosctl issues 1 year; we deliberately issue
/// 10 years instead: the app keeps no copy of the machine CA key after
/// provisioning and has no cert-renewal path yet, so a 1-year cert would leave
/// the node unmanageable after expiry (Monarch OS has no SSH fallback).
const ADMIN_CERT_VALIDITY_DAYS: i64 = 3650;

/// The image-baked enrollment/TPM file-path envs that must be cleared with an
/// explicit empty value (see the module docs). Order mirrors the validated
/// reference patch; the trailing `=` with no value is load-bearing.
pub const CLEARED_FILE_ENVS: [&str; 9] = [
    "PROTOCORE_EXPECTED_DIGEST_FILE",
    "PROTOCORE_ENROLLMENT_FILE",
    "PROTOCORE_TPM_QUOTE_FILE",
    "PROTOCORE_TPM_EVENT_LOG_FILE",
    "PROTOCORE_TPM_SEALED_OPERATOR_KEY_FILE",
    "PROTOCORE_TPM_SEALED_BLS_SHARE_FILE",
    "PROTOCORE_KEY_TRANSCRIPT_FILE",
    "PROTOCORE_DKG_TRANSCRIPT_FILE",
    "PROTOCORE_LYTHIUMSEAL_OPERATOR_KEY_FILE",
];

/// The generated provisioning bundle: the 3-document machine config to apply,
/// and the talosconfig that can manage the node afterwards.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullNodeConfig {
    /// 3-document Talos YAML: machine+cluster doc, HostnameConfig doc,
    /// protocore ExtensionServiceConfig doc.
    pub config_yaml: String,
    /// talosconfig with an admin client cert signed by the node's machine CA.
    /// The ONLY management credential for the node — must be persisted.
    pub talosconfig_yaml: String,
}

// ---------------------------------------------------------------------------
// Input validation.
// ---------------------------------------------------------------------------

/// Validate the node host (bare hostname or IPv4 — what the maintenance flow
/// dials). The host is spliced into YAML scalars and a `https://{host}:6443`
/// URL, so anything that could break either is refused. IPv6 literals are not
/// supported by this generator (they would need URL bracketing).
fn validate_host(host: &str) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("a node host is required".to_string());
    }
    if host.len() > 253 {
        return Err("node host is too long".to_string());
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(format!(
            "invalid node host \"{host}\" — use a bare hostname or IPv4 address \
             (no scheme, port, or IPv6 literal)"
        ));
    }
    if host.starts_with('-') || host.starts_with('.') || host.contains("..") {
        return Err(format!("invalid node host \"{host}\""));
    }
    Ok(host.to_string())
}

/// Validate the install disk. Must be an absolute `/dev/...` path; the picker
/// and manual entry both normalise to that form before calling.
fn validate_disk(disk: &str) -> Result<String, String> {
    let disk = disk.trim();
    if disk.is_empty() {
        return Err("an install disk is required".to_string());
    }
    let Some(rest) = disk.strip_prefix("/dev/") else {
        return Err(format!(
            "invalid install disk \"{disk}\" — expected an absolute /dev/... path"
        ));
    };
    if rest.is_empty()
        || disk.contains("..")
        || disk.ends_with('/')
        || !rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-'))
    {
        return Err(format!("invalid install disk \"{disk}\""));
    }
    Ok(disk.to_string())
}

// ---------------------------------------------------------------------------
// Secret minting.
// ---------------------------------------------------------------------------

/// Mint a Talos bootstrap token: `<6 lowercase-alnum>.<16 lowercase-alnum>`,
/// the kubeadm-style shape Talos expects for `machine.token` and
/// `cluster.token`. Drawn from the OS CSPRNG.
pub(crate) fn generate_talos_token() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::rng();
    let mut bytes = [0u8; 22];
    rng.fill_bytes(&mut bytes);
    let glyph = |b: u8| ALPHABET[(b as usize) % ALPHABET.len()] as char;
    let id: String = bytes[..6].iter().map(|&b| glyph(b)).collect();
    let secret: String = bytes[6..22].iter().map(|&b| glyph(b)).collect();
    format!("{id}.{secret}")
}

/// 32 fresh CSPRNG bytes encoded with the given engine. talosctl encodes
/// `cluster.id` URL-safe and `cluster.secret`/`secretboxEncryptionSecret`
/// standard — both shapes are mirrored by the callers.
fn random_32_b64<E: base64::Engine>(engine: &E) -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    engine.encode(bytes)
}

/// Wrap DER in a PEM block with an explicit label. Talos's Go side switches on
/// the PEM block TYPE (e.g. `ED25519 PRIVATE KEY`, `EC PRIVATE KEY`), so the
/// labels must match what talosctl emits — rcgen's generic `PRIVATE KEY`
/// (PKCS#8) label is not in that switch.
fn pem_wrap(label: &str, der: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        // chunks of an ASCII string are valid UTF-8 by construction.
        out.push_str(std::str::from_utf8(chunk).expect("base64 is ASCII"));
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

/// A freshly minted CA: the base64-of-PEM values the YAML carries, plus the
/// in-memory cert/key for signing child certificates.
struct GeneratedCa {
    crt_b64: String,
    key_b64: String,
    cert: rcgen::Certificate,
    key_pair: rcgen::KeyPair,
}

/// Shared CA parameter shape mirroring `talosctl gen secrets`: critical
/// KeyUsage {DigitalSignature, CertSign}, EKU {ServerAuth, ClientAuth},
/// critical BasicConstraints CA:TRUE, 10-year validity.
fn ca_params(org: Option<&str>) -> rcgen::CertificateParams {
    use rcgen::{
        BasicConstraints, CertificateParams, DistinguishedName, DnType,
        ExtendedKeyUsagePurpose, IsCa, KeyUsagePurpose,
    };
    let mut params = CertificateParams::default();
    params.distinguished_name = DistinguishedName::new();
    if let Some(org) = org {
        params.distinguished_name.push(DnType::OrganizationName, org);
    }
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyCertSign,
    ];
    params.extended_key_usages = vec![
        ExtendedKeyUsagePurpose::ServerAuth,
        ExtendedKeyUsagePurpose::ClientAuth,
    ];
    let now = time::OffsetDateTime::now_utc();
    params.not_before = now;
    params.not_after = now + time::Duration::days(CA_VALIDITY_DAYS);
    params
}

/// Mint the node's Talos machine CA: self-signed Ed25519, `O=talos`. The key
/// is PEM-labelled `ED25519 PRIVATE KEY` (PKCS#8 DER inside) exactly as
/// talosctl writes it.
fn generate_machine_ca() -> Result<GeneratedCa, String> {
    let key_pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519)
        .map_err(|e| format!("failed to generate machine CA key: {e}"))?;
    let cert = ca_params(Some("talos"))
        .self_signed(&key_pair)
        .map_err(|e| format!("failed to self-sign machine CA: {e}"))?;
    Ok(GeneratedCa {
        crt_b64: b64(&cert.pem()),
        key_b64: b64(&pem_wrap("ED25519 PRIVATE KEY", &key_pair.serialize_der())),
        cert,
        key_pair,
    })
}

/// Mint one of the Kubernetes-side CAs: self-signed ECDSA P-256.
/// `org = None` produces the empty-subject aggregator CA. The key is
/// re-encoded to the SEC1 `EC PRIVATE KEY` PEM talosctl emits.
fn generate_ecdsa_ca(org: Option<&str>) -> Result<GeneratedCa, String> {
    let key_pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)
        .map_err(|e| format!("failed to generate P-256 CA key: {e}"))?;
    let cert = ca_params(org)
        .self_signed(&key_pair)
        .map_err(|e| format!("failed to self-sign P-256 CA: {e}"))?;
    let sec1_pem = ecdsa_key_to_sec1_pem(&key_pair)?;
    Ok(GeneratedCa {
        crt_b64: b64(&cert.pem()),
        key_b64: b64(&sec1_pem),
        cert,
        key_pair,
    })
}

/// Encode an rcgen P-256 key as the SEC1 `EC PRIVATE KEY` PEM talosctl emits —
/// crucially WITH the `[0]` named-curve parameters (prime256v1) present.
///
/// p256's own `SecretKey::to_sec1_pem()` sets that optional field to `None`.
/// A bare SEC1 key with no curve OID parses fine in OpenSSL but makes Go's
/// `x509.ParseECPrivateKey` (hence Talos, which is Go) fail with
/// "x509: unknown elliptic curve" — `etcd`/the Kubernetes controllers then
/// wedge and `ext-protocore` never reaches serving state. We rebuild the
/// `EcPrivateKey` structure by hand with the OID included.
fn ecdsa_key_to_sec1_pem(key_pair: &rcgen::KeyPair) -> Result<String, String> {
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use p256::pkcs8::DecodePrivateKey;
    use sec1::der::{asn1::ObjectIdentifier, pem::LineEnding, EncodePem};
    use sec1::{EcParameters, EcPrivateKey};

    // prime256v1 / NIST P-256.
    const P256_OID: ObjectIdentifier =
        ObjectIdentifier::new_unwrap("1.2.840.10045.3.1.7");

    let secret = p256::SecretKey::from_pkcs8_der(&key_pair.serialize_der())
        .map_err(|e| format!("failed to re-parse P-256 CA key: {e}"))?;
    let scalar = secret.to_bytes();
    let public_point = secret.public_key().to_encoded_point(false);
    let ec_key = EcPrivateKey {
        private_key: scalar.as_slice(),
        parameters: Some(EcParameters::NamedCurve(P256_OID)),
        public_key: Some(public_point.as_bytes()),
    };
    ec_key
        .to_pem(LineEnding::LF)
        .map_err(|e| format!("failed to encode P-256 CA key as SEC1: {e}"))
}

/// Mint the Kubernetes service-account signing key: RSA-4096, PKCS#1 PEM —
/// the exact shape talosctl emits. RSA-4096 keygen is CPU-heavy (seconds);
/// callers run the whole generation off the main thread.
fn generate_service_account_key() -> Result<String, String> {
    use rsa::pkcs1::EncodeRsaPrivateKey;

    let key = rsa::RsaPrivateKey::new(&mut rand_core06::OsRng, 4096)
        .map_err(|e| format!("failed to generate service-account RSA key: {e}"))?;
    let pem = key
        .to_pkcs1_pem(p256::pkcs8::LineEnding::LF)
        .map_err(|e| format!("failed to encode service-account key: {e}"))?;
    Ok(b64(&pem))
}

/// Issue the talosconfig admin client cert: Ed25519, `O=os:admin` (the Talos
/// admin role), critical KeyUsage DigitalSignature, EKU ClientAuth, AKI of the
/// machine CA — mirroring the talosctl-issued admin cert. Validity is 10y
/// instead of talosctl's 1y (see [`ADMIN_CERT_VALIDITY_DAYS`]).
fn generate_admin_client(
    machine_ca: &GeneratedCa,
) -> Result<(String, String), String> {
    use rcgen::{
        CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose,
        KeyUsagePurpose,
    };

    let key_pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519)
        .map_err(|e| format!("failed to generate admin client key: {e}"))?;
    let mut params = CertificateParams::default();
    params.distinguished_name = DistinguishedName::new();
    params
        .distinguished_name
        .push(DnType::OrganizationName, "os:admin");
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    params.use_authority_key_identifier_extension = true;
    let now = time::OffsetDateTime::now_utc();
    params.not_before = now;
    params.not_after = now + time::Duration::days(ADMIN_CERT_VALIDITY_DAYS);

    let cert = params
        .signed_by(&key_pair, &machine_ca.cert, &machine_ca.key_pair)
        .map_err(|e| format!("failed to issue admin client cert: {e}"))?;
    Ok((
        b64(&cert.pem()),
        b64(&pem_wrap("ED25519 PRIVATE KEY", &key_pair.serialize_der())),
    ))
}

// ---------------------------------------------------------------------------
// Generation.
// ---------------------------------------------------------------------------

/// Generate the full provisioning bundle for one node: the 3-document machine
/// config (complete cluster PKI + protocore env) and the matching talosconfig.
///
/// Pure CPU work + OS CSPRNG; no network, no filesystem. RSA-4096 keygen makes
/// it take a few seconds — run it on a blocking thread (the Tauri command
/// does). Every call mints a fresh, unique identity.
pub fn generate_full_node_config(host: &str, disk: &str) -> Result<FullNodeConfig, String> {
    let host = validate_host(host)?;
    let disk = validate_disk(disk)?;

    let machine_ca = generate_machine_ca()?;
    let k8s_ca = generate_ecdsa_ca(Some("kubernetes"))?;
    // The aggregator (front-proxy) CA is issued with an EMPTY subject by
    // talosctl; mirrored here.
    let aggregator_ca = generate_ecdsa_ca(None)?;
    let etcd_ca = generate_ecdsa_ca(Some("etcd"))?;
    let service_account_key = generate_service_account_key()?;
    let (admin_crt, admin_key) = generate_admin_client(&machine_ca)?;

    let machine_token = generate_talos_token();
    let cluster_token = generate_talos_token();
    let cluster_id = random_32_b64(&base64::engine::general_purpose::URL_SAFE);
    let cluster_secret = random_32_b64(&base64::engine::general_purpose::STANDARD);
    let secretbox_secret = random_32_b64(&base64::engine::general_purpose::STANDARD);

    let config_yaml = render_config_yaml(&RenderInputs {
        host: &host,
        disk: &disk,
        machine_token: &machine_token,
        machine_ca_crt: &machine_ca.crt_b64,
        machine_ca_key: &machine_ca.key_b64,
        cluster_id: &cluster_id,
        cluster_secret: &cluster_secret,
        cluster_token: &cluster_token,
        secretbox_secret: &secretbox_secret,
        k8s_ca_crt: &k8s_ca.crt_b64,
        k8s_ca_key: &k8s_ca.key_b64,
        aggregator_ca_crt: &aggregator_ca.crt_b64,
        aggregator_ca_key: &aggregator_ca.key_b64,
        service_account_key: &service_account_key,
        etcd_ca_crt: &etcd_ca.crt_b64,
        etcd_ca_key: &etcd_ca.key_b64,
    });

    let talosconfig_yaml = format!(
        "context: {CLUSTER_NAME}
contexts:
    {CLUSTER_NAME}:
        endpoints:
            - {host}
        ca: {ca}
        crt: {crt}
        key: {key}
",
        ca = machine_ca.crt_b64,
        crt = admin_crt,
        key = admin_key,
    );

    // Belt-and-braces: the same reject scan the apply path runs. A clean
    // generated config always passes; failing here means the generator itself
    // regressed, and the bad config must never reach a node.
    crate::talos_maintenance::scan_config(&config_yaml)
        .map_err(|e| format!("generated config failed the safety scan: {e}"))?;

    Ok(FullNodeConfig {
        config_yaml,
        talosconfig_yaml,
    })
}

struct RenderInputs<'a> {
    host: &'a str,
    disk: &'a str,
    machine_token: &'a str,
    machine_ca_crt: &'a str,
    machine_ca_key: &'a str,
    cluster_id: &'a str,
    cluster_secret: &'a str,
    cluster_token: &'a str,
    secretbox_secret: &'a str,
    k8s_ca_crt: &'a str,
    k8s_ca_key: &'a str,
    aggregator_ca_crt: &'a str,
    aggregator_ca_key: &'a str,
    service_account_key: &'a str,
    etcd_ca_crt: &'a str,
    etcd_ca_key: &'a str,
}

/// Render the 3-document YAML. The static lines mirror the talosctl v1.13.0
/// output byte-for-byte (4-space indent, field order, image pins) so the only
/// difference from the validated reference is the per-node values.
fn render_config_yaml(i: &RenderInputs<'_>) -> String {
    let file_envs = CLEARED_FILE_ENVS
        .iter()
        .map(|env| format!("    - {env}=\n"))
        .collect::<String>();

    format!(
        "version: v1alpha1
debug: false
persist: true
machine:
    type: controlplane
    token: {machine_token}
    ca:
        crt: {machine_ca_crt}
        key: {machine_ca_key}
    certSANs:
        - {host}
    kubelet:
        image: ghcr.io/siderolabs/kubelet:{KUBERNETES_VERSION}
        defaultRuntimeSeccompProfileEnabled: true
        disableManifestsDirectory: true
    install:
        disk: {disk}
        image: {MONARCH_OS_INSTALLER_IMAGE}
        wipe: false
        grubUseUKICmdline: true
    features:
        diskQuotaSupport: true
        kubePrism:
            enabled: true
            port: 7445
        hostDNS:
            enabled: true
            forwardKubeDNSToHost: true
    nodeLabels:
        node.kubernetes.io/exclude-from-external-load-balancers: \"\"
cluster:
    id: {cluster_id}
    secret: {cluster_secret}
    controlPlane:
        endpoint: https://{host}:6443
    clusterName: {CLUSTER_NAME}
    network:
        dnsDomain: cluster.local
        podSubnets:
            - 10.244.0.0/16
        serviceSubnets:
            - 10.96.0.0/12
    token: {cluster_token}
    secretboxEncryptionSecret: {secretbox_secret}
    ca:
        crt: {k8s_ca_crt}
        key: {k8s_ca_key}
    aggregatorCA:
        crt: {aggregator_ca_crt}
        key: {aggregator_ca_key}
    serviceAccount:
        key: {service_account_key}
    apiServer:
        image: registry.k8s.io/kube-apiserver:{KUBERNETES_VERSION}
        certSANs:
            - {host}
        admissionControl:
            - name: PodSecurity
              configuration:
                apiVersion: pod-security.admission.config.k8s.io/v1alpha1
                defaults:
                    audit: restricted
                    audit-version: latest
                    enforce: baseline
                    enforce-version: latest
                    warn: restricted
                    warn-version: latest
                exemptions:
                    namespaces:
                        - kube-system
                    runtimeClasses: []
                    usernames: []
                kind: PodSecurityConfiguration
        auditPolicy:
            apiVersion: audit.k8s.io/v1
            kind: Policy
            rules:
                - level: Metadata
    controllerManager:
        image: registry.k8s.io/kube-controller-manager:{KUBERNETES_VERSION}
    proxy:
        image: registry.k8s.io/kube-proxy:{KUBERNETES_VERSION}
    scheduler:
        image: registry.k8s.io/kube-scheduler:{KUBERNETES_VERSION}
    discovery:
        enabled: true
        registries:
            kubernetes:
                disabled: true
            service: {{}}
    etcd:
        ca:
            crt: {etcd_ca_crt}
            key: {etcd_ca_key}
---
apiVersion: v1alpha1
kind: HostnameConfig
auto: stable
---
apiVersion: v1alpha1
kind: ExtensionServiceConfig
name: protocore
environment:
    - PROTOCORE_NODE_MODE=full
    - PROTOCORE_REQUIRE_ENROLLMENT=false
    - PROTOCORE_REQUIRE_TPM_BINDING=false
{file_envs}    - PROTOCORE_RPC_LISTEN=0.0.0.0:8545
    - PROTOCORE_P2P_LISTEN=/ip4/0.0.0.0/tcp/29898
    - PROTOCORE_DISCOVERY=hybrid
    - PROTOCORE_CHAIN_ID={PROVISION_CHAIN_ID}
    - PROTOCORE_REGISTRY_NETWORK={PROVISION_REGISTRY_NETWORK}
",
        machine_token = i.machine_token,
        machine_ca_crt = i.machine_ca_crt,
        machine_ca_key = i.machine_ca_key,
        host = i.host,
        disk = i.disk,
        cluster_id = i.cluster_id,
        cluster_secret = i.cluster_secret,
        cluster_token = i.cluster_token,
        secretbox_secret = i.secretbox_secret,
        k8s_ca_crt = i.k8s_ca_crt,
        k8s_ca_key = i.k8s_ca_key,
        aggregator_ca_crt = i.aggregator_ca_crt,
        aggregator_ca_key = i.aggregator_ca_key,
        service_account_key = i.service_account_key,
        etcd_ca_crt = i.etcd_ca_crt,
        etcd_ca_key = i.etcd_ca_key,
        file_envs = file_envs,
    )
}

// ---------------------------------------------------------------------------
// Tauri command.
// ---------------------------------------------------------------------------

/// Generate the full-node provisioning bundle for one node. Runs the CPU-heavy
/// generation (RSA-4096 keygen) on a blocking thread so the UI stays live.
#[tauri::command]
pub async fn talos_generate_full_node_config(
    host: String,
    disk: String,
) -> Result<FullNodeConfig, String> {
    tokio::task::spawn_blocking(move || generate_full_node_config(&host, &disk))
        .await
        .map_err(|e| format!("config generation task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    const TEST_HOST: &str = "203.0.113.7";
    const TEST_DISK: &str = "/dev/vda";

    /// Generate once and share across tests — RSA-4096 keygen is seconds even
    /// with the dev-profile opt-level override.
    fn generated() -> &'static FullNodeConfig {
        static CONFIG: OnceLock<FullNodeConfig> = OnceLock::new();
        CONFIG.get_or_init(|| {
            generate_full_node_config(TEST_HOST, TEST_DISK).expect("generation succeeds")
        })
    }

    /// Regression guard for the "x509: unknown elliptic curve" wedge: the SEC1
    /// `EC PRIVATE KEY` for the Kubernetes-side CAs MUST carry the prime256v1
    /// named-curve OID in its `[0]` parameters field. p256's stock
    /// `to_sec1_pem()` omits it, which Go/Talos reject — etcd + the k8s
    /// controllers then wedge and ext-protocore never serves.
    #[test]
    fn ecdsa_ca_key_carries_named_curve_oid() {
        use sec1::der::{asn1::ObjectIdentifier, Decode, Document};
        use sec1::{EcParameters, EcPrivateKey};

        let ca = generate_ecdsa_ca(Some("kubernetes")).expect("gen ecdsa ca");
        let key_pem = String::from_utf8(decode_b64(&ca.key_b64)).unwrap();
        assert!(
            key_pem.contains("BEGIN EC PRIVATE KEY"),
            "key must be SEC1 EC PRIVATE KEY PEM, got: {}",
            key_pem.lines().next().unwrap_or_default()
        );
        let (_, doc) = Document::from_pem(&key_pem).expect("SEC1 PEM decodes");
        let ec = EcPrivateKey::from_der(doc.as_bytes()).expect("SEC1 DER parses");
        let p256_oid = ObjectIdentifier::new_unwrap("1.2.840.10045.3.1.7");
        assert_eq!(
            ec.parameters,
            Some(EcParameters::NamedCurve(p256_oid)),
            "SEC1 key must carry the prime256v1 named-curve OID or Go/Talos \
             rejects it with 'unknown elliptic curve'"
        );
        assert!(ec.public_key.is_some(), "SEC1 key should embed the public key");
    }

    /// Return the value of the first YAML line with this exact prefix
    /// (indentation included).
    fn value_of<'a>(yaml: &'a str, prefix: &str) -> &'a str {
        yaml.lines()
            .find_map(|line| line.strip_prefix(prefix))
            .unwrap_or_else(|| panic!("no line with prefix {prefix:?}"))
    }

    fn decode_b64(value: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(value.trim())
            .expect("valid base64")
    }

    /// Parse a base64-of-PEM certificate and return (subject, issuer,
    /// validity-seconds).
    fn cert_facts(b64: &str) -> (String, String, i64) {
        let pem_bytes = decode_b64(b64);
        let (_, pem) = x509_parser::pem::parse_x509_pem(&pem_bytes).expect("PEM parses");
        let cert = pem.parse_x509().expect("certificate parses");
        let validity = cert.validity();
        (
            cert.subject().to_string(),
            cert.issuer().to_string(),
            validity.not_after.timestamp() - validity.not_before.timestamp(),
        )
    }

    #[test]
    fn machine_doc_carries_identity_and_install() {
        let yaml = &generated().config_yaml;
        assert!(yaml.contains("    type: controlplane\n"), "machine type");
        assert!(yaml.contains(&format!("    install:\n        disk: {TEST_DISK}\n")));
        assert!(yaml.contains("        wipe: false\n"));
        assert!(yaml.contains(&format!(
            "        image: {MONARCH_OS_INSTALLER_IMAGE}\n"
        )));
        assert!(yaml.contains("        grubUseUKICmdline: true\n"));

        let token = value_of(yaml, "    token: ");
        let (id, secret) = token.split_once('.').expect("token has a dot");
        assert_eq!(id.len(), 6, "token id: {token}");
        assert_eq!(secret.len(), 16, "token secret: {token}");
        assert!(token
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.'));

        let (subject, issuer, validity) = cert_facts(value_of(yaml, "        crt: "));
        assert_eq!(subject, "O=talos", "machine CA subject");
        assert_eq!(issuer, "O=talos", "machine CA is self-signed");
        assert_eq!(validity, CA_VALIDITY_DAYS * 86_400, "machine CA validity");
    }

    #[test]
    fn full_cluster_pki_present_with_reference_subjects() {
        let yaml = &generated().config_yaml;
        // The runtime-wedge bug: these fields MUST all be present. The dry-run
        // validator does not require them — only this generator does.
        for field in [
            "    id: ",
            "    secret: ",
            "    secretboxEncryptionSecret: ",
            "    ca:\n",
            "    aggregatorCA:\n",
            "    serviceAccount:\n",
            "    etcd:\n",
        ] {
            assert!(yaml.contains(field), "missing cluster PKI field {field:?}");
        }

        let cluster = yaml
            .split("\ncluster:\n")
            .nth(1)
            .expect("cluster section exists");
        let (subject, _, validity) = cert_facts(value_of(cluster, "        crt: "));
        assert_eq!(subject, "O=kubernetes", "cluster.ca subject");
        assert_eq!(validity, CA_VALIDITY_DAYS * 86_400);

        let aggregator = cluster
            .split("    aggregatorCA:\n")
            .nth(1)
            .expect("aggregatorCA section");
        let (subject, issuer, _) = cert_facts(value_of(aggregator, "        crt: "));
        assert_eq!(subject, "", "aggregator CA has an empty subject");
        assert_eq!(issuer, "");

        let etcd = cluster.split("    etcd:\n").nth(1).expect("etcd section");
        let (subject, _, _) = cert_facts(value_of(etcd, "            crt: "));
        assert_eq!(subject, "O=etcd", "etcd CA subject");

        // cluster.id / secret / secretbox: 32 bytes each, talosctl encodings.
        let id = value_of(cluster, "    id: ");
        assert_eq!(
            base64::engine::general_purpose::URL_SAFE
                .decode(id)
                .expect("cluster.id is URL-safe base64")
                .len(),
            32
        );
        for key in ["    secret: ", "    secretboxEncryptionSecret: "] {
            assert_eq!(decode_b64(value_of(cluster, key)).len(), 32, "{key}");
        }
    }

    #[test]
    fn key_pem_labels_match_talosctl() {
        let yaml = &generated().config_yaml;
        let machine = yaml.split("\ncluster:\n").next().expect("machine section");
        let machine_key = String::from_utf8(decode_b64(value_of(machine, "        key: "))).unwrap();
        assert!(
            machine_key.starts_with("-----BEGIN ED25519 PRIVATE KEY-----"),
            "machine CA key label: {}",
            machine_key.lines().next().unwrap_or("")
        );

        let cluster = yaml.split("\ncluster:\n").nth(1).expect("cluster section");
        for (section, prefix) in [
            ("    ca:\n", "        key: "),
            ("    aggregatorCA:\n", "        key: "),
            ("    etcd:\n", "            key: "),
        ] {
            let body = cluster.split(section).nth(1).unwrap();
            let key = String::from_utf8(decode_b64(value_of(body, prefix))).unwrap();
            assert!(
                key.starts_with("-----BEGIN EC PRIVATE KEY-----"),
                "{section} key label: {}",
                key.lines().next().unwrap_or("")
            );
        }

        let sa = cluster.split("    serviceAccount:\n").nth(1).unwrap();
        let sa_key = String::from_utf8(decode_b64(value_of(sa, "        key: "))).unwrap();
        assert!(
            sa_key.starts_with("-----BEGIN RSA PRIVATE KEY-----"),
            "service-account key label: {}",
            sa_key.lines().next().unwrap_or("")
        );
    }

    #[test]
    fn host_threaded_into_sans_and_endpoint() {
        let yaml = &generated().config_yaml;
        assert!(
            yaml.contains(&format!("    certSANs:\n        - {TEST_HOST}\n")),
            "host in machine.certSANs"
        );
        assert!(
            yaml.contains(&format!("        certSANs:\n            - {TEST_HOST}\n")),
            "host in apiServer.certSANs"
        );
        assert!(
            yaml.contains(&format!("        endpoint: https://{TEST_HOST}:6443\n")),
            "host in controlPlane.endpoint"
        );
    }

    #[test]
    fn baked_file_path_envs_are_cleared() {
        let yaml = &generated().config_yaml;
        // The crash-loop bug: every image-baked *_FILE env must be explicitly
        // set to EMPTY (trailing `=` then newline) so the merge clears the
        // baked path. `KEY=` anywhere else (e.g. `KEY=/some/path`) is not it.
        for env in CLEARED_FILE_ENVS {
            assert!(
                yaml.contains(&format!("    - {env}=\n")),
                "{env} must be cleared with an explicit empty value"
            );
        }
    }

    #[test]
    fn full_node_flags_and_pins_exact() {
        let yaml = &generated().config_yaml;
        for line in [
            "    - PROTOCORE_NODE_MODE=full\n",
            "    - PROTOCORE_REQUIRE_ENROLLMENT=false\n",
            "    - PROTOCORE_REQUIRE_TPM_BINDING=false\n",
            "    - PROTOCORE_RPC_LISTEN=0.0.0.0:8545\n",
            "    - PROTOCORE_P2P_LISTEN=/ip4/0.0.0.0/tcp/29898\n",
            "    - PROTOCORE_DISCOVERY=hybrid\n",
            "    - PROTOCORE_CHAIN_ID=69420\n",
            "    - PROTOCORE_REGISTRY_NETWORK=testnet-69420\n",
        ] {
            assert!(yaml.contains(line), "missing env line {line:?}");
        }
        assert!(!yaml.contains("PROTOCORE_REQUIRE_ENROLLMENT=true"));
        assert!(!yaml.contains("PROTOCORE_REQUIRE_TPM_BINDING=true"));
    }

    #[test]
    fn three_documents_with_hostname_config() {
        let yaml = &generated().config_yaml;
        // Split on a full `---` separator LINE (a base64 scalar can never
        // produce one — every secret value lives behind a `key: ` prefix).
        let docs: Vec<&str> = yaml.split("\n---\n").collect();
        assert_eq!(docs.len(), 3, "machine + HostnameConfig + extension docs");
        assert!(docs[0].starts_with("version: v1alpha1\ndebug: false\npersist: true\n"));
        assert_eq!(
            docs[1],
            "apiVersion: v1alpha1\nkind: HostnameConfig\nauto: stable"
        );
        assert!(docs[2].contains("kind: ExtensionServiceConfig\nname: protocore\n"));
    }

    #[test]
    fn generated_config_passes_the_apply_reject_scan() {
        assert!(crate::talos_maintenance::scan_config(&generated().config_yaml).is_ok());
    }

    #[test]
    fn every_secret_is_minted_fresh_never_copied() {
        // Two generations for the same (host, disk): every secret-bearing line
        // must differ (fresh CSPRNG material, no constants smuggled in from a
        // reference config), every other line must be byte-identical (static
        // template).
        let a = generated();
        let b = generate_full_node_config(TEST_HOST, TEST_DISK).expect("second generation");
        let lines_a: Vec<&str> = a.config_yaml.lines().collect();
        let lines_b: Vec<&str> = b.config_yaml.lines().collect();
        assert_eq!(lines_a.len(), lines_b.len(), "same template shape");
        for (la, lb) in lines_a.iter().zip(&lines_b) {
            let t = la.trim_start();
            let secret_bearing = t.starts_with("crt: ")
                || t.starts_with("key: ")
                || t.starts_with("token: ")
                || t.starts_with("id: ")
                || t.starts_with("secret: ")
                || t.starts_with("secretboxEncryptionSecret: ");
            if secret_bearing {
                assert_ne!(la, lb, "secret-bearing line must be freshly minted");
            } else {
                assert_eq!(la, lb, "static template line must not vary");
            }
        }
        // Same property for the talosconfig (ca/crt/key lines).
        assert_ne!(a.talosconfig_yaml, b.talosconfig_yaml);
    }

    #[test]
    fn talosconfig_is_complete_and_signed_by_the_machine_ca() {
        let bundle = generated();
        let tc = &bundle.talosconfig_yaml;
        assert!(tc.starts_with(&format!("context: {CLUSTER_NAME}\n")));
        assert!(tc.contains(&format!("    {CLUSTER_NAME}:\n")));
        assert!(
            tc.contains(&format!("        endpoints:\n            - {TEST_HOST}\n")),
            "node host registered as the context endpoint"
        );

        // The talosconfig CA must be the SAME machine CA the machine config
        // carries — that is what makes the file able to verify the node.
        let machine_section = bundle
            .config_yaml
            .split("\ncluster:\n")
            .next()
            .expect("machine section");
        let machine_ca = value_of(machine_section, "        crt: ");
        assert_eq!(value_of(tc, "        ca: "), machine_ca);

        let (subject, issuer, validity) = cert_facts(value_of(tc, "        crt: "));
        assert_eq!(subject, "O=os:admin", "admin role org");
        assert_eq!(issuer, "O=talos", "issued by the machine CA");
        assert_eq!(validity, ADMIN_CERT_VALIDITY_DAYS * 86_400);

        let key = String::from_utf8(decode_b64(value_of(tc, "        key: "))).unwrap();
        assert!(key.starts_with("-----BEGIN ED25519 PRIVATE KEY-----"));
    }

    #[test]
    fn rejects_bad_hosts() {
        for host in [
            "",
            "   ",
            "10.0.0.1:50000",
            "https://10.0.0.1",
            "host name",
            "host\nname",
            "fe80::1",
            "-bad",
            ".bad",
            "a..b",
        ] {
            assert!(
                generate_full_node_config(host, TEST_DISK).is_err(),
                "host {host:?} must be rejected"
            );
        }
    }

    #[test]
    fn rejects_bad_disks() {
        for disk in [
            "",
            "vda",
            "sda1",
            "/dev/",
            "/dev/v da",
            "/dev/vda:0",
            "/dev/../etc",
            "/dev/vda/",
            "/dev/vda\nextra: doc",
        ] {
            assert!(
                generate_full_node_config(TEST_HOST, disk).is_err(),
                "disk {disk:?} must be rejected"
            );
        }
    }
}
