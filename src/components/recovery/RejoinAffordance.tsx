// RejoinAffordance — always-available entry point on the Install view for an
// operator whose node is stuck on an abandoned chain after a testnet
// re-genesis. The chain re-genesises without notice; a node last synced before
// the latest re-genesis sits at a frozen height with no peers — and its OWN RPC
// still answers, so it is NOT flagged "quarantined" and the auto-surfaced
// RecoveryMenu never triggers. This makes the same audited, seat-preserving
// recovery paths reachable on demand. Collapsed by default (no false alarms on a
// healthy node); opening it just reveals the recovery options — no action runs
// until the operator picks one and authorizes it through the Operations drawer.

import { useState } from "react";
import { RecoveryMenu } from "./RecoveryMenu";

export function RejoinAffordance() {
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <div style={{ marginBottom: 16 }}>
        <RecoveryMenu reason={null} variant="rejoin" />
        <div style={{ textAlign: "center", marginTop: 8 }}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setOpen(false)}
          >
            Hide rejoin options
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="card card--padded"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: "var(--fg-100)" }}>
          Stuck on an old chain after a re-genesis?
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-400)", marginTop: 4, lineHeight: 1.5 }}>
          testnet re-genesises without notice. if your node is frozen with no peers, clear
          the stale chain data and rejoin the current chain — your bonded seat is preserved
          when your operator mnemonic is in this computer's keychain.
        </div>
      </div>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => setOpen(true)}
        style={{ whiteSpace: "nowrap" }}
      >
        Rejoin the current chain
      </button>
    </div>
  );
}
