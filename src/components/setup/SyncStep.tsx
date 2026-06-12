// Step 5 — Sync.
//
// A node that's still importing blocks isn't ready to register or sign. This
// polls `eth_syncing`: while it returns a status object the node is catching
// up, so we draw a progress bar from currentBlock vs highestBlock; when it
// returns `null` the node is caught up and the step is marked done. The live
// height from `useNodeStatus` is shown alongside so the operator sees the chain
// ticking. On a single self-run node already at the tip, `eth_syncing` is null
// from the first poll and the step completes immediately — which is correct.

import { useCallback, useEffect, useRef, useState } from "react";
import { rpc, useNodeStatus } from "../../sdk";
import { StepShell } from "./StepShell";

const POLL_MS = 3_000;

type SyncState =
  | { kind: "checking" }
  | { kind: "syncing"; current: number; highest: number }
  | { kind: "synced" }
  | { kind: "error"; message: string };

export function SyncStep({ n, onSynced }: { n: number; onSynced: () => void }) {
  const node = useNodeStatus();
  const [state, setState] = useState<SyncState>({ kind: "checking" });
  const firedRef = useRef(false);

  const poll = useCallback(async () => {
    try {
      const sync = await rpc.ethSyncing();
      if (sync === null) {
        setState({ kind: "synced" });
        if (!firedRef.current) {
          firedRef.current = true;
          onSynced();
        }
        return;
      }
      const current = Number.parseInt(sync.currentBlock, 16) || Number(sync.currentBlock) || 0;
      const highest = Number.parseInt(sync.highestBlock, 16) || Number(sync.highestBlock) || 0;
      setState({ kind: "syncing", current, highest });
    } catch (err) {
      setState({ kind: "error", message: (err as Error)?.message ?? String(err) });
    }
  }, [onSynced]);

  useEffect(() => {
    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(id);
  }, [poll]);

  const pct =
    state.kind === "syncing" && state.highest > 0
      ? Math.min(100, Math.round((state.current / state.highest) * 100))
      : state.kind === "synced"
        ? 100
        : 0;

  return (
    <StepShell
      n={n}
      title="Let your node sync"
      sub="Your node must catch up to the chain head before it can register and sign. This tracks its progress live."
    >
      <div className="setup__result-grid">
        <div className="setup__stat">
          <div className="cap">local height</div>
          <div className="setup__stat-v">
            {node.blockNumber !== null ? node.blockNumber.toLocaleString() : "—"}
          </div>
        </div>
        <div className="setup__stat">
          <div className="cap">round</div>
          <div className="setup__stat-v">
            {node.currentRound !== null ? node.currentRound.toLocaleString() : "—"}
          </div>
        </div>
        <div className="setup__stat">
          <div className="cap">state</div>
          <div
            className="setup__stat-v"
            style={{ color: state.kind === "synced" ? "var(--ok)" : "var(--fg-100)" }}
          >
            {state.kind === "synced"
              ? "synced"
              : state.kind === "syncing"
                ? "catching up"
                : state.kind === "error"
                  ? "unknown"
                  : "checking"}
          </div>
        </div>
      </div>

      <div className="setup__sync-track" aria-label="sync progress">
        <div
          className={`setup__sync-fill${state.kind === "synced" ? " setup__sync-fill--ok" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="setup__foot">
        {state.kind === "synced" ? (
          <span className="halo halo--ok"><span className="dot" /> node caught up</span>
        ) : state.kind === "error" ? (
          <span className="halo halo--warn">
            <span className="dot" /> can't read sync state ({state.message}) — if the node is reachable
            you can continue.
          </span>
        ) : (
          <span className="halo halo--info">
            <span className="dot dot--pulse" />
            {state.kind === "syncing"
              ? ` block ${state.current.toLocaleString()} / ${state.highest.toLocaleString()} (${pct}%)`
              : " checking sync state…"}
          </span>
        )}
      </div>
    </StepShell>
  );
}
