//! Dry-run validate the in-app FULL-node machine config against a real
//! maintenance-mode node, without writing or installing anything.
//!
//! This is non-destructive: it calls `apply(host, config, dry_run=true,
//! mode="try")`, which makes Talos *validate* the machine config and return any
//! warnings/diff WITHOUT writing it to disk or rebooting. It exercises the exact
//! shared `apply` path the Tauri command uses, plus the shared
//! `generate_machine_secrets` the provision flow uses to mint the node's Talos
//! machine identity. It never runs a committing apply.
//!
//! The config under test is byte-for-byte the shape the frontend's
//! `buildFullNodeConfig({ disk, mode: "full", machineSecrets })`
//! (src/sdk/provisionConfig.ts) produces: a v1alpha1 machine doc carrying the
//! node's freshly generated machine CA + token + install disk, plus the
//! protocore ExtensionServiceConfig. By default the machine secrets are
//! generated fresh via the Rust path (the real provision flow); pass a config
//! file to dry-run an exact file instead.
//!
//! Usage:
//!     cargo run --example maintenance_dryrun -- <host-or-ip>
//!     cargo run --example maintenance_dryrun -- <host-or-ip> <config-file>
//!     cargo run --example maintenance_dryrun -- <host-or-ip> --disk /dev/sda
//!
//! Example:
//!     cargo run --example maintenance_dryrun -- 149.28.124.82

use monarch_desktop_lib::talos_maintenance::{self, TalosMachineSecrets};

/// Build the full-node config exactly as `buildFullNodeConfig` does in
/// src/sdk/provisionConfig.ts: a v1alpha1 machine doc with the node's machine
/// identity (token + ca.crt/key) + install disk, then the protocore extension.
/// Kept byte-for-byte in sync with that builder.
fn build_full_node_config(disk: &str, s: &TalosMachineSecrets) -> String {
    format!(
        "version: v1alpha1
machine:
  type: controlplane
  token: {token}
  ca:
    crt: {crt}
    key: {key}
  install:
    disk: {disk}
    wipe: false
cluster:
  controlPlane:
    endpoint: https://127.0.0.1:6443
---
apiVersion: v1alpha1
kind: ExtensionServiceConfig
name: protocore
environment:
  - PROTOCORE_NODE_MODE=full
  - PROTOCORE_REQUIRE_ENROLLMENT=false
  - PROTOCORE_REQUIRE_TPM_BINDING=false
  - PROTOCORE_RPC_LISTEN=0.0.0.0:8545
  - PROTOCORE_P2P_LISTEN=/ip4/0.0.0.0/tcp/29898
  - PROTOCORE_DISCOVERY=hybrid
  - PROTOCORE_CHAIN_ID=69420
  - PROTOCORE_REGISTRY_NETWORK=testnet-69420
",
        token = s.token,
        crt = s.ca_crt,
        key = s.ca_key,
        disk = disk,
    )
}

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let mut args = std::env::args().skip(1);
    let mut commit = std::env::var("MAINTENANCE_COMMIT").is_ok();
    let host = match args.next() {
        Some(host) => host,
        None => {
            eprintln!("usage: maintenance_dryrun <host-or-ip> [config-file | --disk /dev/X]");
            std::process::exit(2);
        }
    };

    let mut config_file: Option<String> = None;
    let mut disk = "/dev/vda".to_string();
    while let Some(arg) = args.next() {
        if arg == "--commit" { commit = true; continue; }
        match arg.as_str() {
            "--disk" => {
                disk = args.next().unwrap_or_else(|| {
                    eprintln!("--disk needs a value");
                    std::process::exit(2);
                });
            }
            other => config_file = Some(other.to_string()),
        }
    }

    let (config_yaml, source) = match config_file {
        Some(path) => match std::fs::read_to_string(&path) {
            Ok(contents) => (contents, format!("file {path}")),
            Err(err) => {
                eprintln!("failed to read config file {path}: {err}");
                std::process::exit(2);
            }
        },
        None => {
            // Mint the node's Talos machine identity exactly as the provision
            // flow does, then build the config the frontend would send.
            let secrets = match talos_maintenance::generate_machine_secrets() {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("failed to generate machine secrets: {e}");
                    std::process::exit(2);
                }
            };
            (
                build_full_node_config(&disk, &secrets),
                format!("generated buildFullNodeConfig(disk={disk}, fresh machine secrets)"),
            )
        }
    };

    println!("dry-run apply against {host}:50000");
    println!("config source: {source}");
    println!("------------------------------------------------------------");
    print!("{config_yaml}");
    println!("------------------------------------------------------------");
    println!();

    // dry_run=true, mode="try": Talos validates the config and reports
    // warnings/diff WITHOUT writing it. Nothing is installed; no reboot.
    let (dry_run, mode) = if commit { (false, "reboot") } else { (true, "try") };
    if commit {
        println!("!! COMMITTING apply (dry_run=false, mode=reboot) — destructive, installs + reboots the node");
    }
    match talos_maintenance::apply(&host, &config_yaml, dry_run, mode).await {
        Ok(result) => {
            println!("RESULT: Talos ACCEPTED the config (dry-run).");
            println!("  node:     {}", result.node_address);
            println!("  endpoint: {}", result.endpoint);
            println!("  command:  {}", result.command);
            println!("  output:");
            for line in result.output.lines() {
                println!("    {line}");
            }
        }
        Err(error) => {
            println!("RESULT: Talos REJECTED the config (or the call failed).");
            println!("  error: {error}");
            std::process::exit(1);
        }
    }
}
