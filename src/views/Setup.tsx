// Setup — the first-run wizard. This is what a brand-new operator hits, NOT
// the auto-detect checklist (that lives at /welcome as "Setup status", a
// useful secondary view for partial states). The flow follows the owner's
// brief: connect to your node FIRST, optionally provision a fresh Monarch OS
// box, then decide what you're running — a relay/full node (you're done) or an
// operator (key → fund → register).
//
// The node-connect step is the hero and stays editable: the rail lets the
// operator jump back to it any time, and the live endpoint is persisted via
// `setStoredRpcEndpoint` the moment the probe is green. Steps are gated — you
// can't fund before you have a key — but never fabricate progress: each step's
// "done" comes from a real signal (green probe, applied config + live RPC,
// stored key, balance ≥ bond, eth_syncing == null, on-chain registration).
//
// Two pieces of conditional state drive which steps appear:
//   * provisionState — `hidden` until the connect step detects a fresh
//     maintenance-mode node; an operator who already has a live RPC node never
//     sees the provision step.
//   * nodeRole — `undecided` until the role step; `relay` ends the wizard,
//     `operator` unlocks key/fund/register. A relay operator can become an
//     operator later from the relay done state.

import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getStoredRpcEndpoint,
  rpcEndpoint,
  type MaintenanceProbe,
  type NodeProbeResult,
} from "../sdk";
import { ConnectStep, type NodePlan } from "../components/setup/ConnectStep";
import { ProvisionStep } from "../components/setup/ProvisionStep";
import { RoleStep, type NodeRole } from "../components/setup/RoleStep";
import { KeyStep } from "../components/setup/KeyStep";
import { FundStep } from "../components/setup/FundStep";
import { ConfigStep } from "../components/setup/ConfigStep";
import { SyncStep } from "../components/setup/SyncStep";
import { RegisterStep } from "../components/setup/RegisterStep";
import "../styles/setup.css";

type StepId = "connect" | "provision" | "role" | "key" | "fund" | "config" | "sync" | "register";

// Lifecycle of the (conditional) provision step. `hidden` = the operator has a
// live node and never needs it; `offered`/`active` = the connect step detected
// a fresh maintenance-mode node; `done` = it serves RPC now.
type ProvisionState = "hidden" | "offered" | "active" | "done";

const STEP_LABELS: Record<StepId, string> = {
  connect: "Connect node",
  provision: "Provision node",
  role: "Relay or operator",
  key: "Operator key",
  fund: "Fund bond",
  config: "Config",
  sync: "Sync",
  register: "Register",
};

// Canonical linear order. The visible subset is derived per-render from
// provisionState + nodeRole.
const STEP_ORDER: readonly StepId[] = [
  "connect",
  "provision",
  "role",
  "key",
  "fund",
  "config",
  "sync",
  "register",
];

// Operator-only steps — hidden on the relay path entirely.
const OPERATOR_ONLY: ReadonlySet<StepId> = new Set(["key", "fund", "register"]);

export function Setup() {
  const navigate = useNavigate();

  // The endpoint persisted by the connect/provision step (or already stored).
  const [endpoint, setEndpoint] = useState<string | null>(() => getStoredRpcEndpoint());
  const [probe, setProbe] = useState<NodeProbeResult | null>(null);
  const [plan, setPlan] = useState<NodePlan>("have-node");
  const [keyAddress, setKeyAddress] = useState<string | null>(null);

  // Conditional flow state.
  const [provisionState, setProvisionState] = useState<ProvisionState>("hidden");
  const [provisionHost, setProvisionHost] = useState<string>("");
  const [provisionProbe, setProvisionProbe] = useState<MaintenanceProbe | null>(null);
  const [nodeRole, setNodeRole] = useState<NodeRole>("undecided");

  // Per-step completion. Each flips from a real signal; config is advisory and
  // always considered satisfiable (skippable). `role` flips once chosen.
  const [done, setDone] = useState<Record<StepId, boolean>>({
    connect: false,
    provision: false,
    role: false,
    key: false,
    fund: false,
    config: false,
    sync: false,
    register: false,
  });
  const markDone = useCallback((id: StepId) => {
    setDone((prev) => (prev[id] ? prev : { ...prev, [id]: true }));
  }, []);

  const [active, setActive] = useState<StepId>("connect");

  // Steps visible right now. Provision appears only once offered/active/done;
  // operator-only steps appear only on the operator path.
  const visibleSteps = useMemo<StepId[]>(() => {
    return STEP_ORDER.filter((id) => {
      if (id === "provision") return provisionState !== "hidden";
      if (OPERATOR_ONLY.has(id)) return nodeRole === "operator";
      return true;
    });
  }, [provisionState, nodeRole]);

  const activeIdx = visibleSteps.findIndex((s) => s === active);

  // A step is reachable once its gating prerequisites are met. Connect gates
  // everything; provision (when shown) gates the rest; role follows; the
  // operator branch gates key→fund→register. Config + sync are skippable.
  const reachable = useCallback(
    (id: StepId): boolean => {
      const connected = done.connect;
      switch (id) {
        case "connect":
          return true;
        case "provision":
          return provisionState !== "hidden";
        case "role":
          return connected;
        case "key":
          return connected && nodeRole === "operator";
        case "fund":
          return connected && nodeRole === "operator" && done.key;
        case "config":
          return connected;
        case "sync":
          return connected;
        case "register":
          return connected && nodeRole === "operator" && done.key;
      }
    },
    [done, provisionState, nodeRole],
  );

  const onConnected = useCallback(
    (next: string) => {
      setEndpoint(next);
      markDone("connect");
    },
    [markDone],
  );

  // The connect step detected (or the operator forced) a fresh node. Surface
  // the provision step and jump to it.
  const onUnprovisionedDetected = useCallback(
    (host: string, mp: MaintenanceProbe | null) => {
      setProvisionHost(host);
      setProvisionProbe(mp);
      setProvisionState("active");
      setActive("provision");
    },
    [],
  );

  // Provisioning brought the node up on RPC: mark connect + provision done and
  // move the operator to the role choice.
  const onProvisioned = useCallback(
    (host: string) => {
      const ep = `http://${host}:8545`;
      setEndpoint(ep);
      setProvisionState("done");
      markDone("provision");
      markDone("connect");
      setActive("role");
    },
    [markDone],
  );

  const onRoleChosen = useCallback(
    (role: NodeRole) => {
      setNodeRole(role);
      markDone("role");
    },
    [markDone],
  );

  const goNext = useCallback(() => {
    const next = visibleSteps[activeIdx + 1];
    if (next && reachable(next)) setActive(next);
  }, [visibleSteps, activeIdx, reachable]);

  const goPrev = useCallback(() => {
    const prev = visibleSteps[activeIdx - 1];
    if (prev) setActive(prev);
  }, [visibleSteps, activeIdx]);

  const liveEndpoint = endpoint ?? rpcEndpoint;

  const railNode = useMemo(
    () => (
      <div className="card setup__rail">
        {visibleSteps.map((id, i) => {
          const can = reachable(id);
          const cls = [
            "setup__rail-step",
            id === active ? "setup__rail-step--current" : "",
            done[id] ? "setup__rail-step--done" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={id}
              type="button"
              className={cls}
              disabled={!can}
              onClick={() => can && setActive(id)}
              title={can ? undefined : "Finish the earlier steps first"}
            >
              <span className="setup__rail-num">{done[id] ? "✓" : i + 1}</span>
              {STEP_LABELS[id]}
            </button>
          );
        })}
      </div>
    ),
    [visibleSteps, active, done, reachable],
  );

  // The 1-based display number for the active step within the visible list.
  const stepNum = activeIdx >= 0 ? activeIdx + 1 : 1;

  // Footer nav shared by the steps that don't render their own primary CTA.
  const linearFoot = (canAdvance: boolean) => (
    <>
      {activeIdx > 0 ? (
        <button type="button" className="btn btn--ghost" onClick={goPrev}>
          ← Back
        </button>
      ) : null}
      <span className="setup__foot-spacer" />
      <button
        type="button"
        className="btn btn--primary"
        onClick={goNext}
        disabled={!canAdvance || activeIdx >= visibleSteps.length - 1}
      >
        Continue →
      </button>
    </>
  );

  return (
    <section className="view fade-in">
      <div className="setup">
        <div className="card setup__hero">
          <div className="cap">monolythium operator console</div>
          <h1>
            set up your <b>node</b>
          </h1>
          <p>
            Point Monarch at the node you run — provision a fresh one if you need to — then choose
            whether you're running a relay or becoming an operator. Everything else builds on a live
            connection.
          </p>
        </div>

        {railNode}

        {active === "connect" ? (
          <ConnectStep
            n={stepNum}
            initialEndpoint={endpoint}
            plan={plan}
            onPlanChange={setPlan}
            onConnected={onConnected}
            onUnprovisionedDetected={onUnprovisionedDetected}
            result={probe}
            onResult={setProbe}
          />
        ) : null}

        {active === "provision" ? (
          <ProvisionStep
            n={stepNum}
            host={provisionHost}
            detectedProbe={provisionProbe}
            onProvisioned={onProvisioned}
          />
        ) : null}

        {active === "role" ? (
          <RoleStep
            n={stepNum}
            role={nodeRole}
            endpoint={liveEndpoint}
            onChoose={onRoleChosen}
            onContinueOperator={goNext}
            onEnterConsole={() => navigate("/home")}
          />
        ) : null}

        {active === "key" ? (
          <KeyStep
            n={stepNum}
            storedAddress={keyAddress}
            onKeyReady={(addr) => {
              setKeyAddress(addr);
              markDone("key");
            }}
          />
        ) : null}

        {active === "fund" ? (
          <FundStep n={stepNum} address={keyAddress} onFunded={() => markDone("fund")} />
        ) : null}

        {active === "config" ? (
          <ConfigStep n={stepNum} endpoint={liveEndpoint} probe={probe} />
        ) : null}

        {active === "sync" ? <SyncStep n={stepNum} onSynced={() => markDone("sync")} /> : null}

        {active === "register" ? (
          <RegisterStep n={stepNum} endpoint={liveEndpoint} onDone={() => markDone("register")} />
        ) : null}

        {/* The connect/provision/role + register steps own their primary CTA;
            the rest get the shared linear nav. Connect can advance once green;
            key/fund/sync can always move forward (config + sync are skippable). */}
        {active !== "connect" &&
        active !== "provision" &&
        active !== "role" &&
        active !== "register" ? (
          <div className="card" style={{ padding: "14px 20px" }}>
            <div className="setup__foot" style={{ marginTop: 0, paddingTop: 0, borderTop: "none" }}>
              {linearFoot(true)}
            </div>
          </div>
        ) : null}

        {active === "connect" && done.connect ? (
          <div className="card" style={{ padding: "14px 20px" }}>
            <div className="setup__foot" style={{ marginTop: 0, paddingTop: 0, borderTop: "none" }}>
              <span className="setup__foot-spacer" />
              <button type="button" className="btn btn--primary" onClick={goNext}>
                Continue →
              </button>
            </div>
          </div>
        ) : null}

        <div style={{ textAlign: "center" }}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => navigate("/welcome")}
          >
            View detailed setup status →
          </button>
        </div>
      </div>
    </section>
  );
}
