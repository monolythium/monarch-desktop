// Step 5 — Sync.
//
// A node that's still importing blocks isn't ready to register or sign. The
// authoritative signal is `lyth_syncStatus` (localRound vs the highest round a
// peer has advertised); we only call the node "synced" when it has actually
// caught up to the committee — NOT merely when `eth_syncing` returns null. A
// cold-start node sits at `localRound 0` with a far-ahead `peerMaxRound` while
// it fast-syncs from a checkpoint; `eth_syncing` can report null in that window
// even though the node is nowhere near the head, which is exactly how the old
// check painted "synced" at height 0 while the topbar correctly said "syncing".
// `eth_syncing` is kept only as a fallback for nodes that don't serve
// `lyth_syncStatus` (and even then we require a non-zero height before claiming
// synced).

import { useCallback, useEffect, useRef, useState } from "react";
import { rpc, useNodeStatus } from "../../sdk";
import { StepShell } from "./StepShell";

const POLL_MS = 3_000;
// Within a handful of rounds of the committee head counts as caught up — the
// chain advances every few seconds, so the local round trails the freshest
// advertised round by a small margin even on a healthy node.
const SYNCED_LAG = 5;

type LythSyncStatus = {
  lag: number;
  localRound: number;
  peerMaxRound: number;
  state: string;
};

type SyncState =
  | { kind: "checking" }
  | { kind: "syncing"; current: number; highest: number }
  | { kind: "synced" }
  | { kind: "error"; message: string };

export function SyncStep({ n, onSynced }: { n: number; onSynced: () => void }) {
  const node = useNodeStatus();
  const [state, setState] = useState<SyncState>({ kind: "checking" });
  const firedRef = useRef(false);

  const markSynced = useCallback(() => {
    setState({ kind: "synced" });
    if (!firedRef.current) {
      firedRef.current = true;
      onSynced();
    }
  }, [onSynced]);

  const poll = useCallback(async () => {
    try {
      // Primary signal: how far the local round trails the committee head.
      const status = await rpc
        .call<LythSyncStatus>("lyth_syncStatus", [])
        .catch(() => null);
      if (status) {
        const peerMax = Number(status.peerMaxRound) || 0;
        const local = Number(status.localRound) || 0;
        const lag = Number(status.lag) || Math.max(0, peerMax - local);
        if (peerMax > 0) {
          // We know a peer is ahead: caught up only when the gap is tiny AND
          // we've actually left round 0. A node at local 0 with a far-ahead
          // peer is syncing, full stop.
          if (lag <= SYNCED_LAG && local > 0) {
            markSynced();
          } else {
            setState({ kind: "syncing", current: local, highest: peerMax });
          }
          return;
        }
        // No peer reports a higher round. Genuinely alone or just-booted —
        // fall through to eth_syncing, but never call height 0 "synced".
      }

      const sync = await rpc.ethSyncing();
      const height = node.blockNumber ?? Number(status?.localRound ?? 0);
      if (sync === null) {
        if (height > 0) {
          markSynced();
        } else {
          setState({ kind: "checking" });
        }
        return;
      }
      const current = Number.parseInt(sync.currentBlock, 16) || Number(sync.currentBlock) || 0;
      const highest = Number.parseInt(sync.highestBlock, 16) || Number(sync.highestBlock) || 0;
      setState({ kind: "syncing", current, highest });
    } catch (err) {
      setState({ kind: "error", message: (err as Error)?.message ?? String(err) });
    }
  }, [markSynced, node.blockNumber]);

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
              ? ` round ${state.current.toLocaleString()} / ${state.highest.toLocaleString()} (${pct}%)`
              : " checking sync state…"}
          </span>
        )}
      </div>
    </StepShell>
  );
}
