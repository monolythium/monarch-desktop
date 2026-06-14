import { formatLyth } from "@monolythium/core-sdk";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toMono1 } from "../sdk/address";
import { useKeychainPresence, useSelfOperator } from "../hooks/useSelfOperator";
import { useOps } from "../ops";
import {
  DEFAULT_ACTIVE_CLUSTER_ID,
  bpsToPercent,
  clusterLabel,
  formatLythHex,
  operatorRiskView,
  serviceRewardEarningsView,
  signingActivityView,
  useClusterCharter,
  useClusterDiversity,
  useClusterServiceScore,
  useClusterStatus,
  useNodeStatus,
  useOperatorAuthority,
  useOperatorFeeConfig,
  useOperatorInfo,
  useOperatorRisk,
  useOperatorRouterConfig,
  useOperatorSigningActivity,
  useProverMarketStatus,
  useUpcomingDuties,
} from "../sdk";

const ACTIVE_CLUSTER_ID = DEFAULT_ACTIVE_CLUSTER_ID;

export function Operator() {
  const status = useNodeStatus();
  // Resolve the local operator from the stored key before showing live registry data.
  const self = useSelfOperator();
  const cluster = useClusterStatus(self.clusterId ?? ACTIVE_CLUSTER_ID);
  const clusterData = cluster.data;
  const operatorId = self.operatorId;
  const operator = useOperatorInfo(operatorId);
  const ops = useOps();
  const presence = useKeychainPresence();
  const navigate = useNavigate();

  // Copied-state feedback for the key-row copy buttons: flash a ✓ for 1.2s.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );
  const copyKeyValue = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value);
    setCopiedKey(label);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopiedKey(null), 1200);
  };

  const authority = useOperatorAuthority(operatorId);
  const authorityIndex = authority.data?.authorityIndex ?? null;
  const risk = useOperatorRisk(authorityIndex, 200);
  const signing = useOperatorSigningActivity(authorityIndex, 200);
  const duties = useUpcomingDuties(authorityIndex, 500);
  const routerCfg = useOperatorRouterConfig();
  const prover = useProverMarketStatus();

  // Service-reward earnings rollup — this cluster's reward weight is its
  // settled ServiceScore (proved service), NOT its stake (stake = rank only).
  const earningsClusterId = self.clusterId ?? clusterData?.id ?? ACTIVE_CLUSTER_ID;
  const serviceScore = useClusterServiceScore(earningsClusterId);
  const diversity = useClusterDiversity(earningsClusterId);
  const charter = useClusterCharter(earningsClusterId);
  const earnings = serviceRewardEarningsView({
    score: serviceScore.data,
    diversity: diversity.data,
    proverActive: false,
    charter: charter.data,
  });

  const v = operator.data;
  const setSize = clusterData?.members.length ?? null;
  const publicOperatorName = displayMonikerInput(v?.moniker);
  const moniker = publicOperatorName || "Operator profile";
  const operatorHeroHint = publicOperatorName
    ? "Public name shown in Monarch and Monoscan"
    : operatorId
      ? "No public name set yet. Your wallet address and operator ID are below."
      : "Operator key required";
  const activeClusterLabel = clusterLabel(clusterData?.id ?? ACTIVE_CLUSTER_ID);
  const activeClusterId = String(clusterData?.id ?? ACTIVE_CLUSTER_ID);
  const jailed = v?.jailed ?? false;
  const riskSummary = operatorRiskView(risk.data, jailed);
  const signingSummary = signingActivityView(signing.data);
  const recentSigning = signingSummary.entries.slice(-80);
  const dutyAttestation = duties.data?.duties.attestation;
  const dutyKeyRotation = duties.data?.duties.keyRotation;
  const keyRows = [
    // Always show the bech32m `mono1…` form here — this is the "send LYTH here"
    // funding address, and the `0x` hex EVM-compat form (which `v?.address` can
    // be, from the registry RPC) is REJECTED by send paths. `toMono1` passes a
    // `mono1…` through and converts `0x…` hex; falls back to "—".
    { label: "Operator wallet address", algo: "send LYTH here", value: toMono1(self.address ?? v?.address) ?? "—" },
    { label: "Operator ID", algo: "cluster member id", value: operatorId ?? "—" },
    { label: "Consensus key fingerprint", algo: "registry", value: v?.pubkey ?? "—" },
    { label: "Cluster anchor", algo: "cluster account", value: clusterData?.anchorAddress ?? "—" },
  ];

  // The order-routing fee is keyed by the operator's bech32m wallet address,
  // not the cluster-member operatorId. Feed the
  // resolved chainAddress, guarded to a `mono1…` form; null until identity
  // resolves so the read degrades to notExposed rather than erroring.
  const operatorAddress =
    !operator.notExposed && v?.address?.startsWith("mono1") ? v.address : null;
  const feeCfg = useOperatorFeeConfig(operatorAddress);

  const routerState = routerCfg.data?.enabled
    ? { tone: "halo--ok", label: "active" }
    : routerCfg.notExposed
      ? { tone: "halo--warn", label: "available when activated" }
      : { tone: "halo--info", label: "disabled" };

  return (
    <section className="view fade-in">
      <header>
        <h1 className="view__title">Operator identity</h1>
        <p className="view__subtitle">
          {status.reachable ? "Connected node" : "Node not connected"} · {status.endpoint}
          {setSize !== null ? ` · ${setSize} operators visible` : ""}
        </p>
      </header>

      {self.status === "no-key" ? (
        <div className="card card--padded" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div>
            <b style={{ fontSize: 14 }}>No operator key stored</b>
            <p style={{ fontSize: 12, color: "var(--fg-400)", margin: "4px 0 0" }}>
              This page shows YOUR operator. Save or generate your 24-word operator mnemonic
              and your identity, risk, and bond appear here automatically.
            </p>
          </div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => navigate("/keys")}>
            Set up your operator key →
          </button>
        </div>
      ) : self.status === "ready" && self.registered === false ? (
        <div className="halo halo--warn" style={{ alignSelf: "flex-start", whiteSpace: "normal" }}>
          <span className="dot" /> Your operator key is not registered on-chain yet — register to
          appear in the directory and become admittable.
        </div>
      ) : null}
      {operator.notExposed && self.status !== "no-key" ? (
        <div className="halo halo--warn" style={{ alignSelf: "flex-start" }}>
          <span className="dot" /> Live identity is not available from this node yet.
        </div>
      ) : null}

      {self.status !== "no-key" ? (
      <div className="card card--padded operator-hero">
        <div>
          <div className="cap">your operator</div>
          <div className="operator-hero__moniker">{moniker}</div>
          {operatorHeroHint ? <div className="operator-hero__hint">{operatorHeroHint}</div> : null}
          <div className="operator-pills">
            {self.status === "ready" ? (
              <span className="halo halo--gold" title="Derived from your stored operator key — this is you">
                YOU
              </span>
            ) : null}
            <span className={!v ? "halo halo--warn" : jailed ? "halo halo--err" : "halo halo--ok"}>
              <span className="dot" /> {!v ? "unavailable" : jailed ? "removed" : "bonded"}
            </span>
            <span className="halo halo--gold">{formatLythoshi(v?.bondedStake)}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() =>
              ops.requestOp({
                kind: "operator-display",
                title: "Set operator name",
                sub: "Update your public operator profile",
                intro:
                  "Publishes the public name other operators and explorers see for your node. Empty fields clear the stored values.",
                fields: [
                  { key: "operator", label: "Operator", value: publicOperatorName || self.address || operatorId || "Your operator" },
                  { key: "peer-id", label: "Operator ID", value: operatorId ?? "enter operator id" },
                  { key: "visible", label: "Visible in", value: "Monoscan and Monarch Desktop" },
                ],
                operatorDisplayInput: {
                  peerIdHex: operatorId ?? "",
                  moniker: displayMonikerInput(v?.moniker),
                  alias: "",
                },
                icon: "ID",
                risk: "medium",
                needsPasskey: true,
                confirmLabel: "Approve name update",
              })
            }
          >
            Set name
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() =>
              ops.requestOp({
                kind: "operator-seal-key",
                title: "Publish seal key",
                sub: "Publish your public seal key",
                intro:
                  "Publishes your public seal key so a cluster can include you in sealed-mempool duty. It is safe to publish - only your node holds the private half.",
                fields: [
                  { key: "operator", label: "Operator", value: publicOperatorName || self.address || operatorId || "Your operator" },
                  { key: "peer-id", label: "Operator ID", value: operatorId ?? "from your operator key" },
                  { key: "private-key", label: "Private key", value: "stays on your node" },
                ],
                operatorSealKeyInput: operatorId
                  ? { peerIdHex: operatorId, sealEkHex: "" }
                  : undefined,
                icon: "SK",
                risk: "medium",
                needsPasskey: true,
                confirmLabel: "Approve seal key",
              })
            }
          >
            Publish seal key
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() =>
              ops.requestOp({
                kind: "cluster-request-join",
                title: `Request join for ${activeClusterLabel}`,
                sub: "Ask this cluster for a seat",
                intro:
                  "Asks the selected cluster to admit your operator. Publish your seal key first so the cluster can include you safely.",
                fields: [
                  { key: "cluster", label: "Cluster", value: activeClusterLabel },
                  {
                    key: "flow",
                    label: "Flow",
                    value: "current members vote on the request",
                  },
                  {
                    key: "seal-key",
                    label: "Seal key",
                    value: "publish before requesting admission",
                  },
                ],
                clusterJoinRequestInput: {
                  clusterId: activeClusterId,
                  operatorPubkeyHex: "",
                  bondLythoshi: "0",
                },
                icon: "RJ",
                risk: "high",
                destructive: true,
                needsPasskey: true,
                confirmLabel: "Approve join request",
              })
            }
          >
            Request seat
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() =>
              ops.requestOp({
                kind: "rotate-keys",
                title: "Rotate signing share",
                sub: "Record a completed key ceremony",
                intro:
                  "Records the result of a completed key-share ceremony so the new signing shares can take effect. Run this only after the ceremony has finished and every participant has signed the final output.",
                fields: [
                  { key: "cluster", label: "Cluster", value: activeClusterLabel },
                  { key: "operators", label: "Operators", value: clusterData ? `${clusterData.threshold}-of-${clusterData.size} quorum` : "cluster unavailable" },
                ],
                icon: "KY",
                risk: "high",
                destructive: true,
                needsPasskey: true,
                confirmLabel: "Approve key rotation",
              })
            }
          >
            Rotate keys →
          </button>
        </div>
      </div>
      ) : null}

      <div className="grid-2">
        <div className="card">
          <div className="card__head">
            <div>
              <h3>Keys</h3>
              <div className="sub">Wallet, operator ID, and registry keys</div>
            </div>
          </div>
          <div className="key-grid">
            {keyRows.map((k) => (
              <div className="key-row" key={k.label}>
                <div>
                  <div className="stat__label">{k.label}</div>
                  <div className="mono key-row__value">{compact(k.value)}</div>
                  <div className="stat__sub">{k.algo}</div>
                </div>
                <button
                  type="button"
                  className={copiedKey === k.label ? "copy-btn copy-btn--copied" : "copy-btn"}
                  disabled={k.value === "—"}
                  onClick={() => copyKeyValue(k.label, k.value)}
                  aria-label={copiedKey === k.label ? `Copied ${k.label}` : `Copy ${k.label}`}
                  aria-live="polite"
                >
                  {copiedKey === k.label ? "✓" : "CP"}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="operator-risk-grid">
          <div className="card">
            <div className="card__head">
              <div>
                <h3>Removal-risk meter</h3>
                <div className="sub">
                  authority {authorityIndex ?? "—"} · threshold {risk.data ? bpsToPercent(risk.data.thresholdBps) : "—"}
                </div>
              </div>
              <span className={`halo halo--${riskSummary.tone}`}>
                <span className="dot" /> {riskSummary.label}
              </span>
            </div>
            <div className="risk-meter">
              <span className="risk-meter__fill" style={{ width: `${riskSummary.fillPct}%` }} />
              <span className="risk-meter__tick" style={{ left: `${riskSummary.thresholdPct}%` }} />
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--fg-500)", marginTop: 8 }}>
              {risk.notExposed
                ? "Removal-risk history is not available from this node yet."
                : risk.error
                  ? risk.error
                  : riskSummary.detail}
            </div>
          </div>

          <div className="card operator-percentile">
            <div className="cap">signing performance</div>
            <div className="numeral numeral--gold">{signingSummary.signedPctLabel}</div>
            <p>
              {signing.notExposed
                ? "Signing history is not available from this node yet."
                : signing.error
                  ? signing.error
                  : `${signingSummary.signed} signed · ${signingSummary.missed} missed · ${signingSummary.noCert} no certificate`}
            </p>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <div>
            <h3>Signing activity · last 200 rounds</h3>
            <div className="sub">
              {clusterData
                ? `${clusterData.members.filter((m) => m.state !== "jail").length}/${clusterData.size} operators live`
                : "cluster loading"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {presence.hasFoundationKey ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() =>
                  ops.requestOp({
                    kind: "operator-restore",
                    title: "Restore operator",
                    sub: "Recovery transaction",
                    intro:
                      "Brings a removed operator back into rotation after an incident. Run this only when you have been asked to perform recovery.",
                    fields: [
                      { key: "operator", label: "Operator", value: moniker },
                      { key: "peer-id", label: "Operator ID", value: operatorId ?? "enter operator id" },
                    ],
                    restoreInput: operatorId ? { peerIdHex: operatorId } : undefined,
                    icon: "UJ",
                    risk: "medium",
                    needsPasskey: true,
                    confirmLabel: "Sign recovery tx",
                  })
                }
              >
                Restore
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() =>
                ops.requestOp({
                  kind: "rotate-keys",
                  title: "Rotate signing share",
                  sub: "Record a completed key ceremony",
                  intro:
                    "Records the result of a completed key-share ceremony so the new signing shares can take effect. Run this only after the ceremony has finished and every participant has signed the final output.",
                  fields: [{ key: "cluster", label: "Cluster", value: clusterData ? activeClusterLabel : "cluster unavailable" }],
                  icon: "KY",
                  risk: "high",
                  destructive: true,
                  needsPasskey: true,
                  confirmLabel: "Approve key rotation",
                })
              }
            >
              Rotate keys
            </button>
          </div>
        </div>
        {signing.data && recentSigning.length > 0 ? (
          <>
            <div className="sig-strip" aria-label="Recent signing activity">
              {recentSigning.map((entry) => (
                <span
                  key={`${entry.round.toString()}-${entry.status}`}
                  className={
                    entry.status === "missed" || entry.status === "no_cert"
                      ? "sig-strip__bar sig-strip__bar--miss"
                      : "sig-strip__bar"
                  }
                  title={`round ${entry.round.toString()} · ${entry.status}`}
                />
              ))}
            </div>
            <div className="signing-axis">
              <span>oldest {recentSigning[0]?.round.toString() ?? "—"}</span>
              <span>current {signing.data.currentRound.toString()}</span>
            </div>
            <div className="grid-2" style={{ marginTop: 14 }}>
              <div>
                <div className="cap">attestation window</div>
                <div className="stat__sub">
                  {dutyAttestation
                    ? `${dutyAttestation.kind} · rounds ${dutyAttestation.startRound.toString()}-${dutyAttestation.endRound.toString()}`
                    : duties.notExposed
                      ? "duty schedule unavailable"
                      : "loading"}
                </div>
              </div>
              <div>
                <div className="cap">next key rotation</div>
                <div className="stat__sub">
                  {dutyKeyRotation && "nextRound" in dutyKeyRotation
                    ? `round ${dutyKeyRotation.nextRound.toString()} · epoch ${dutyKeyRotation.epochLengthRounds.toString()} rounds`
                    : dutyKeyRotation
                      ? dutyKeyRotation.reason
                      : duties.error ?? "loading"}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">
            {signing.notExposed
              ? "Signing history isn't available for this operator yet — the node couldn't resolve its authority index (it may still be catching up, or the operator's consensus key isn't published on this node)."
              : signing.error ?? "Signing activity is loading from the connected endpoint."}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card__head">
          <div>
            <h3>Service rewards · your earnings</h3>
            <div className="sub">
              cluster {clusterLabel(earningsClusterId)} · reward weight = proved service, not stake
            </div>
          </div>
          <span
            className={
              earnings.scored
                ? "halo halo--ok"
                : serviceScore.notExposed
                  ? "halo halo--warn"
                  : "halo halo--info"
            }
          >
            <span className="dot" />{" "}
            {earnings.scored
              ? "scored"
              : serviceScore.notExposed
                ? "score unavailable"
                : "not scored yet"}
          </span>
        </div>

        <div className="grid-2">
          <div>
            <div className="cap">settled ServiceScore</div>
            <div className="numeral numeral--gold">
              {serviceScore.notExposed ? "—" : earnings.scoreLabel}
            </div>
            <div className="stat__sub">
              the per-cluster score the reward path reads each block (node-registry Component A)
            </div>
          </div>
          <div>
            <div className="cap">how your reward splits</div>
            <div className="numeral">
              {charter.notExposed
                ? "—"
                : earnings.split.present
                  ? `${bpsToPercent(earnings.split.delegatorShareBps)} to delegators`
                  : "default split"}
            </div>
            <div className="stat__sub">
              {charter.notExposed
                ? "Reward split is not available from this node yet."
                : earnings.split.present
                  ? `operators keep ${bpsToPercent(10000 - earnings.split.delegatorShareBps)} of the cluster pot; delegators take ${bpsToPercent(earnings.split.delegatorShareBps)}`
                  : "this cluster uses the default operator/delegator split — amend it on the Cluster screen's charter panel"}
            </div>
          </div>
        </div>

        <p style={{ fontSize: 12, color: "var(--fg-400)", margin: "12px 0 4px" }}>
          Your rewards come from the services your cluster <b>proves</b> — signing, archive custody,
          GPU proving, RPC, indexing, and roster diversity — <b>not</b> from how much stake it holds.
          Stake only sets your cluster's rank. The chain folds the proofs below into the single
          settled ServiceScore above.
        </p>

        <div className="key-grid">
          {earnings.families.map((fam) => (
            <div className="key-row" key={fam.key}>
              <div>
                <div className="stat__label">{fam.label}</div>
                <div className="stat__sub">{fam.blurb}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--fg-500)", marginTop: 3 }}>
                  {fam.detail}
                </div>
              </div>
              <span
                className={
                  fam.status === "active"
                    ? "halo halo--ok"
                    : fam.status === "available"
                      ? "halo halo--info"
                      : fam.status === "scored"
                        ? "halo halo--gold"
                        : "halo halo--warn"
                }
                style={{ alignSelf: "flex-start" }}
              >
                <span className="dot" /> {fam.status}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <div>
            <h3>GPU prover market</h3>
            <div className="sub">
              a cluster service tier — direct per-operator revenue, separate from the equally-split consensus reward
            </div>
          </div>
          <span className="halo halo--info">
            <span className="dot" /> service tier · not consensus
          </span>
        </div>
        <div className="grid-2">
          <div>
            <div className="cap">prover requests</div>
            <div className="stat__sub">
              {prover.notExposed
                ? "available when activated"
                : prover.data?.status === "indexer_unavailable"
                  ? "indexer projection unavailable — request counts hidden"
                  : prover.data
                    ? `${prover.data.openRequests ?? 0} open · ${prover.data.assignedRequests ?? 0} assigned · ${prover.data.settledRequests ?? 0} settled`
                    : "loading"}
            </div>
          </div>
          <div>
            <div className="cap">fee floor</div>
            <div className="numeral">{formatLythHex(prover.data?.feeFloor)}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <div>
            <h3>Order-routing · operator-router</h3>
            <div className="sub">
              application-layer CLOB order-routing surcharge (0x100B) — not a consensus service tier
            </div>
          </div>
          <span className={`halo ${routerState.tone}`}>
            <span className="dot" /> router {routerState.label}
          </span>
        </div>
        <div className="grid-2">
          <div>
            <div className="cap">this operator's routing fee</div>
            <div className="numeral">{feeCfg.data ? bpsToPercent(feeCfg.data.feeBps) : "—"}</div>
            <div className="stat__sub">
              {feeCfg.data
                ? `recipient ${feeCfg.data.recipient.slice(0, 12)}… · registered at anchor ${feeCfg.data.registeredAtBlock.toLocaleString()}`
                : feeCfg.notExposed
                  ? "no routing fee registered for this operator"
                  : "loading"}
            </div>
          </div>
          <div>
            <div className="cap">protocol ceiling</div>
            <div className="numeral">{bpsToPercent(routerCfg.data?.protocolMaxOperatorFeeBps)}</div>
            <div className="stat__sub mono">router {routerCfg.data?.routerAddress ?? "0x100B"}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function displayMonikerInput(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || looksLikeMachineIdentifier(trimmed)) return "";
  return trimmed;
}

function looksLikeMachineIdentifier(value: string): boolean {
  const normalized = value.replace(/\s/g, "");
  if (/^mono1[a-z0-9]{20,}$/i.test(normalized)) return true;
  if (/^0x[0-9a-f]{10,}$/i.test(normalized)) return true;
  if (/^0x[0-9a-f]{6,}(…|\.{3})[0-9a-f]{4,}$/i.test(normalized)) return true;
  return /^[0-9a-f]{16,}$/i.test(normalized);
}

function compact(value: string): string {
  if (value === "—") return value;
  return value.length > 28 ? `${value.slice(0, 14)}…${value.slice(-10)}` : value;
}

function formatLythoshi(value: string | null | undefined): string {
  if (!value) return "bond unavailable";
  try {
    // Delegate to the SDK formatter, which owns the canonical 18-decimal
    // scale (1 LYTH = 1e18 lythoshi) and emits comma-grouped whole units
    // plus a trimmed fractional tail and the " LYTH" suffix.
    return formatLyth(BigInt(value));
  } catch {
    return "bond unavailable";
  }
}
