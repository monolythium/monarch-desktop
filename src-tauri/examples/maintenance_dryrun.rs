//! Dry-run validate the in-app FULL-node machine config against a real
//! maintenance-mode node, without writing or installing anything.
//!
//! This exercises the EXACT app path: `provision::generate_full_node_config`
//! (the same generator behind the `talos_generate_full_node_config` Tauri
//! command — full cluster PKI, cleared enrollment/TPM file envs, fresh
//! talosconfig) feeding `talos_maintenance::apply` (the same call behind the
//! apply button). By default it is non-destructive: `apply(dry_run=true,
//! mode="try")` makes Talos *validate* the config and return warnings/diff
//! WITHOUT writing it to disk or rebooting.
//!
//! With `--commit` (or MAINTENANCE_COMMIT=1) it performs the real install
//! (dry_run=false, mode=reboot) and then writes the generated talosconfig next
//! to the current directory (or to `--talosconfig-out`), mirroring what the
//! app persists to its data dir. The talosconfig is the node's ONLY management
//! credential — keep it.
//!
//! Usage:
//!     cargo run --example maintenance_dryrun -- <host-or-ip>
//!     cargo run --example maintenance_dryrun -- <host-or-ip> <config-file>
//!     cargo run --example maintenance_dryrun -- <host-or-ip> --disk /dev/sda
//!     cargo run --example maintenance_dryrun -- <host-or-ip> --disk /dev/vda \
//!         --commit --talosconfig-out ./node.talosconfig
//!
//! Passing an explicit <config-file> dry-runs that exact file instead of the
//! generator (no talosconfig is produced in that mode).

use monarch_desktop_lib::{provision, talos_maintenance};

fn main_usage() -> ! {
    eprintln!(
        "usage: maintenance_dryrun <host-or-ip> [config-file | --disk /dev/X] \
         [--commit] [--talosconfig-out PATH]"
    );
    std::process::exit(2);
}

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let mut args = std::env::args().skip(1);
    let mut commit = std::env::var("MAINTENANCE_COMMIT").is_ok();
    let host = match args.next() {
        Some(host) => host,
        None => main_usage(),
    };

    let mut config_file: Option<String> = None;
    let mut disk = "/dev/vda".to_string();
    let mut talosconfig_out: Option<String> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--commit" => commit = true,
            "--disk" => {
                disk = args.next().unwrap_or_else(|| {
                    eprintln!("--disk needs a value");
                    std::process::exit(2);
                });
            }
            "--talosconfig-out" => {
                talosconfig_out = Some(args.next().unwrap_or_else(|| {
                    eprintln!("--talosconfig-out needs a value");
                    std::process::exit(2);
                }));
            }
            other if other.starts_with("--") => main_usage(),
            other => config_file = Some(other.to_string()),
        }
    }

    // Where the talosconfig lands on --commit. The app writes it to its data
    // dir; this example defaults to the current directory.
    let talosconfig_path =
        talosconfig_out.unwrap_or_else(|| format!("./{host}.talosconfig"));

    let (config_yaml, talosconfig_yaml, source) = match config_file {
        Some(path) => match std::fs::read_to_string(&path) {
            Ok(contents) => (contents, None, format!("file {path}")),
            Err(err) => {
                eprintln!("failed to read config file {path}: {err}");
                std::process::exit(2);
            }
        },
        None => {
            // The real app path: full cluster PKI + cleared file envs + a
            // fresh talosconfig, minted per node.
            match provision::generate_full_node_config(&host, &disk) {
                Ok(bundle) => (
                    bundle.config_yaml,
                    Some(bundle.talosconfig_yaml),
                    format!("generate_full_node_config(host={host}, disk={disk})"),
                ),
                Err(err) => {
                    eprintln!("failed to generate full-node config: {err}");
                    std::process::exit(2);
                }
            }
        }
    };

    println!("apply against {host}:50000");
    println!("config source: {source}");
    println!("------------------------------------------------------------");
    print!("{config_yaml}");
    println!("------------------------------------------------------------");
    if talosconfig_yaml.is_some() {
        let verb = if commit { "will be saved" } else { "would be saved (with --commit)" };
        println!("talosconfig {verb} to: {talosconfig_path}");
    }
    println!();

    // dry_run=true, mode="try": Talos validates the config and reports
    // warnings/diff WITHOUT writing it. Nothing is installed; no reboot.
    let (dry_run, mode) = if commit { (false, "reboot") } else { (true, "try") };
    if commit {
        println!("!! COMMITTING apply (dry_run=false, mode=reboot) — destructive, installs + reboots the node");
    }
    match talos_maintenance::apply(&host, &config_yaml, dry_run, mode).await {
        Ok(result) => {
            let label = if commit { "commit" } else { "dry-run" };
            println!("RESULT: Talos ACCEPTED the config ({label}).");
            println!("  node:     {}", result.node_address);
            println!("  endpoint: {}", result.endpoint);
            println!("  command:  {}", result.command);
            println!("  output:");
            for line in result.output.lines() {
                println!("    {line}");
            }
            if commit {
                if let Some(talosconfig) = &talosconfig_yaml {
                    match std::fs::write(&talosconfig_path, talosconfig) {
                        Ok(()) => {
                            #[cfg(unix)]
                            {
                                use std::os::unix::fs::PermissionsExt as _;
                                let _ = std::fs::set_permissions(
                                    &talosconfig_path,
                                    std::fs::Permissions::from_mode(0o600),
                                );
                            }
                            println!();
                            println!("talosconfig saved to {talosconfig_path}");
                            println!("  (the node's ONLY management credential — keep it; Monarch OS has no SSH)");
                        }
                        Err(err) => {
                            eprintln!();
                            eprintln!("!! FAILED to save the talosconfig to {talosconfig_path}: {err}");
                            eprintln!("!! Without it the node is unmanageable. The talosconfig follows; save it NOW:");
                            eprintln!("{talosconfig}");
                            std::process::exit(1);
                        }
                    }
                }
            }
        }
        Err(error) => {
            println!("RESULT: Talos REJECTED the config (or the call failed).");
            println!("  error: {error}");
            std::process::exit(1);
        }
    }
}
