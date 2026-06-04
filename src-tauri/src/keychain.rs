// OS keychain bridge — backed by the `keyring` crate (Tauri 2 compat).
// Every credential lives under the `monarch-desktop` service so the
// account namespace stays self-describing (e.g. `ssh:host`, `ssh:user`,
// `ssh:key-path`, `cluster-share:c-012`).
//
// On macOS the `apple-native` feature routes through Security.framework
// (no DBus dependency on dev). On Windows/Linux the matching native
// features are enabled in Cargo.toml; failures bubble up as a typed
// `KeychainError` so the React side can render a halo instead of
// crashing.

use serde::Serialize;
use thiserror::Error;

/// Service name registered in the OS keychain. Every account this app
/// touches lives under this prefix; the `account` argument the React
/// side passes is what disambiguates entries.
pub const SERVICE: &str = "monarch-desktop";

/// Operator-facing error type. Stringified into a JSON `Err` over the
/// Tauri boundary so the drawer can render the message verbatim.
#[derive(Debug, Error, Serialize)]
pub enum KeychainError {
    #[error("keychain entry not found")]
    NotFound,
    #[error("keychain ambiguous (multiple matches)")]
    Ambiguous,
    #[error("keychain backend error: {0}")]
    Backend(String),
}

impl From<keyring::Error> for KeychainError {
    fn from(err: keyring::Error) -> Self {
        match err {
            keyring::Error::NoEntry => KeychainError::NotFound,
            keyring::Error::Ambiguous(_) => KeychainError::Ambiguous,
            other => KeychainError::Backend(other.to_string()),
        }
    }
}

/// Persist a credential under `SERVICE/account`. Empty values are
/// rejected so we don't end up with a "set but null" surprise on read.
pub fn store_credential(account: &str, secret: &str) -> Result<(), KeychainError> {
    if account.is_empty() {
        return Err(KeychainError::Backend("account must not be empty".into()));
    }
    let entry = keyring::Entry::new(SERVICE, account)?;
    entry.set_password(secret)?;
    Ok(())
}

/// Read a credential. Returns `KeychainError::NotFound` if absent so
/// the caller can fall back to a default (e.g. mock SSH host).
pub fn read_credential(account: &str) -> Result<String, KeychainError> {
    let entry = keyring::Entry::new(SERVICE, account)?;
    Ok(entry.get_password()?)
}

/// Remove a credential. Idempotent at the call site — `NotFound` is
/// surfaced rather than silently ignored so the UI can decide what to
/// do (we don't want a "delete succeeded" lie).
pub fn delete_credential(account: &str) -> Result<(), KeychainError> {
    let entry = keyring::Entry::new(SERVICE, account)?;
    entry.delete_credential()?;
    Ok(())
}

// ---- Tauri command wrappers ---------------------------------------
// All commands return `Result<T, String>` so serde_json can marshal a
// stringly-typed error to the React side without needing to import the
// custom error variants over the IPC boundary.

#[tauri::command]
pub fn keychain_set(account: String, secret: String) -> Result<(), String> {
    store_credential(&account, &secret).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keychain_get(account: String) -> Result<String, String> {
    read_credential(&account).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keychain_delete(account: String) -> Result<(), String> {
    delete_credential(&account).map_err(|e| e.to_string())
}
