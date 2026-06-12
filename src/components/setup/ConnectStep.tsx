// Step 1 — Connect to your node. THE hero step.
//
// An operator types a node URL or bare IP; "Test connection" runs a LIVE
// reachability probe (`probeNodeEndpoint`) against that exact endpoint —
// chain id, latest height, sync state, client version — without touching the
// shared `rpc` client. On a green probe the endpoint is persisted via
// `setStoredRpcEndpoint` and the step is marked done. The "guide me / I have
// a node" toggle is the owner's "install monarchos (checkbox for yourself)":
// it just records intent so the Configure step can adapt its copy; the live
// probe is the same either way.

import { useCallback, useState } from "react";
import {
  getStoredRpcEndpoint,
  normalizeNodeEndpoint,
  probeNodeEndpoint,
  setStoredRpcEndpoint,
  type NodeProbeResult,
} from "../../sdk";
import { MONARCH_OS_ISO_URL } from "../../sdk/onboarding";
import { CopyButton } from "./CopyButton";
import { StepShell } from "./StepShell";

export type NodePlan = "have-node" | "install";

export function ConnectStep({
  n,
  initialEndpoint,
  plan,
  onPlanChange,
  onConnected,
  result,
  onResult,
}: {
  n: number;
  initialEndpoint: string | null;
  plan: NodePlan;
  onPlanChange: (plan: NodePlan) => void;
  /** Called with the normalized, persisted endpoint when the probe is green. */
  onConnected: (endpoint: string) => void;
  /** Lifted probe result so the wizard can keep it on step re-entry. */
  result: NodeProbeResult | null;
  onResult: (result: NodeProbeResult | null) => void;
}) {
  const [draft, setDraft] = useState(
    () => initialEndpoint ?? getStoredRpcEndpoint() ?? "",
  );
  const [inputError, setInputError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const runTest = useCallback(async () => {
    setInputError(null);
    onResult(null);
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
      }
    } finally {
      setTesting(false);
    }
  }, [draft, onConnected, onResult]);

  const ok = result?.outcome === "ok";

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
              </div>
            </div>
          )}
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
          onClick={() => onPlanChange("install")}
        >
          <b>Guide me through installing Monarch OS</b>
          <span>I don't have a node yet — show me how to flash the signed image and pair it.</span>
        </button>
      </div>

      {plan === "install" ? (
        <div
          className="halo halo--info"
          style={{ marginTop: 14, whiteSpace: "normal", lineHeight: 1.5, alignItems: "flex-start" }}
        >
          <span className="dot" style={{ marginTop: 4, flex: "0 0 auto" }} />
          <span>
            Flash the signed <b>Monarch OS</b> image to your machine, boot it, and pair it from the
            Install page — then come back and enter the node's IP above.{" "}
            <a href={MONARCH_OS_ISO_URL} target="_blank" rel="noreferrer" style={{ color: "var(--gold)" }}>
              Download Monarch OS ↗
            </a>
          </span>
        </div>
      ) : null}
    </StepShell>
  );
}
