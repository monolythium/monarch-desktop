// Tauri entry point. The Rust side exposes:
//
//   * `ssh_connect` / `ssh_exec` / `ssh_status` / `ssh_disconnect` —
//     russh 0.46 client bridge. The active session is held inside a
//     `tokio::Mutex` registered as Tauri-managed state so concurrent
//     calls from the React side serialize cleanly.
//   * `ssh_exec_stream` / `ssh_exec_cancel` — long-running streaming
//     commands (typically `journalctl -fu monod -o json`) emit one
//     Tauri event per stdout line on `monarch://ssh-log/<session_id>`.
//     The Logs view subscribes via `listen()` and renders a live tail.
//   * `keychain_set` / `keychain_get` / `keychain_delete` — keyring 3
//     wrappers under the `monarch-desktop` service. Operators store
//     `ssh:host`, `ssh:user`, `ssh:key-path`, and (optionally)
//     `ssh:passphrase` here. The advisory bridge stores the
//     Hosted provider API key under the same service as `hosted-provider-api-key`.
//   * `talos_connect` / `talos_status` / `talos_config_info` /
//     `talos_trust_config` / `talos_service` /
//     `talos_protocore_readiness` / `talos_host_telemetry` /
//     `talos_upgrade` / `talos_rollback` / `talos_service_action` /
//     `talos_export_protocore_backup` / `talos_logs` /
//     `talos_log_stream` / `rpc_runtime_provenance` / `rpc_call_json` —
//     Monarch OS control
//     and release evidence bridge. Talos API calls use mTLS via the
//     operator's `talosconfig`; runtime provenance is read over JSON-RPC.
//     SSH remains a development bridge for plain Linux hosts.
//   * `ask_monarch` / `set_ai_config` / `get_ai_config` — advisory
//     bridge. Streams a configured hosted endpoint or a local chat endpoint
//     replies to the React side as Tauri events on
//     `monarch://ask/stream/<id>` and emits the final assembled text +
//     parsed `proposed_action` on `monarch://ask/done/<id>`. Every
//     proposed action is handed to the Operations drawer at the
//     `preview` stage — never auto-executed.
//
// Indexer hooks return explicit unavailable states until the corresponding
// mono-core surface is exposed.

mod ai;
mod chat;
mod chat_store;
mod keychain;
mod ssh;
mod talos;
// Public so the `maintenance_probe` example binary can drive the insecure
// channel functions directly (read-only) for off-GUI validation.
pub mod talos_maintenance;

use std::sync::Arc;
use tokio::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ssh_state: ssh::SshState = Arc::new(Mutex::new(ssh::SshStateInner::new()));
    let ai_state: ai::AiState = Arc::new(Mutex::new(ai::AiStateInner::new()));
    let talos_state: talos::TalosState = Arc::new(Mutex::new(talos::TalosStateInner::default()));
    let chat_state: chat::ChatState = Arc::new(Mutex::new(chat::ChatManagerInner::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ssh_state)
        .manage(ai_state)
        .manage(talos_state)
        .manage(chat_state)
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
            talos::talos_host_telemetry,
            talos::talos_upgrade,
            talos::talos_rollback,
            talos::talos_service_action,
            talos::talos_export_protocore_backup,
            talos::talos_operator_seal_ek,
            talos::talos_logs,
            talos::talos_log_stream,
            talos::talos_log_cancel,
            talos::talos_protocore_restart,
            talos_maintenance::talos_maintenance_probe,
            talos_maintenance::talos_maintenance_disks,
            talos_maintenance::talos_maintenance_apply,
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
