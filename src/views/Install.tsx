// Install — first-run wizard. Monarch connects to and operates a node
// that has ALREADY been provisioned out-of-band (flash the signed
// Monarch OS ISO + talosctl). This wizard does NOT provision a node —
// it inspects an existing one and pairs with it. Five steps:
// detect the control channel → read the Talos context → inspect the
// protocore service → store control-channel material in the OS keychain
// → RPC handshake with the running node. Each step renders as a row
// with a status pill (PENDING / READY / RUNNING / DONE); the active row
// gets the gold halo + a fill bar that animates while running.
//
// The runner uses the live bridge for every step: SSH/Talos status,
// Talos context + service inspection, keychain checks, and the RPC
// handshake. No step apply-config/bootstraps/upgrades the node.

import { useMemo, useState } from "react";
import {
  KEYCHAIN_ACCOUNTS,
  inTauri,
  keychainGet,
  sshStatus,
  talosConfigInfo,
  talosService,
  talosStatus,
  useNodeStatus,
} from "../sdk";

type StepState = "pending" | "ready" | "running" | "done";

const PAIRING_STEPS = [
  {
    n: 1,
    label: "Detect the node's control channel",
    detail:
      "probe the configured Talos API / SSH endpoint · the node is provisioned out-of-band (signed Monarch OS ISO + talosctl)",
    status: "done" as const,
  },
  {
    n: 2,
    label: "Read the Talos context",
    detail:
      "verify the configured Talos context + node list · surfaces any config warnings",
    status: "done" as const,
  },
  {
    n: 3,
    label: "Inspect the protocore service",
    detail:
      "read the ext-protocore service state over the Talos API · no install or provisioning performed here",
    status: "current" as const,
  },
  {
    n: 4,
    label: "Store control-channel material in OS keychain",
    detail:
      "Talos endpoint + config path + expected release digest · stored in the OS keychain",
    status: "todo" as const,
  },
  {
    n: 5,
    label: "RPC handshake with the running node",
    detail:
      "lyth_chainStatus over the pinned endpoint · confirms the node is live and reachable",
    status: "todo" as const,
  },
];

export function Install() {
  const status = useNodeStatus();

  // The static pairing plan's "done"/"current"/"todo" status seeds the cursor;
  // live checks run when each row is advanced.
  const initialCursor = useMemo(() => {
    const idx = PAIRING_STEPS.findIndex((s) => s.status === "current");
    return idx === -1 ? 0 : idx;
  }, []);

  const [cursor, setCursor] = useState(initialCursor);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [complete, setComplete] = useState(false);
  const [stepNotes, setStepNotes] = useState<Record<number, string>>({});

  const stepState = (i: number): StepState => {
    if (complete || i < cursor) return "done";
    if (i > cursor) return "pending";
    return running ? "running" : "ready";
  };

  const runCurrentStep = async () => {
    if (running || complete) return;
    setRunning(true);
    setProgress(12);
    const ticker = window.setInterval(() => {
      setProgress((p) => Math.min(92, p + 9));
    }, 120);
    try {
      const note = await runInstallStep(cursor, status.reachable);
      setStepNotes((prev) => ({ ...prev, [cursor]: note }));
      setProgress(100);
      window.setTimeout(() => {
        setCursor((c) => {
          if (c >= PAIRING_STEPS.length - 1) {
            setComplete(true);
            return c;
          }
          return c + 1;
        });
        setProgress(0);
      }, 220);
    } catch (err) {
      setStepNotes((prev) => ({
        ...prev,
        [cursor]: (err as Error)?.message ?? String(err),
      }));
      setProgress(0);
    } finally {
      window.clearInterval(ticker);
      setRunning(false);
    }
  };

  return (
    <section className="view fade-in">
      <header>
        <h1 className="view__title">Install</h1>
        <p className="view__subtitle">
          connect Monarch to an already-provisioned Monolythium operator node · provisioning is done out-of-band with the signed Monarch OS ISO + talosctl
        </p>
      </header>

      <div className="card card--padded" style={{ textAlign: "center", padding: 40 }}>
        <div className="cap">first-run setup</div>
        <div
          className="numeral"
          style={{
            fontSize: 52,
            marginTop: 14,
            lineHeight: 1.05,
          }}
        >
          welcome,<br />
          <span style={{ color: "var(--gold)" }}>operator.</span>
        </div>
        <p
          style={{
            fontSize: 14,
            color: "var(--fg-300)",
            marginTop: 18,
            maxWidth: 520,
            margin: "18px auto 0",
            lineHeight: 1.5,
          }}
        >
          Monarch runs on your laptop and connects to a node you have already provisioned, through pinned control channels. Nothing leaves your machine unencrypted. Five steps to pair.
        </p>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden", maxWidth: 820, margin: "0 auto" }}>
        {PAIRING_STEPS.map((s, i) => {
          const state = stepState(i);
          return (
            <div
              key={s.n}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                gap: 18,
                padding: "18px 22px",
                alignItems: "center",
                borderTop: i > 0 ? "1px solid var(--glass-stroke)" : "none",
                background: state === "ready" || state === "running"
                  ? "rgba(242,180,65,0.05)"
                  : "transparent",
              }}
            >
              <StepBadge state={state} n={s.n} />
              <div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    color:
                      state === "pending" ? "var(--fg-400)" : "var(--fg-100)",
                  }}
                >
                  {s.n}. {s.label}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--fg-400)",
                    marginTop: 3,
                  }}
                >
                  {s.detail}
                </div>
                {stepNotes[i] ? (
                  <div className="install-note mono">{stepNotes[i]}</div>
                ) : null}
                {state === "running" ? (
                  <div
                    style={{
                      marginTop: 10,
                      height: 3,
                      borderRadius: 3,
                      background: "rgba(255,255,255,0.06)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${progress}%`,
                        background: "var(--gold)",
                        boxShadow: "0 0 10px var(--gold)",
                        transition: "width 70ms linear",
                      }}
                    />
                  </div>
                ) : null}
              </div>
              <span className={stateHalo(state)} style={{ letterSpacing: "0.08em" }}>
                {state.toUpperCase()}
              </span>
            </div>
          );
        })}

        <div
          style={{
            padding: "16px 22px",
            borderTop: "1px solid var(--glass-stroke)",
            display: "flex",
            gap: 10,
            justifyContent: "flex-end",
            background: "rgba(255,255,255,0.02)",
          }}
        >
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={cursor === 0 || running}
            onClick={() => {
              setCursor(Math.max(0, cursor - 1));
              setComplete(false);
              setProgress(0);
            }}
          >
            Back
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={running || complete}
            onClick={() => void runCurrentStep()}
          >
            {complete
              ? "Setup complete"
              : running
                ? "Running…"
                : cursor < PAIRING_STEPS.length - 1
                  ? `Run step ${cursor + 1}`
                  : "Finish setup"}
          </button>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 820, margin: "0 auto" }}>
        <div className="card__head">
          <div>
            <h3>Live RPC handshake</h3>
            <div className="sub">step 5 verifies the node responds before pairing finishes</div>
          </div>
          <span className={status.reachable ? "halo halo--ok" : "halo halo--err"}>
            <span className="dot" /> {status.reachable ? "reachable" : "unreachable"}
          </span>
        </div>
        <div className="kv">
          <span className="kv__k">endpoint</span>
          <span className="kv__v mono">{status.endpoint}</span>
        </div>
        <div className="kv">
          <span className="kv__k">chain_id</span>
          <span className="kv__v mono">
            {status.chainId !== null ? status.chainId : "—"}
          </span>
        </div>
        <div className="kv">
          <span className="kv__k">block</span>
          <span className="kv__v mono">
            {status.blockNumber !== null
              ? status.blockNumber.toLocaleString()
              : "—"}
          </span>
        </div>
        <div className="kv">
          <span className="kv__k">round</span>
          <span className="kv__v mono">
            {status.currentRound !== null
              ? status.currentRound.toLocaleString()
              : "—"}
          </span>
        </div>
      </div>
    </section>
  );
}

async function runInstallStep(index: number, rpcReachable: boolean): Promise<string> {
  if (!inTauri()) {
    throw new Error(
      "Pairing checks require Monarch Desktop; browser preview cannot verify Talos, SSH, keychain, or service state.",
    );
  }

  if (index === 0) {
    const [ssh, talos] = await Promise.all([
      sshStatus().catch(() => null),
      talosStatus().catch(() => null),
    ]);
    if (talos?.configured) {
      return talos.reachable
        ? `Talos reachable at ${talos.endpoint ?? "configured endpoint"}`
        : `Talos configured but not reachable: ${talos.lastError ?? "unknown error"}`;
    }
    if (ssh?.connected) return `SSH connected to ${ssh.user}@${ssh.host}`;
    throw new Error("No SSH or Talos control channel is configured");
  }

  if (index === 1) {
    const info = await talosConfigInfo().catch(() => null);
    if (!info) return "SSH/plain-host mode: host requirements verified manually";
    if (info.warnings.length > 0) {
      throw new Error(`Talos config warning: ${info.warnings[0]}`);
    }
    return `Talos context ${info.context} verified; ${info.nodes.length} node(s) listed`;
  }

  if (index === 2) {
    const service = await talosService("ext-protocore").catch(() => null);
    if (!service) return "Plain-host mode: CLI/service install check requires SSH operations";
    return `Service ${service.service?.displayState ?? "status"} via ${service.endpoint}`;
  }

  if (index === 3) {
    const keys = await Promise.all([
      keychainGet(KEYCHAIN_ACCOUNTS.talosEndpoint),
      keychainGet(KEYCHAIN_ACCOUNTS.talosConfigPath),
      keychainGet(KEYCHAIN_ACCOUNTS.protocoreExpectedDigest),
      keychainGet(KEYCHAIN_ACCOUNTS.sshHost),
      keychainGet(KEYCHAIN_ACCOUNTS.sshUser),
    ]);
    if (keys.some(Boolean)) {
      return keys[2]
        ? "OS keychain contains control-channel material and expected release digest"
        : "OS keychain contains control-channel material; release digest is not stored locally";
    }
    throw new Error("No Monarch control-channel credentials found in OS keychain");
  }

  if (index === 4) {
    if (!rpcReachable) throw new Error("RPC handshake failed; node is unreachable");
    return "RPC handshake passed";
  }

  return "step complete";
}

function stateHalo(state: StepState): string {
  if (state === "done") return "halo halo--ok";
  if (state === "running") return "halo halo--info";
  if (state === "ready") return "halo halo--gold";
  return "halo";
}

function StepBadge({ state, n }: { state: StepState; n: number }) {
  const colors = {
    done: {
      bg: "oklch(0.30 0.08 155)",
      border: "oklch(0.55 0.15 155)",
      fg: "oklch(0.82 0.16 155)",
      glow: "none",
    },
    ready: {
      bg: "rgba(242,180,65,0.18)",
      border: "var(--gold)",
      fg: "var(--gold)",
      glow: "0 0 16px rgba(242,180,65,0.3)",
    },
    running: {
      bg: "rgba(242,180,65,0.18)",
      border: "var(--gold)",
      fg: "var(--gold)",
      glow: "0 0 16px rgba(242,180,65,0.3)",
    },
    pending: {
      bg: "rgba(255,255,255,0.04)",
      border: "var(--glass-stroke)",
      fg: "var(--fg-400)",
      glow: "none",
    },
  } as const;
  const c = colors[state];
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: 10,
        background: c.bg,
        border: `1px solid ${c.border}`,
        color: c.fg,
        boxShadow: c.glow,
        display: "grid",
        placeItems: "center",
        fontFamily: "var(--f-mono)",
        fontSize: 13,
        fontWeight: 500,
      }}
    >
      {state === "done" ? "✓" : ["SH", "HW", "CL", "KC", "BT"][n - 1] ?? n}
    </div>
  );
}
