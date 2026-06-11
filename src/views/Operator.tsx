import { formatLyth } from "@monolythium/core-sdk";
import { useNavigate } from "react-router-dom";
import { useSelfOperator } from "../hooks/useSelfOperator";
import { useOps } from "../ops";
import {
  DEFAULT_ACTIVE_CLUSTER_ID,
  bpsToPercent,
  clusterLabel,
  formatLythHex,
  operatorRiskView,
  signingActivityView,
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
  // YOUR identity, derived from the stored key — never member[0].
  const self = useSelfOperator();
  const cluster = useClusterStatus(self.clusterId ?? ACTIVE_CLUSTER_ID);
  const clusterData = cluster.data;
  const operatorId = self.operatorId;
  const operator = useOperatorInfo(operatorId);
  const ops = useOps();
  const navigate = useNavigate();

  const authority = useOperatorAuthority(operatorId);
  const authorityIndex = authority.data?.authorityIndex ?? null;
  const risk = useOperatorRisk(authorityIndex, 200);
  const signing = useOperatorSigningActivity(authorityIndex, 200);
  const duties = useUpcomingDuties(authorityIndex, 500);
  const routerCfg = useOperatorRouterConfig();
  const prover = useProverMarketStatus();

  const v = operator.data;
  const setSize = clusterData?.members.length ?? null;
  const moniker = v?.moniker ?? (operatorId ? shortId(operatorId) : "no operator key");
  const activeClusterLabel = clusterLabel(clusterData?.id ?? ACTIVE_CLUSTER_ID);
  const activeClusterId = String(clusterData?.id ?? ACTIVE_CLUSTER_ID);
  const jailed = v?.jailed ?? false;
  const riskSummary = operatorRiskView(risk.data, jailed);
  const signingSummary = signingActivityView(signing.data);
  const recentSigning = signingSummary.entries.slice(-80);
  const dutyAttestation = duties.data?.duties.attestation;
  const dutyKeyRotation = duties.data?.duties.keyRotation;
  const keyRows = [
    { label: "Operator account", algo: "node-registry", value: v?.address ?? "—" },
    { label: "Operator id", algo: "cluster member", value: operatorId ?? "—" },
    { label: "Consensus key fingerprint", algo: "registry", value: v?.pubkey ?? "—" },
    { label: "Cluster anchor", algo: "derived", value: clusterData?.anchorAddress ?? "—" },
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
          chain_id {status.chainId ?? "—"} · {status.endpoint}
          {setSize !== null ? ` · ${setSize} operators visible` : null}
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
          <span className="dot" /> identity RPC not yet exposed — live identity unavailable
        </div>
      ) : null}

      <div className="card card--padded operator-hero">
        <div>
          <div className="cap">operator identity</div>
          <div className="operator-hero__moniker">{moniker}</div>
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
                sub: "Submit public operator metadata",
                intro:
                  "Posts setOperatorDisplay(bytes32,string,string) from the operator's PQM-1 mnemonic. Monoscan and Desktop read the resulting public moniker and alias through lyth_operatorInfo.",
                fields: [
                  { key: "operator", label: "Operator", value: moniker },
                  { key: "peer-id", label: "Peer id", value: operatorId ?? "enter peer id" },
                  { key: "source", label: "Source", value: "lyth_operatorInfo" },
                ],
                operatorDisplayInput: {
                  peerIdHex: operatorId ?? "",
                  moniker: displayMonikerInput(v?.moniker, operatorId),
                  alias: "",
                },
                icon: "ID",
                risk: "medium",
                needsPasskey: true,
                confirmLabel: "Sign display metadata tx",
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
                sub: "Submit LythiumSeal EK",
                intro:
                  "Posts publishOperatorSealKey(bytes32,bytes) from the operator's PQM-1 mnemonic. Desktop can load the public ML-KEM-768 EK from the connected Monarch OS node before signing.",
                fields: [
                  { key: "operator", label: "Operator", value: moniker },
                  { key: "peer-id", label: "Peer id", value: operatorId ?? "derived from keychain" },
                  { key: "executor", label: "Executor", value: "publishOperatorSealKey(bytes32,bytes)" },
                ],
                operatorSealKeyInput: operatorId
                  ? { peerIdHex: operatorId, sealEkHex: "" }
                  : undefined,
                icon: "SK",
                risk: "medium",
                needsPasskey: true,
                confirmLabel: "Sign seal key tx",
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
                sub: "Prepare CJ-1 join request",
                intro:
                  "Prepares requestClusterJoin(uint32,bytes) for this cluster. Desktop preloads the cluster id, derives the operator ML-DSA-65 consensus pubkey from the stored PQM-1 mnemonic when available, preflights the request view, then signs and submits after the operator seal key is published.",
                fields: [
                  { key: "cluster", label: "Cluster", value: activeClusterLabel },
                  {
                    key: "flow",
                    label: "Flow",
                    value: "cluster vote admission; runtime preflight gated",
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
                confirmLabel: "Prepare join request",
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
                sub: "Submit DKG re-share attestation",
                intro:
                  "After the key-share ceremony produces participant ML-DSA-65 consensus pubkeys and per-signer attestation signatures, Desktop submits attestDkgReshare(uint64,bytes,bytes) from the operator signer.",
                fields: [
                  { key: "cluster", label: "Cluster", value: activeClusterLabel },
                  { key: "operators", label: "Operators", value: clusterData ? `${clusterData.threshold}-of-${clusterData.size} quorum` : "cluster unavailable" },
                ],
                icon: "KY",
                risk: "high",
                destructive: true,
                needsPasskey: true,
                confirmLabel: "Sign DKG attestation",
              })
            }
          >
            Rotate keys →
          </button>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card__head">
            <div>
              <h3>Keys</h3>
              <div className="sub">live registry fields · copyable when available</div>
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
                  className="copy-btn"
                  disabled={k.value === "—"}
                  onClick={() => void navigator.clipboard?.writeText(k.value)}
                  aria-label={`Copy ${k.label}`}
                >
                  CP
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
                ? "removal-risk window not exposed by this node"
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
                ? "signing history not exposed by this node"
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
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() =>
                ops.requestOp({
                  kind: "operator-restore",
                  title: "Restore operator",
                  sub: "Foundation recovery tx",
                  intro:
                    "Restore maps to node-registry recoverOperatorNode(bytes32), the foundation-gated disaster-recovery alias for unjail(bytes32). Desktop submits only when the foundation operations signer is stored in the OS keychain.",
                  fields: [
                    { key: "operator", label: "Operator", value: moniker },
                    { key: "peer-id", label: "Peer id", value: operatorId ?? "enter peer id" },
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
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() =>
                ops.requestOp({
                  kind: "rotate-keys",
                  title: "Rotate signing share",
                  sub: "Submit DKG re-share attestation",
                  intro:
                    "After the key-share ceremony produces participant ML-DSA-65 consensus pubkeys and per-signer attestation signatures, Desktop submits attestDkgReshare(uint64,bytes,bytes) from the operator signer.",
                  fields: [{ key: "cluster", label: "Cluster", value: clusterData ? activeClusterLabel : "cluster unavailable" }],
                  icon: "KY",
                  risk: "high",
                  destructive: true,
                  needsPasskey: true,
                  confirmLabel: "Sign DKG attestation",
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
                      ? "duty schedule not exposed"
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
              ? "Your node does not expose signing history for this operator yet — update protocore to enable this view."
              : signing.error ?? "Signing activity is loading from the connected endpoint."}
          </div>
        )}
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

function shortId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function displayMonikerInput(value: string | undefined, operatorId: string | null): string {
  if (!value || !operatorId) return "";
  const sdkFallback =
    operatorId.length <= 16 ? operatorId : `${operatorId.slice(0, 8)}…${operatorId.slice(-6)}`;
  if (value === operatorId || value === sdkFallback || value === shortId(operatorId)) {
    return "";
  }
  return value;
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
