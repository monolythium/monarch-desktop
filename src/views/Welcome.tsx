// Welcome — the first-run surface. A plain-language introduction to the
// operator concepts plus ONE persistent 10-step checklist whose state is
// AUTO-DETECTED from the keychain, the Talos control channel, and the
// chain (never remembered locally): close the app, come back next week,
// and the checklist still shows the truth.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Term } from "../components/Term";
import {
  EMPTY_ONBOARDING_PROBES,
  MONARCH_OS_ISO_URL,
  collectOnboardingProbes,
  reduceOnboardingSteps,
  type OnboardingProbeInputs,
  type OnboardingStep,
  type OnboardingStepStatus,
} from "../sdk/onboarding";

const CONCEPTS: ReadonlyArray<{ term: string; title: string; body: string }> = [
  {
    term: "operator",
    title: "Operator",
    body:
      "One physical node, run by one person or team — you. Operators register on-chain, post a bond, and join clusters. Your 24-word key is your identity.",
  },
  {
    term: "cluster",
    title: "Cluster",
    body:
      "A group of 10 operators (7 active + 3 standby seats) that signs together. 7 of the 10 must agree before the cluster can act — no single operator is ever trusted alone.",
  },
  {
    term: "relay",
    title: "Relay",
    body:
      "A node that carries network traffic but takes no part in consensus signing. Useful, but it earns no cluster rewards and posts no bond.",
  },
  {
    term: "bond",
    title: "Bond — 5,000 LYTH",
    body:
      "LYTH locked from your wallet when you register. It backs your good behaviour and is refundable after you resign and the delay passes.",
  },
  {
    term: "delegation",
    title: "Delegation",
    body:
      "LYTH that holders assign to a cluster to share in its rewards. Delegating never gives the cluster control of the holder's funds.",
  },
  {
    term: "seal key",
    title: "Seal key",
    body:
      "Your public encryption key. Publishing it lets your cluster include you in sealed-mempool duty. Safe to share — only your node holds the private half.",
  },
];

function statusHalo(status: OnboardingStepStatus): string {
  switch (status) {
    case "done":
      return "halo halo--ok";
    case "todo":
      return "halo halo--gold";
    case "blocked":
      return "halo";
    case "unknown":
    default:
      return "halo halo--warn";
  }
}

function statusLabel(status: OnboardingStepStatus): string {
  switch (status) {
    case "done":
      return "DONE";
    case "todo":
      return "TO DO";
    case "blocked":
      return "BLOCKED";
    case "unknown":
    default:
      return "UNKNOWN";
  }
}

function ChecklistRow({ step }: { step: OnboardingStep }) {
  const navigate = useNavigate();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        gap: 16,
        padding: "14px 20px",
        alignItems: "center",
        borderTop: "1px solid var(--glass-stroke)",
        background: step.status === "todo" ? "rgba(242,180,65,0.04)" : "transparent",
      }}
    >
      <div
        aria-hidden
        style={{
          width: 32,
          height: 32,
          borderRadius: 9,
          display: "grid",
          placeItems: "center",
          fontFamily: "var(--f-mono)",
          fontSize: 12,
          background:
            step.status === "done"
              ? "oklch(0.30 0.08 155)"
              : step.status === "todo"
                ? "rgba(242,180,65,0.16)"
                : "rgba(255,255,255,0.04)",
          border:
            step.status === "done"
              ? "1px solid oklch(0.55 0.15 155)"
              : step.status === "todo"
                ? "1px solid var(--gold)"
                : "1px solid var(--glass-stroke)",
          color:
            step.status === "done"
              ? "oklch(0.82 0.16 155)"
              : step.status === "todo"
                ? "var(--gold)"
                : "var(--fg-400)",
        }}
      >
        {step.status === "done" ? "✓" : step.n}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: step.status === "blocked" ? "var(--fg-400)" : "var(--fg-100)",
          }}
        >
          {step.n}. {step.title}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--fg-400)", marginTop: 3, lineHeight: 1.45 }}>
          {step.detail}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className={statusHalo(step.status)} style={{ letterSpacing: "0.08em" }}>
          {statusLabel(step.status)}
        </span>
        {step.status !== "done" && step.href ? (
          <a
            className="btn btn--ghost btn--sm"
            href={step.href}
            target="_blank"
            rel="noreferrer"
          >
            Download ↗
          </a>
        ) : null}
        {step.status === "todo" && step.fixRoute ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => navigate(step.fixRoute as string)}
          >
            Go →
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Welcome() {
  const [probes, setProbes] = useState<OnboardingProbeInputs>(EMPTY_ONBOARDING_PROBES);
  const [checking, setChecking] = useState(true);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      setProbes(await collectOnboardingProbes());
    } catch {
      setProbes(EMPTY_ONBOARDING_PROBES);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const steps = reduceOnboardingSteps(probes);
  const doneCount = steps.filter((step) => step.status === "done").length;

  return (
    <section className="view fade-in">
      <div className="card card--padded" style={{ textAlign: "center", padding: 40 }}>
        <div className="cap">monolythium operator console</div>
        <div className="numeral" style={{ fontSize: 52, marginTop: 14, lineHeight: 1.05 }}>
          welcome,<br />
          <span style={{ color: "var(--gold)" }}>operator.</span>
        </div>
        <p
          style={{
            fontSize: 14,
            color: "var(--fg-300)",
            marginTop: 18,
            maxWidth: 560,
            margin: "18px auto 0",
            lineHeight: 1.5,
          }}
        >
          Monarch runs on your computer and connects to a node you control, through pinned
          control channels. Ten steps take you from a blank machine to a signing seat in a
          live <Term k="cluster">cluster</Term>. Every step below is checked against the real
          state of your keychain, your node, and the chain.
        </p>
      </div>

      <div className="card" style={{ maxWidth: 980, margin: "0 auto", width: "100%" }}>
        <div className="card__head">
          <div>
            <h3>What the words mean</h3>
            <div className="sub">six ideas cover almost everything in this console</div>
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          {CONCEPTS.map((concept) => (
            <div
              key={concept.title}
              className="card"
              style={{ background: "rgba(255,255,255,0.02)", margin: 0 }}
            >
              <b style={{ fontSize: 13, color: "var(--gold)" }}>{concept.title}</b>
              <p style={{ fontSize: 12, color: "var(--fg-300)", lineHeight: 1.5, margin: "6px 0 0" }}>
                {concept.body}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden", maxWidth: 980, margin: "0 auto", width: "100%" }}>
        <div
          className="card__head"
          style={{ padding: "16px 20px 12px", marginBottom: 0 }}
        >
          <div>
            <h3>Your path to a cluster seat</h3>
            <div className="sub">
              {doneCount} of {steps.length} steps detected complete · start with the{" "}
              <a href={MONARCH_OS_ISO_URL} target="_blank" rel="noreferrer" style={{ color: "var(--gold)" }}>
                Monarch OS image ↗
              </a>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className={checking ? "halo halo--info" : "halo halo--ok"}>
              <span className={checking ? "dot dot--pulse" : "dot"} />
              {checking ? "checking…" : "auto-detected"}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={checking}
              onClick={() => void refresh()}
            >
              Re-check
            </button>
          </div>
        </div>
        {steps.map((step) => (
          <ChecklistRow key={step.id} step={step} />
        ))}
        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid var(--glass-stroke)",
            background: "rgba(255,255,255,0.02)",
            fontSize: 11.5,
            color: "var(--fg-400)",
            lineHeight: 1.5,
          }}
        >
          Resume any time — progress is <b style={{ color: "var(--fg-200)" }}>detected, not remembered</b>.
          Monarch re-checks your keychain, your node, and the chain on every visit, so this list
          is always the truth even on a fresh install. Steps marked UNKNOWN cannot be verified
          from the current connection; that is not the same as "not done".
        </div>
      </div>

      <div
        className="halo halo--info"
        style={{ alignSelf: "center", whiteSpace: "normal", lineHeight: 1.45, maxWidth: 760 }}
      >
        <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
        <span>
          Monarch is advisory: every sensitive action routes through the Operations drawer where
          you preview the exact change and approve signing in your OS keychain. Nothing executes
          on its own.
        </span>
      </div>
    </section>
  );
}
