// Step 4 — Configure (conditional / skippable).
//
// When the node is Talos-paired (Monarch OS), this surfaces the live
// `talos_config_info` — endpoint, context, CA pin status, node list — so the
// operator can sanity-check what they're pointed at. When there's no Talos
// channel (a plain node the operator runs themselves), it falls back to the
// resolved RPC endpoint + the chain params read from the connect probe, behind
// an "advanced" expander. Either way the operator can skip: config is theirs
// to manage. Nothing here writes config — it's a review surface.

import { useEffect, useState } from "react";
import { inTauri, talosConfigInfo, talosStatus, type TalosConfigInfo } from "../../sdk";
import type { NodeProbeResult } from "../../sdk";
import { StepShell } from "./StepShell";

type ConfigState =
  | { kind: "loading" }
  | { kind: "browser" }
  | { kind: "paired"; config: TalosConfigInfo }
  | { kind: "unpaired"; reason: string | null };

export function ConfigStep({
  n,
  endpoint,
  probe,
}: {
  n: number;
  endpoint: string;
  probe: NodeProbeResult | null;
}) {
  const [state, setState] = useState<ConfigState>({ kind: "loading" });
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!inTauri()) {
        if (!cancelled) setState({ kind: "browser" });
        return;
      }
      try {
        const status = await talosStatus().catch(() => null);
        if (status?.configured) {
          const config = await talosConfigInfo().catch(() => null);
          if (cancelled) return;
          if (config) {
            setState({ kind: "paired", config });
            return;
          }
        }
        if (!cancelled) {
          setState({ kind: "unpaired", reason: status?.lastError ?? null });
        }
      } catch (err) {
        if (!cancelled) setState({ kind: "unpaired", reason: (err as Error)?.message ?? String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <StepShell
      n={n}
      title="Check your node config"
      sub="Confirm Monarch is pointed at the right node and chain. This step is optional — skip it if you manage config yourself."
    >
      {state.kind === "loading" ? (
        <div className="halo halo--info" style={{ alignSelf: "flex-start" }}>
          <span className="dot dot--pulse" /> reading node config…
        </div>
      ) : null}

      {state.kind === "paired" ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div className="halo halo--ok" style={{ alignSelf: "flex-start" }}>
            <span className="dot" /> Monarch OS node paired (Talos control channel)
          </div>
          <div className="kv"><span className="kv__k">endpoint</span><span className="kv__v mono">{state.config.endpoint}</span></div>
          <div className="kv"><span className="kv__k">context</span><span className="kv__v mono">{state.config.context}</span></div>
          <div className="kv"><span className="kv__k">server name</span><span className="kv__v mono">{state.config.serverName || "—"}</span></div>
          <div className="kv">
            <span className="kv__k">CA pin</span>
            <span className={`kv__v mono ${state.config.caPinStatus === "matched" ? "" : ""}`}>
              {state.config.caPinStatus}
            </span>
          </div>
          {state.config.nodes.length > 0 ? (
            <div className="kv"><span className="kv__k">nodes</span><span className="kv__v mono">{state.config.nodes.join(", ")}</span></div>
          ) : null}
          {state.config.warnings.length > 0 ? (
            <div className="halo halo--warn" style={{ alignSelf: "flex-start", whiteSpace: "normal" }}>
              <span className="dot" /> {state.config.warnings.join(" · ")}
            </div>
          ) : null}
        </div>
      ) : null}

      {state.kind === "unpaired" || state.kind === "browser" ? (
        <div style={{ display: "grid", gap: 10 }}>
          <p style={{ fontSize: 12.5, color: "var(--fg-300)", margin: 0, lineHeight: 1.5 }}>
            {state.kind === "browser"
              ? "No Talos control channel in the browser preview — Monarch reads this node over plain RPC."
              : "No Monarch OS (Talos) control channel detected — Monarch is talking to this node over plain RPC. That's fine for a node you run yourself."}
          </p>
          <div className="kv"><span className="kv__k">rpc endpoint</span><span className="kv__v mono">{endpoint}</span></div>
          <div className="kv"><span className="kv__k">chain id</span><span className="kv__v mono">{probe?.chainId ?? "—"}</span></div>
          <div className="kv"><span className="kv__k">latest block</span><span className="kv__v mono">{probe?.blockNumber !== null && probe?.blockNumber !== undefined ? probe.blockNumber.toLocaleString() : "—"}</span></div>

          <button
            type="button"
            className="btn btn--ghost btn--sm"
            style={{ alignSelf: "flex-start" }}
            onClick={() => setAdvanced((v) => !v)}
          >
            {advanced ? "Hide advanced" : "Advanced ▾"}
          </button>
          {advanced ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div className="kv"><span className="kv__k">node version</span><span className="kv__v mono" style={{ overflowWrap: "anywhere" }}>{probe?.clientVersion ?? "—"}</span></div>
              <div className="kv"><span className="kv__k">sync</span><span className="kv__v mono">{probe?.synced === null || probe?.synced === undefined ? "unknown" : probe.synced ? "synced" : "syncing"}</span></div>
              <p style={{ fontSize: 11, color: "var(--fg-400)", margin: 0, lineHeight: 1.5 }}>
                To change the endpoint, go back to step 1. To manage protocore config on a Monarch OS
                node, pair it on the Install page and use Hardware / Operations.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </StepShell>
  );
}
