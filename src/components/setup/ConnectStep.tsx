// Step 1 — Connect to your node. THE hero step.
//
// An operator types a node URL or bare IP; "Test connection" runs a LIVE
// reachability probe (`probeNodeEndpoint`) against that exact endpoint —
// chain id, latest height, sync state, client version — without touching the
// shared `rpc` client. On a green probe the endpoint is persisted via
// `setStoredRpcEndpoint` and the step is marked done.
//
// When the RPC probe comes back REFUSED (connection refused / nothing
// listening on :8545 — NOT a timeout), the node may be a freshly flashed
// Monarch OS box sitting in Talos maintenance mode. We follow up with a
// lightweight `talosMaintenanceProbe` against :50000; if it answers an
// unauthenticated Version, the node is unprovisioned and we offer to provision
// it in-app (a distinct banner + `onUnprovisionedDetected`). A refused RPC
// with NO maintenance answer keeps the plain "connection refused" copy — we
// don't offer provisioning, to avoid a false positive on a firewalled-but-
// provisioned node.
//
// The "guide me through installing Monarch OS" toggle routes to the same
// `onUnprovisionedDetected` handler so an operator can force the provision
// branch even before a probe.

import { useCallback, useState } from "react";
import {
  getStoredRpcEndpoint,
  normalizeNodeEndpoint,
  probeNodeEndpoint,
  setStoredRpcEndpoint,
  talosMaintenanceProbe,
  type MaintenanceProbe,
  type NodeProbeResult,
} from "../../sdk";
import { MONARCH_OS_ISO_URL } from "../../sdk/onboarding";
import { CopyButton } from "./CopyButton";
import { StepShell } from "./StepShell";

export type NodePlan = "have-node" | "install";

/**
 * Pull the bare host out of a normalized `http(s)://host:port` endpoint, so the
 * Talos maintenance probe (which targets :50000, not the RPC port) can dial it.
 * Falls back to the raw input if URL parsing fails.
 */
function hostFromEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).hostname || endpoint;
  } catch {
    return endpoint;
  }
}

export function ConnectStep({
  n,
  initialEndpoint,
  plan,
  onPlanChange,
  onConnected,
  onUnprovisionedDetected,
  result,
  onResult,
}: {
  n: number;
  initialEndpoint: string | null;
  plan: NodePlan;
  onPlanChange: (plan: NodePlan) => void;
  /** Called with the normalized, persisted endpoint when the probe is green. */
  onConnected: (endpoint: string) => void;
  /**
   * Called with the node host when the RPC is dead but Talos answers in
   * maintenance mode (detection), or when the operator picks the "install
   * Monarch OS" path manually. Hands provisioning to the wizard.
   */
  onUnprovisionedDetected: (host: string, probe: MaintenanceProbe | null) => void;
  /** Lifted probe result so the wizard can keep it on step re-entry. */
  result: NodeProbeResult | null;
  onResult: (result: NodeProbeResult | null) => void;
}) {
  const [draft, setDraft] = useState(
    () => initialEndpoint ?? getStoredRpcEndpoint() ?? "",
  );
  const [inputError, setInputError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  // Maintenance-mode detection follow-up state.
  const [maintProbing, setMaintProbing] = useState(false);
  const [maint, setMaint] = useState<{ host: string; probe: MaintenanceProbe } | null>(null);

  const runTest = useCallback(async () => {
    setInputError(null);
    onResult(null);
    setMaint(null);
    let normalized: string;
    try {
      normalized = normalizeNodeEndpoint(draft);
    } catch (err) {
      setInputError((err as Error)?.message ?? String(err));
      return;
    }
    // Reflect the normalized form back so the operator sees what we'll save.
    setDraft(normalized);
    setTesting(true);
    try {
      const probe = await probeNodeEndpoint(normalized);
      onResult(probe);
      if (probe.outcome === "ok") {
        setStoredRpcEndpoint(normalized);
        onConnected(normalized);
        return;
      }
      // A refused/unreachable RPC (nothing serving :8545) on a node that IS
      // reachable on the Talos maintenance API means a fresh, unprovisioned
      // Monarch OS box. We only follow up on the "unreachable" outcome — a
      // wrong-chain node is provisioned, just on the wrong network.
      if (probe.outcome === "unreachable") {
        const host = hostFromEndpoint(normalized);
        setMaintProbing(true);
        try {
          const mp = await talosMaintenanceProbe(host);
          if (mp.reachable && mp.maintenance) {
            setMaint({ host, probe: mp });
          }
        } catch {
          // The maintenance probe never rejects, but stay defensive: a failure
          // here just means we keep the plain "connection refused" copy.
        } finally {
          setMaintProbing(false);
        }
      }
    } finally {
      setTesting(false);
    }
  }, [draft, onConnected, onResult]);

  const ok = result?.outcome === "ok";

  // Manual route into provisioning: the operator selected "install Monarch OS".
  // Use whatever host they've typed (best-effort) and hand over with no probe.
  const startManualProvision = useCallback(() => {
    onPlanChange("install");
    let host = draft.trim();
    if (host) {
      try {
        host = hostFromEndpoint(normalizeNodeEndpoint(draft));
      } catch {
        // keep the raw draft
      }
    }
    onUnprovisionedDetected(host, maint?.probe ?? null);
  }, [draft, maint, onPlanChange, onUnprovisionedDetected]);

  return (
    <StepShell
      n={n}
      title="Connect to your node"
      sub="Point Monarch at the node you run. Enter its IP or full RPC URL — a bare address defaults to http on port 8545."
      foot={
        <>
          <span className="setup__foot-spacer" />
          {ok ? (
            <span className="halo halo--ok">
              <span className="dot" /> connected — continue below
            </span>
          ) : null}
        </>
      }
    >
      <div className="setup__field">
        <label className="cap" htmlFor="setup-endpoint">
          node url or ip
        </label>
        <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
          <input
            id="setup-endpoint"
            className={`setup__input setup__input--lg${inputError ? " setup__input--err" : ""}`}
            placeholder="178.105.12.9   ·   http://node.example:8545"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !testing) void runTest();
            }}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void runTest()}
            disabled={testing || draft.trim().length === 0}
            style={{ flex: "0 0 auto" }}
          >
            {testing ? "Testing…" : "Test connection"}
          </button>
        </div>
        {inputError ? (
          <span className="halo halo--err" style={{ alignSelf: "flex-start" }}>
            <span className="dot" /> {inputError}
          </span>
        ) : null}
      </div>

      {result ? (
        <div className={`setup__result ${ok ? "setup__result--ok" : "setup__result--err"}`}>
          {ok ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="halo halo--ok">
                  <span className="dot" /> node reachable
                </span>
                <span className="setup__addr" style={{ flex: 1, padding: "6px 10px", fontSize: 11.5 }}>
                  {result.endpoint}
                  <CopyButton value={result.endpoint} label="Copy endpoint" />
                </span>
              </div>
              <div className="setup__result-grid">
                <div className="setup__stat">
                  <div className="cap">chain id</div>
                  <div className="setup__stat-v setup__stat-v--gold">{result.chainId ?? "—"}</div>
                </div>
                <div className="setup__stat">
                  <div className="cap">block height</div>
                  <div className="setup__stat-v">
                    {result.blockNumber !== null ? result.blockNumber.toLocaleString() : "—"}
                  </div>
                </div>
                <div className="setup__stat">
                  <div className="cap">sync</div>
                  <div className="setup__stat-v">
                    {result.synced === null ? "unknown" : result.synced ? "synced" : "syncing"}
                  </div>
                </div>
                <div className="setup__stat">
                  <div className="cap">node version</div>
                  <div
                    className="setup__stat-v"
                    style={{ fontSize: 11.5, overflowWrap: "anywhere" }}
                    title={result.clientVersion ?? undefined}
                  >
                    {result.clientVersion ?? "—"}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span className="dot" style={{ background: "var(--err)", marginTop: 5, flex: "0 0 auto" }} />
              <div>
                <b style={{ fontSize: 13, color: "var(--fg-100)" }}>
                  {result.outcome === "wrong-chain"
                    ? "Reachable, but the wrong chain"
                    : "Could not reach that node"}
                </b>
                <p style={{ fontSize: 12, color: "var(--fg-300)", margin: "4px 0 0", lineHeight: 1.5 }}>
                  {result.error}
                </p>
                {maintProbing ? (
                  <p style={{ fontSize: 11.5, color: "var(--fg-400)", margin: "6px 0 0" }}>
                    checking whether this is a fresh Monarch OS node…
                  </p>
                ) : null}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* Detection banner: RPC dead, but Talos answered in maintenance mode. */}
      {maint ? (
        <div
          className="halo halo--gold"
          style={{
            marginTop: 14,
            whiteSpace: "normal",
            lineHeight: 1.5,
            alignItems: "flex-start",
            display: "flex",
            gap: 10,
          }}
        >
          <span className="dot" style={{ marginTop: 4, flex: "0 0 auto" }} />
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 13, color: "var(--fg-100)", display: "block" }}>
              Unprovisioned node detected
            </b>
            <span style={{ fontSize: 12, color: "var(--fg-300)", display: "block", marginTop: 3 }}>
              Monarch OS is booted but the node isn't configured yet
              {maint.probe.talosVersion ? ` · Talos ${maint.probe.talosVersion}` : ""}.
            </span>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              style={{ marginTop: 10 }}
              onClick={() => onUnprovisionedDetected(maint.host, maint.probe)}
            >
              Provision this node →
            </button>
          </div>
        </div>
      ) : null}

      <div className="setup__toggle">
        <button
          type="button"
          className={`setup__toggle-opt${plan === "have-node" ? " setup__toggle-opt--on" : ""}`}
          onClick={() => onPlanChange("have-node")}
        >
          <b>I run my own node</b>
          <span>I already have a node (or will run one myself) — just connect to it above.</span>
        </button>
        <button
          type="button"
          className={`setup__toggle-opt${plan === "install" ? " setup__toggle-opt--on" : ""}`}
          onClick={startManualProvision}
        >
          <b>Guide me through installing Monarch OS</b>
          <span>I have a freshly flashed node in maintenance mode — provision it in-app.</span>
        </button>
      </div>

      {plan === "install" && !maint ? (
        <div
          className="halo halo--info"
          style={{ marginTop: 14, whiteSpace: "normal", lineHeight: 1.5, alignItems: "flex-start" }}
        >
          <span className="dot" style={{ marginTop: 4, flex: "0 0 auto" }} />
          <span>
            Flash the signed <b>Monarch OS</b> image to your machine and boot it — it comes up in
            maintenance mode. Enter the node's IP above and hit <b>Test connection</b>: Monarch
            detects the fresh node and walks you through provisioning it.{" "}
            <a href={MONARCH_OS_ISO_URL} target="_blank" rel="noreferrer" style={{ color: "var(--gold)" }}>
              Download Monarch OS ↗
            </a>
          </span>
        </div>
      ) : null}
    </StepShell>
  );
}
