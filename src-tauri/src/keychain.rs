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
use std::{
    env, fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
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
    if let Some(dir) = e2e_keychain_dir() {
        return store_e2e_credential(&dir, account, secret);
    }
    let entry = keyring::Entry::new(SERVICE, account)?;
    entry.set_password(secret)?;
    Ok(())
}

/// Read a credential. Returns `KeychainError::NotFound` if absent so
/// the caller can fall back to a default (e.g. mock SSH host).
pub fn read_credential(account: &str) -> Result<String, KeychainError> {
    if let Some(dir) = e2e_keychain_dir() {
        return read_e2e_credential(&dir, account);
    }
    let entry = keyring::Entry::new(SERVICE, account)?;
    Ok(entry.get_password()?)
}

/// Remove a credential. Idempotent at the call site — `NotFound` is
/// surfaced rather than silently ignored so the UI can decide what to
/// do (we don't want a "delete succeeded" lie).
pub fn delete_credential(account: &str) -> Result<(), KeychainError> {
    if let Some(dir) = e2e_keychain_dir() {
        return delete_e2e_credential(&dir, account);
    }
    let entry = keyring::Entry::new(SERVICE, account)?;
    entry.delete_credential()?;
    Ok(())
}

fn e2e_keychain_dir() -> Option<PathBuf> {
    let value = env::var_os("MONARCH_DESKTOP_E2E_KEYCHAIN_DIR")?;
    if value.is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

fn store_e2e_credential(dir: &Path, account: &str, secret: &str) -> Result<(), KeychainError> {
    fs::create_dir_all(dir).map_err(file_backend_error)?;
    fs::write(e2e_credential_path(dir, account), secret).map_err(file_backend_error)
}

fn read_e2e_credential(dir: &Path, account: &str) -> Result<String, KeychainError> {
    fs::read_to_string(e2e_credential_path(dir, account)).map_err(|err| match err.kind() {
        ErrorKind::NotFound => KeychainError::NotFound,
        _ => file_backend_error(err),
    })
}

fn delete_e2e_credential(dir: &Path, account: &str) -> Result<(), KeychainError> {
    fs::remove_file(e2e_credential_path(dir, account)).map_err(|err| match err.kind() {
        ErrorKind::NotFound => KeychainError::NotFound,
        _ => file_backend_error(err),
    })
}

fn e2e_credential_path(dir: &Path, account: &str) -> PathBuf {
    dir.join(format!("{}.secret", hex_encode(account.as_bytes())))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn file_backend_error(err: std::io::Error) -> KeychainError {
    KeychainError::Backend(format!("e2e keychain file backend: {err}"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn e2e_keychain_round_trips_without_secret_service() {
        let dir = env::temp_dir().join(format!(
            "monarch-desktop-keychain-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock before unix epoch")
                .as_nanos()
        ));
        env::set_var("MONARCH_DESKTOP_E2E_KEYCHAIN_DIR", &dir);

        store_credential("operator:mnemonic", "test secret").expect("store e2e credential");
        assert_eq!(
            read_credential("operator:mnemonic").expect("read e2e credential"),
            "test secret"
        );
        delete_credential("operator:mnemonic").expect("delete e2e credential");
        assert!(matches!(
            read_credential("operator:mnemonic"),
            Err(KeychainError::NotFound)
        ));

        env::remove_var("MONARCH_DESKTOP_E2E_KEYCHAIN_DIR");
        let _ = fs::remove_dir_all(dir);
    }
}
