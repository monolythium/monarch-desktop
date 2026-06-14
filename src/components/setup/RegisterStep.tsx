// Step 6 — Register & connect.
//
// Reads the local operator's on-chain registration state (`useSelfOperator`).
// If not yet registered, "Register operator" launches the REAL register flow:
// the canonical `operator-register` catalog entry through the shared Operations
// drawer (`useOps().requestOp`), prefilled with the connected endpoint, the RPC
// capability, and the 5,000 LYTH bond floor. The drawer then runs the same
// signed encrypted register tx the Operations page uses — this step does not
// reimplement signing. If already registered (or once the drawer reports the
// row), the primary action becomes "Enter console" and routes to /home.

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { formatLyth } from "@monolythium/core-sdk";
import { OP_CATALOG, useOps, type OpRequest } from "../../ops";
import { useSelfOperator } from "../../hooks/useSelfOperator";
import { MIN_REGISTER_BOND_LYTH, MIN_REGISTER_BOND_LYTHOSHI } from "../../sdk/onboarding";
import { CopyButton } from "./CopyButton";
import { StepShell } from "./StepShell";

// The RPC capability bit (mirrors NODE_REGISTRY_CAPABILITIES / RegisterForm):
// a registering operator advertises at least JSON-RPC.
const RPC_CAPABILITY = 0x0001;

function buildRegisterRequest(endpoint: string): OpRequest | null {
  const entry = OP_CATALOG.find((candidate) => candidate.kind === "operator-register");
  if (!entry) return null;
  return {
    kind: entry.kind,
    title: entry.title,
    sub: entry.sub,
    intro: entry.intro,
    fields: entry.fields,
    effects: entry.effects,
    diff: entry.diff,
    icon: entry.icon,
    risk: entry.risk,
    destructive: entry.destructive,
    needsPasskey: entry.needsPasskey,
    confirmLabel: entry.confirmLabel,
    // Prefill what the wizard already knows; the operator can still tune
    // capabilities / bond in the drawer form before signing.
    registerInput: {
      endpoint,
      capabilities: RPC_CAPABILITY,
      bondLythoshi: MIN_REGISTER_BOND_LYTHOSHI.toString(),
    },
  };
}

export function RegisterStep({
  n,
  endpoint,
  onDone,
}: {
  n: number;
  endpoint: string;
  /** Optional: notify the wizard the operator finished (used to mark the step). */
  onDone?: () => void;
}) {
  const navigate = useNavigate();
  const ops = useOps();
  const self = useSelfOperator();

  const registered = self.registered === true;
  const knowsKey = self.status === "ready";

  // The register tx is signed and submitted inside the shared Operations
  // drawer (`launchRegister` → `ops.requestOp`), so this step never sees the
  // submit return value directly. Watch the drawer lifecycle instead: once the
  // operator-register op settles in the `done` stage with a successful result,
  // notify the wizard so it advances past this step — otherwise a successful
  // register silently strands the user here and setup appears to start over.
  // Guarded with a ref so it fires exactly once per completed op.
  const registerDoneNotified = useRef(false);
  useEffect(() => {
    if (ops.request?.kind !== "operator-register") {
      // A different op (or none) is in the drawer — reset so the next
      // register completion can notify again.
      registerDoneNotified.current = false;
      return;
    }
    if (ops.stage === "done" && ops.result?.ok && !registerDoneNotified.current) {
      registerDoneNotified.current = true;
      onDone?.();
    }
  }, [ops.request?.kind, ops.stage, ops.result?.ok, onDone]);

  const launchRegister = () => {
    const req = buildRegisterRequest(endpoint);
    if (req) ops.requestOp(req);
  };

  const enterConsole = () => {
    onDone?.();
    navigate("/home");
  };

  return (
    <StepShell
      n={n}
      title={registered ? "You're registered — enter the console" : "Register your operator"}
      sub={
        registered
          ? "Your operator is registered on-chain. From here you can join or form a cluster and start signing."
          : "Lock the bond and list your node on-chain so clusters can admit you. This opens the Operations drawer, where you preview and sign the register tx."
      }
      foot={
        <>
          {registered ? (
            <button type="button" className="btn btn--primary" onClick={enterConsole}>
              Enter console →
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={launchRegister}
              disabled={self.status === "no-key"}
            >
              Register operator
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={enterConsole}>
            Skip — go to console
          </button>
          <span className="setup__foot-spacer" />
          {registered ? (
            <span className="halo halo--ok"><span className="dot" /> registered</span>
          ) : self.registered === false ? (
            <span className="halo halo--warn"><span className="dot" /> not registered yet</span>
          ) : (
            <span className="halo halo--info"><span className="dot dot--pulse" /> checking registry…</span>
          )}
        </>
      }
    >
      {self.status === "no-key" ? (
        <div className="halo halo--err" style={{ alignSelf: "flex-start", whiteSpace: "normal" }}>
          <span className="dot" /> No operator key found — go back to the key step and create or import
          one before registering.
        </div>
      ) : null}

      {knowsKey && self.address ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <div className="cap" style={{ marginBottom: 6 }}>operator account</div>
            <div className="setup__addr">
              {self.address}
              <CopyButton value={self.address} label="Copy operator address" />
            </div>
          </div>
          <div className="setup__result-grid">
            <div className="setup__stat">
              <div className="cap">registration</div>
              <div
                className="setup__stat-v"
                style={{ color: registered ? "var(--ok)" : "var(--fg-100)" }}
              >
                {registered ? "registered" : self.registered === false ? "not yet" : "unknown"}
              </div>
            </div>
            <div className="setup__stat">
              <div className="cap">bond</div>
              <div className="setup__stat-v setup__stat-v--gold">
                {formatLyth(MIN_REGISTER_BOND_LYTHOSHI)}
              </div>
            </div>
            <div className="setup__stat">
              <div className="cap">cluster seat</div>
              <div className="setup__stat-v">{self.clusterId !== null ? `#${self.clusterId}` : "—"}</div>
            </div>
          </div>
        </div>
      ) : null}

      <p style={{ fontSize: 11.5, color: "var(--fg-400)", margin: "14px 0 0", lineHeight: 1.5 }}>
        Registering posts a signed tx to the node-registry (precompile 0x1005) and locks{" "}
        {MIN_REGISTER_BOND_LYTH.toLocaleString()} LYTH from your operator wallet. The bond is
        refundable after you resign and the delay passes.
      </p>
    </StepShell>
  );
}
