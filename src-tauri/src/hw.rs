// Tauri command surface for the local hardware time-series.
//
// `record_hw_sample` appends one resource snapshot the Hardware view captured
// (from Talos *read* telemetry); `query_hw_samples` returns the trailing window
// the view plots for disk-growth deltas, the fill-time projection, and the
// CPU/RAM sparklines. The SQLite store (`hw_store.rs`) lives behind an async
// Mutex and is opened lazily on first use against the app's local data dir, so
// the browser preview (no Tauri) never touches it.
//
// PURE READ on the node side: nothing here controls the node. The only side
// effect is the local SQLite file under the app data dir.

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use crate::hw_store::{HwSample, HwStore};

/// Lazily-opened hardware store. `None` until the first command opens it; held
/// behind the async Mutex so concurrent records/queries serialize (rusqlite is
/// synchronous and the calls are short).
pub type HwState = Arc<Mutex<Option<HwStore>>>;

/// Build the empty (unopened) state for `tauri::Builder::manage`.
pub fn new_state() -> HwState {
    Arc::new(Mutex::new(None))
}

/// Open the store against the app's local data dir on first use; subsequent
/// calls reuse the held connection. Errors are returned as strings so the
/// command boundary stays `Result<_, String>`.
async fn with_store<T>(
    app: &AppHandle,
    state: &HwState,
    f: impl FnOnce(&HwStore) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state.lock().await;
    if guard.is_none() {
        let dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("could not resolve app data dir: {e}"))?;
        let store = HwStore::open(&dir).map_err(|e| e.to_string())?;
        *guard = Some(store);
    }
    let store = guard
        .as_ref()
        .expect("hardware store was just opened above");
    f(store)
}

/// Append one resource sample to the local time-series. Best-effort: a failed
/// insert surfaces as an error but never blocks the live snapshot the view is
/// already showing.
#[tauri::command]
pub async fn record_hw_sample(
    app: AppHandle,
    state: State<'_, HwState>,
    sample: HwSample,
) -> Result<(), String> {
    with_store(&app, &state, |store| {
        store.insert_sample(&sample).map_err(|e| e.to_string())
    })
    .await
}

/// All persisted samples with `ts >= sinceMs`, oldest first. Used by the
/// Hardware view to read the 24/48/72h window for growth + projection and to
/// plot the CPU/RAM sparklines.
#[tauri::command]
pub async fn query_hw_samples(
    app: AppHandle,
    state: State<'_, HwState>,
    since_ms: i64,
) -> Result<Vec<HwSample>, String> {
    with_store(&app, &state, |store| {
        store.samples_since(since_ms).map_err(|e| e.to_string())
    })
    .await
}
