// Setup — the first-run wizard. This is what a brand-new operator hits, NOT
// the auto-detect checklist (that lives at /welcome as "Setup status", a
// useful secondary view for partial states). The flow follows the owner's
// brief: connect to your node FIRST, then create/import a key, fund the bond,
// check config, sync, register & connect.
//
// The node-connect step is the hero and stays editable: the rail lets the
// operator jump back to it any time, and the live endpoint is persisted via
// `setStoredRpcEndpoint` the moment the probe is green. Steps are gated — you
// can't fund before you have a key — but never fabricate progress: each step's
// "done" comes from a real signal (green probe, stored key, balance ≥ bond,
// eth_syncing == null, on-chain registration).

import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getStoredRpcEndpoint,
  rpcEndpoint,
  type NodeProbeResult,
} from "../sdk";
import { ConnectStep, type NodePlan } from "../components/setup/ConnectStep";
import { KeyStep } from "../components/setup/KeyStep";
import { FundStep } from "../components/setup/FundStep";
import { ConfigStep } from "../components/setup/ConfigStep";
import { SyncStep } from "../components/setup/SyncStep";
import { RegisterStep } from "../components/setup/RegisterStep";
import "../styles/setup.css";

type StepId = "connect" | "key" | "fund" | "config" | "sync" | "register";

const STEPS: ReadonlyArray<{ id: StepId; label: string }> = [
  { id: "connect", label: "Connect node" },
  { id: "key", label: "Operator key" },
  { id: "fund", label: "Fund bond" },
  { id: "config", label: "Config" },
  { id: "sync", label: "Sync" },
  { id: "register", label: "Register" },
];

export function Setup() {
  const navigate = useNavigate();

  // The endpoint persisted by the connect step (or already stored). The
  // wizard reads it back so later steps probe the right node.
  const [endpoint, setEndpoint] = useState<string | null>(() => getStoredRpcEndpoint());
  const [probe, setProbe] = useState<NodeProbeResult | null>(null);
  const [plan, setPlan] = useState<NodePlan>("have-node");
  const [keyAddress, setKeyAddress] = useState<string | null>(null);

  // Per-step completion. Connect/key/fund/sync/register flip from real
  // signals; config is advisory and always considered satisfiable (skippable).
  const [done, setDone] = useState<Record<StepId, boolean>>({
    connect: false,
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
  const activeIdx = STEPS.findIndex((s) => s.id === active);

  // A step is reachable once every PRIOR gating step is done. Connect gates
  // everything; key gates fund/register; the rest follow order. Config + sync
  // are skippable so they never hard-block forward motion.
  const reachable = useCallback(
    (id: StepId): boolean => {
      switch (id) {
        case "connect":
          return true;
        case "key":
          return done.connect;
        case "fund":
          return done.connect && done.key;
        case "config":
          return done.connect;
        case "sync":
          return done.connect;
        case "register":
          return done.connect && done.key;
      }
    },
    [done],
  );

  const onConnected = useCallback(
    (next: string) => {
      setEndpoint(next);
      markDone("connect");
    },
    [markDone],
  );

  const goNext = useCallback(() => {
    const next = STEPS[activeIdx + 1];
    if (next && reachable(next.id)) setActive(next.id);
  }, [activeIdx, reachable]);

  const goPrev = useCallback(() => {
    const prev = STEPS[activeIdx - 1];
    if (prev) setActive(prev.id);
  }, [activeIdx]);

  const liveEndpoint = endpoint ?? rpcEndpoint;

  const railNode = useMemo(
    () => (
      <div className="card setup__rail">
        {STEPS.map((s, i) => {
          const can = reachable(s.id);
          const cls = [
            "setup__rail-step",
            s.id === active ? "setup__rail-step--current" : "",
            done[s.id] ? "setup__rail-step--done" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={s.id}
              type="button"
              className={cls}
              disabled={!can}
              onClick={() => can && setActive(s.id)}
              title={can ? undefined : "Finish the earlier steps first"}
            >
              <span className="setup__rail-num">{done[s.id] ? "✓" : i + 1}</span>
              {s.label}
            </button>
          );
        })}
      </div>
    ),
    [active, done, reachable],
  );

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
        disabled={!canAdvance || activeIdx >= STEPS.length - 1}
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
            set up your <b>operator</b>
          </h1>
          <p>
            Six steps take you from a node URL to a registered operator. Start by pointing Monarch at
            the node you run — everything else builds on a live connection.
          </p>
        </div>

        {railNode}

        {active === "connect" ? (
          <ConnectStep
            n={1}
            initialEndpoint={endpoint}
            plan={plan}
            onPlanChange={setPlan}
            onConnected={onConnected}
            result={probe}
            onResult={setProbe}
          />
        ) : null}

        {active === "key" ? (
          <KeyStep
            n={2}
            storedAddress={keyAddress}
            onKeyReady={(addr) => {
              setKeyAddress(addr);
              markDone("key");
            }}
          />
        ) : null}

        {active === "fund" ? (
          <FundStep n={3} address={keyAddress} onFunded={() => markDone("fund")} />
        ) : null}

        {active === "config" ? (
          <ConfigStep n={4} endpoint={liveEndpoint} probe={probe} />
        ) : null}

        {active === "sync" ? <SyncStep n={5} onSynced={() => markDone("sync")} /> : null}

        {active === "register" ? (
          <RegisterStep n={6} endpoint={liveEndpoint} onDone={() => markDone("register")} />
        ) : null}

        {/* The connect + register steps own their primary CTA; the rest get
            the shared linear nav. Connect can advance once green; key/fund/sync
            can always move forward (config + sync are skippable, key advances
            when stored). */}
        {active !== "connect" && active !== "register" ? (
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
                Continue → operator key
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
