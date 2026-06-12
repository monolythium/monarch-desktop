//! Validate the Talos maintenance channel against a real node without the GUI.
//!
//! Read-only and non-destructive: it probes the unauthenticated Version RPC and
//! attempts a disk enumeration. It never applies a config. This exercises the
//! exact insecure-channel code the Tauri commands use (the shared `probe` /
//! `disks` functions, not the command wrappers).
//!
//! Usage:
//!     cargo run --example maintenance_probe -- <host-or-ip>
//!
//! Example:
//!     cargo run --example maintenance_probe -- 10.0.10.42

use monarch_desktop_lib::talos_maintenance;

#[tokio::main]
async fn main() {
    let host = match std::env::args().nth(1) {
        Some(host) => host,
        None => {
            eprintln!("usage: maintenance_probe <host-or-ip>");
            std::process::exit(2);
        }
    };

    println!("probing maintenance API on {host}:50000 ...");
    let probe = talos_maintenance::probe(&host).await;
    println!("  reachable:      {}", probe.reachable);
    println!("  maintenance:    {}", probe.maintenance);
    println!(
        "  talos version:  {}",
        probe.talos_version.as_deref().unwrap_or("-")
    );
    if let Some(error) = &probe.error {
        println!("  note:           {error}");
    }

    if !probe.reachable {
        eprintln!("\nnode is not reachable on the maintenance API; nothing else to check.");
        std::process::exit(1);
    }

    println!("\nenumerating disks ...");
    match talos_maintenance::disks(&host).await {
        Ok(disks) if disks.is_empty() => {
            println!("  (no disks reported)");
        }
        Ok(disks) => {
            for disk in disks {
                let flags = [
                    disk.system_disk_hint.then_some("system"),
                    disk.readonly.then_some("readonly"),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(",");
                let flags = if flags.is_empty() {
                    String::new()
                } else {
                    format!(" [{flags}]")
                };
                println!(
                    "  {:<14} {:>10}  {:<5} {}{}",
                    disk.device_name, disk.size_human, disk.disk_type, disk.model, flags
                );
            }
        }
        Err(error) => {
            // Expected on Talos versions that don't serve StorageService
            // pre-config — the GUI falls back to manual disk entry here.
            println!("  disk enumeration unavailable: {error}");
            println!("  (the wizard falls back to manual disk entry in this case)");
        }
    }
}
