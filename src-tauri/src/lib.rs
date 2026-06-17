// Tauri entry point. The Rust side exposes:
//
//   * `ssh_connect` / `ssh_exec` / `ssh_status` / `ssh_disconnect` and
//     `ssh_exec_stream` / `ssh_exec_cancel` — remote host diagnostics used
//     by development and support builds.
//   * `keychain_set` / `keychain_get` / `keychain_delete` — keyring 3
//     wrappers under the `monarch-desktop` service. Operators store
//     the operator key, Monarch OS endpoint metadata, and advisory bridge
//     settings here.
//   * `talos_connect` / `talos_status` / `talos_config_info` /
//     `talos_trust_config` / `talos_service` /
//     `talos_protocore_readiness` / `talos_host_telemetry` /
//     `talos_upgrade` / `talos_rollback` / `talos_service_action` /
//     `talos_export_protocore_backup` / `talos_logs` /
//     `talos_log_stream` / `talos_log_disk_usage` /
//     `talos_set_log_retention` / `talos_clean_protocore_logs` /
//     `rpc_runtime_provenance` / `rpc_call_json` —
//     Monarch OS control
//     and release evidence bridge. Talos API calls use mTLS via the
//     operator's `talosconfig`; runtime provenance is read over JSON-RPC.
//     `talos_log_disk_usage` reads the protocore log directory size
//     (`DiskUsage`/`List`); `talos_set_log_retention` /
//     `talos_clean_protocore_logs` bound it via an `ApplyConfiguration`
//     patch of the protocore extension env + a service restart.
//   * `ask_monarch` / `set_ai_config` / `get_ai_config` — advisory
//     bridge. Streams a configured hosted endpoint or a local chat endpoint
//     replies to the React side as Tauri events on
//     `monarch://ask/stream/<id>` and emits the final assembled text +
//     parsed `proposed_action` on `monarch://ask/done/<id>`. Every
//     proposed action is handed to the Operations drawer for review —
//     never auto-executed.
//
// Indexer hooks return explicit unavailable states until the corresponding
// mono-core surface is exposed.

mod ai;
mod chat;
mod chat_store;
mod hw;
mod hw_store;
mod keychain;
// Full-node machine-config + talosconfig generation. Public so the
// `maintenance_dryrun` example binary can exercise the exact generator the
// provision flow uses against a live node.
pub mod provision;
mod release_feed;
mod ssh;
mod talos;
// Public so the `maintenance_probe` example binary can drive the insecure
// channel functions directly (read-only) for off-GUI validation.
pub mod talos_maintenance;

use std::sync::Arc;
use tokio::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install the rustls ring crypto provider once, before any TLS is set up.
    // The maintenance-mode Talos bridge builds a rustls ClientConfig by hand;
    // without a process-wide default provider that construction panics. Tauri
    // never installs one for us, so do it here, idempotently — a second install
    // returns Err and is intentionally ignored.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let ssh_state: ssh::SshState = Arc::new(Mutex::new(ssh::SshStateInner::new()));
    let ai_state: ai::AiState = Arc::new(Mutex::new(ai::AiStateInner::new()));
    let talos_state: talos::TalosState = Arc::new(Mutex::new(talos::TalosStateInner::default()));
    let chat_state: chat::ChatState = Arc::new(Mutex::new(chat::ChatManagerInner::new()));
    let hw_state: hw::HwState = hw::new_state();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ssh_state)
        .manage(ai_state)
        .manage(talos_state)
        .manage(chat_state)
        .manage(hw_state)
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_exec,
            ssh::ssh_exec_stream,
            ssh::ssh_exec_cancel,
            ssh::ssh_status,
            ssh::ssh_disconnect,
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
            ai::ask_monarch,
            ai::get_ai_config,
            ai::set_ai_config,
            talos::talos_connect,
            talos::talos_status,
            talos::talos_config_info,
            talos::talos_trust_config,
            talos::talos_service,
            talos::talos_protocore_readiness,
            talos::rpc_runtime_provenance,
            talos::rpc_call_json,
            talos::rpc_proxy,
            talos::talos_host_telemetry,
            talos::talos_node_status,
            talos::talos_upgrade,
            talos::talos_bootstrap,
            talos::talos_rollback,
            talos::talos_wipe_protocore,
            talos::talos_service_action,
            talos::talos_export_protocore_backup,
            talos::talos_operator_seal_ek,
            talos::talos_logs,
            talos::talos_log_stream,
            talos::talos_log_cancel,
            talos::talos_protocore_restart,
            talos::talos_log_disk_usage,
            talos::talos_data_dir_usage,
            talos::talos_set_log_retention,
            talos::talos_clean_protocore_logs,
            hw::record_hw_sample,
            hw::query_hw_samples,
            talos_maintenance::talos_maintenance_probe,
            talos_maintenance::talos_maintenance_disks,
            talos_maintenance::talos_maintenance_apply,
            provision::talos_generate_full_node_config,
            provision::talos_generate_recovery_node_config,
            release_feed::latest_protocore_release,
            release_feed::recent_protocore_releases,
            chat::chat_initialize,
            chat::chat_get_channels,
            chat::chat_get_messages,
            chat::chat_send_message,
            chat::chat_subscribe_channel,
            chat::chat_subscribe_ceremony,
            chat::chat_unsubscribe_channel,
            chat::chat_dial_peers,
            chat::chat_mark_read,
            chat::chat_get_member_monikers,
            chat::chat_sign_form_cluster_consent,
            chat::chat_sign_update_charter_consent,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running Monarch Desktop");
}
