// Role step — "What are you running?" The fork between a relay/full node and a
// signing operator.
//
// The owner's explicit ask: people should be able to run a relay FIRST without
// being dragged through bond / key / register. So once the node is connected
// (and provisioned, if it was fresh) we ask the operator to choose:
//
//   * Relay / full node — you're contributing: the node syncs and serves RPC.
//     The wizard ENDS here. No key, no bond, no registration.
//   * Operator — continue to key → fund → register (→ cluster later).
//
// This is NOT a one-time fork: a relay operator reaches a clean done state from
// which "Become an operator" is always reachable — it flips the role and the
// wizard unlocks the operator steps. Choosing relay never strands anyone.

import { CopyButton } from "./CopyButton";
import { StepShell } from "./StepShell";

export type NodeRole = "undecided" | "relay" | "operator";

export function RoleStep({
  n,
  role,
  endpoint,
  onChoose,
  onContinueOperator,
  onEnterConsole,
}: {
  n: number;
  role: NodeRole;
  /** Live RPC endpoint, shown in the relay done state. */
  endpoint: string;
  /** Records the choice; flips `role` and marks the step done. */
  onChoose: (role: NodeRole) => void;
  /** Advance into the operator steps (key → fund → register). */
  onContinueOperator: () => void;
  /** Leave the wizard for the main console (relay done state). */
  onEnterConsole: () => void;
}) {
  return (
    <StepShell
      n={n}
      title="What are you running?"
      sub="Your node is connected. Run it as a relay to contribute right away, or set it up as a signing operator."
    >
      <div className="setup__toggle">
        <button
          type="button"
          className={`setup__toggle-opt${role === "relay" ? " setup__toggle-opt--on" : ""}`}
          onClick={() => onChoose("relay")}
        >
          <b>Relay / full node</b>
          <span>
            You're contributing — the node syncs the chain and serves RPC. No bond, no key, no
            registration. You can become an operator later.
          </span>
        </button>
        <button
          type="button"
          className={`setup__toggle-opt${role === "operator" ? " setup__toggle-opt--on" : ""}`}
          onClick={() => onChoose("operator")}
        >
          <b>Operator (signing)</b>
          <span>
            You'll create an operator key, fund the bond, and register on-chain so your node can
            join a cluster and sign.
          </span>
        </button>
      </div>

      {role === "relay" ? (
        <div className="setup__result setup__result--ok" style={{ marginTop: 16 }}>
          <div className="halo halo--ok" style={{ alignSelf: "flex-start" }}>
            <span className="dot" /> You're running a relay
          </div>
          <p style={{ fontSize: 12.5, color: "var(--fg-300)", margin: "8px 0 0", lineHeight: 1.5 }}>
            It's syncing and serving RPC. Nothing else is required — your node already contributes to
            the network.
          </p>
          <div className="setup__addr" style={{ marginTop: 10, fontSize: 11.5 }}>
            {endpoint}
            <CopyButton value={endpoint} label="Copy endpoint" />
          </div>
          <div className="setup__foot" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onChoose("operator")}
            >
              Become an operator →
            </button>
            <span className="setup__foot-spacer" />
            <button type="button" className="btn btn--primary" onClick={onEnterConsole}>
              Enter console →
            </button>
          </div>
        </div>
      ) : null}

      {role === "operator" ? (
        <div className="setup__foot" style={{ marginTop: 16 }}>
          <span style={{ fontSize: 12.5, color: "var(--fg-300)", lineHeight: 1.5 }}>
            Next: create or import your operator key, fund the bond, then register on-chain.
          </span>
          <span className="setup__foot-spacer" />
          <button type="button" className="btn btn--primary" onClick={onContinueOperator}>
            Continue → operator key
          </button>
        </div>
      ) : null}
    </StepShell>
  );
}
