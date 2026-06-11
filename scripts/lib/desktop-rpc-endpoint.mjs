// Pure RPC-endpoint resolution for the Desktop e2e harness.
//
// Lives in its own side-effect-free module (no shebang, no top-level state,
// no node: imports) so the cross-platform release-readiness gate can unit-test
// it without parsing the full e2e orchestration script — which only ever runs
// on the Linux gui-e2e runner.

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

export function resolveDesktopRpcEndpoint(e2eOptions = {}, smokeEnv = {}, environment = {}) {
  return firstNonEmpty(
    e2eOptions.expectedRpcEndpoint,
    environment.MONARCH_E2E_DESKTOP_RPC_ENDPOINT,
    environment.MONARCH_E2E_RPC_ENDPOINT,
    smokeEnv.MONARCH_E2E_RPC_ENDPOINT,
    environment.VITE_RPC_ENDPOINT,
    environment.TAURI_RPC_ENDPOINT,
  );
}
