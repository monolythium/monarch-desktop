// Install — node-pairing wizard. Monarch connects to and operates a node
// that has ALREADY been provisioned out-of-band (flash the signed
// Monarch OS image + talosctl). This wizard does NOT provision a node —
// it inspects an existing one and pairs with it. Five checks:
// detect the control channel → read the Talos context → inspect the
// protocore service → control-channel material in the OS keychain →
// RPC handshake with the running node.
//
// Every check runs AUTOMATICALLY on mount (and on "Re-run checks") —
// statuses are detected, never hardcoded. A check that cannot run in the
// current environment shows UNKNOWN, which is explicitly not the same as
// "not done".

import { useCallback, useEffect, useState } from "react";
import {
  KEYCHAIN_ACCOUNTS,
  inTauri,
  keychainGet,
  talosConfigInfo,
  talosService,
  talosStatus,
  useNodeStatus,
} from "../sdk";
import { MONARCH_OS_ISO_URL } from "../sdk/onboarding";
import { RecoveryMenu } from "../components/recovery/RecoveryMenu";

type StepStatus = "checking" | "done" | "todo" | "unknown";

type StepResult = { status: StepStatus; note: string };

const PAIRING_STEPS = [
  {
    n: 1,
    label: "Detect the node's control channel",
    detail:
      "probe the configured Talos API endpoint · the node is provisioned from the signed Monarch OS image",
  },
  {
    n: 2,
    label: "Read the Talos context",
    detail:
      "verify the configured Talos context + node list · surfaces any config warnings",
  },
  {
    n: 3,
    label: "Inspect the protocore service",
    detail:
      "read the ext-protocore service state over the Talos API · no install or provisioning performed here",
  },
  {
    n: 4,
    label: "Control-channel material in OS keychain",
    detail:
      "Talos endpoint + config path + expected release digest · stored in the OS keychain",
  },
  {
    n: 5,
    label: "RPC handshake with the running node",
    detail:
      "chain status over the pinned endpoint · confirms the node is live and reachable",
  },
] as const;

const CHECKING: StepResult = { status: "checking", note: "" };

async function runInstallCheck(index: number, rpcReachable: boolean): Promise<StepResult> {
  if (!inTauri()) {
    if (index === 4) {
      // The RPC handshake works in a plain browser too.
      return rpcReachable
        ? { status: "done", note: "RPC handshake passed" }
        : { status: "todo", note: "RPC handshake failed; node is unreachable" };
    }
    return {
      status: "unknown",
      note: "Open Monarch Desktop to verify OS control, keychain, and service state.",
    };
  }

  if (index === 0) {
    const talos = await talosStatus().catch(() => null);
    if (talos?.configured) {
      return talos.reachable
        ? { status: "done", note: `Talos reachable at ${talos.endpoint ?? "configured endpoint"}` }
        : { status: "todo", note: `Talos configured but not reachable: ${talos.lastError ?? "unknown error"}` };
    }
    return {
      status: "todo",
      note: "No Monarch OS control channel is configured — open Settings → Monarch OS.",
    };
  }

  if (index === 1) {
    const info = await talosConfigInfo().catch(() => null);
    if (!info) {
      return { status: "unknown", note: "Talos context is not available yet." };
    }
    if (info.warnings.length > 0) {
      return { status: "todo", note: `Talos config warning: ${info.warnings[0]}` };
    }
    return {
      status: "done",
      note: `Talos context ${info.context} verified; ${info.nodes.length} node(s) listed`,
    };
  }

  if (index === 2) {
    const service = await talosService("ext-protocore").catch(() => null);
    if (!service) {
      return { status: "unknown", note: "Service inspection requires Monarch OS control." };
    }
    return {
      status: "done",
      note: `Service ${service.service?.displayState ?? "status"} via ${service.endpoint}`,
    };
  }

  if (index === 3) {
    const keys = await Promise.all([
      keychainGet(KEYCHAIN_ACCOUNTS.talosEndpoint).catch(() => null),
      keychainGet(KEYCHAIN_ACCOUNTS.talosConfigPath).catch(() => null),
      keychainGet(KEYCHAIN_ACCOUNTS.protocoreExpectedDigest).catch(() => null),
    ]);
    if (keys.some(Boolean)) {
      return {
        status: "done",
        note: keys[2]
          ? "OS keychain contains control-channel material and the expected release digest"
          : "OS keychain contains control-channel material; release digest is not stored locally",
      };
    }
    return {
      status: "todo",
      note: "No Monarch OS credentials found in the OS keychain — save them in Settings → Monarch OS.",
    };
  }

  if (index === 4) {
    return rpcReachable
      ? { status: "done", note: "RPC handshake passed" }
      : { status: "todo", note: "RPC handshake failed; node is unreachable" };
  }

  return { status: "unknown", note: "" };
}

export function Install() {
  const status = useNodeStatus();
  const [results, setResults] = useState<StepResult[]>(() =>
    PAIRING_STEPS.map(() => CHECKING),
  );
  const [running, setRunning] = useState(false);

  const runAll = useCallback(async (rpcReachable: boolean) => {
    setRunning(true);
    setResults(PAIRING_STEPS.map(() => CHECKING));
    for (let i = 0; i < PAIRING_STEPS.length; i += 1) {
      let result: StepResult;
      try {
        result = await runInstallCheck(i, rpcReachable);
      } catch (err) {
        result = { status: "todo", note: (err as Error)?.message ?? String(err) };
      }
      setResults((prev) => prev.map((entry, idx) => (idx === i ? result : entry)));
    }
    setRunning(false);
  }, []);

  // Run every probe automatically on mount — no "Run step N" clicking.
  // The RPC step re-evaluates when reachability flips.
  useEffect(() => {
    void runAll(status.reachable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setResults((prev) =>
      prev.map((entry, idx) =>
        idx === 4 && entry.status !== "checking"
          ? status.reachable
            ? { status: "done", note: "RPC handshake passed" }
            : { status: "todo", note: "RPC handshake failed; node is unreachable" }
          : entry,
      ),
    );
  }, [status.reachable]);

  const doneCount = results.filter((entry) => entry.status === "done").length;
  const allDone = doneCount === PAIRING_STEPS.length;

  return (
    <section className="view fade-in">
      <header>
        <h1 className="view__title">Install</h1>
        <p className="view__subtitle">
          connect Monarch to an already-provisioned Monolythium operator node · provisioning is done out-of-band with the signed Monarch OS image + talosctl
        </p>
      </header>

      {status.quarantineReason ? (
        <RecoveryMenu quarantineReason={status.quarantineReason} />
      ) : null}

      <div className="card card--padded" style={{ textAlign: "center", padding: 40 }}>
        <div className="cap">node pairing</div>
        <div
          className="numeral"
          style={{
            fontSize: 52,
            marginTop: 14,
            lineHeight: 1.05,
          }}
        >
          pair your<br />
          <span style={{ color: "var(--gold)" }}>node.</span>
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
          Monarch runs on your laptop and connects to a node you have already provisioned with
          the{" "}
          <a href={MONARCH_OS_ISO_URL} target="_blank" rel="noreferrer" style={{ color: "var(--gold)" }}>
            signed Monarch OS image ↗
          </a>
          , through pinned control channels. Nothing leaves your machine unencrypted. The five
          checks below run automatically.
        </p>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden", maxWidth: 820, margin: "0 auto" }}>
        {PAIRING_STEPS.map((s, i) => {
          const result = results[i] ?? CHECKING;
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
                background: result.status === "todo"
                  ? "rgba(242,180,65,0.05)"
                  : "transparent",
              }}
            >
              <StepBadge status={result.status} n={s.n} />
              <div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    color: result.status === "unknown" ? "var(--fg-400)" : "var(--fg-100)",
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
                {result.note ? (
                  <div className="install-note mono">{result.note}</div>
                ) : null}
              </div>
              <span className={statusHalo(result.status)} style={{ letterSpacing: "0.08em" }}>
                {statusText(result.status)}
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
            justifyContent: "space-between",
            alignItems: "center",
            background: "rgba(255,255,255,0.02)",
          }}
        >
          <span style={{ fontSize: 11.5, color: "var(--fg-400)" }}>
            {allDone
              ? "All pairing checks pass — your node is connected."
              : `${doneCount} of ${PAIRING_STEPS.length} checks pass · statuses are detected live, not remembered.`}
          </span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={running}
            onClick={() => void runAll(status.reachable)}
          >
            {running ? "Checking…" : "Re-run checks"}
          </button>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 820, margin: "0 auto" }}>
        <div className="card__head">
          <div>
            <h3>Live RPC handshake</h3>
            <div className="sub">check 5 verifies the node responds before pairing finishes</div>
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
          <span className="kv__k">network</span>
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

function statusHalo(status: StepStatus): string {
  if (status === "done") return "halo halo--ok";
  if (status === "checking") return "halo halo--info";
  if (status === "todo") return "halo halo--gold";
  return "halo halo--warn";
}

function statusText(status: StepStatus): string {
  if (status === "done") return "DONE";
  if (status === "checking") return "CHECKING";
  if (status === "todo") return "TO DO";
  return "UNKNOWN";
}

function StepBadge({ status, n }: { status: StepStatus; n: number }) {
  const colors = {
    done: {
      bg: "oklch(0.30 0.08 155)",
      border: "oklch(0.55 0.15 155)",
      fg: "oklch(0.82 0.16 155)",
      glow: "none",
    },
    todo: {
      bg: "rgba(242,180,65,0.18)",
      border: "var(--gold)",
      fg: "var(--gold)",
      glow: "0 0 16px rgba(242,180,65,0.3)",
    },
    checking: {
      bg: "rgba(255,255,255,0.04)",
      border: "var(--glass-stroke)",
      fg: "var(--fg-300)",
      glow: "none",
    },
    unknown: {
      bg: "rgba(255,255,255,0.04)",
      border: "var(--glass-stroke)",
      fg: "var(--fg-400)",
      glow: "none",
    },
  } as const;
  const c = colors[status];
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
      {status === "done" ? "✓" : ["SH", "HW", "CL", "KC", "BT"][n - 1] ?? n}
    </div>
  );
}
