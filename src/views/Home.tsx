import { ClusterRing } from "../components/ClusterRing";
import { useOps } from "../ops";
import {
  DEFAULT_ACTIVE_CLUSTER_ID,
  MONARCH_CLUSTER_SIZE,
  MONARCH_CLUSTER_THRESHOLD,
  bpsToPercent,
  clusterLabel,
  evaluateClusterModel,
  operatorRiskView,
  signingActivityView,
  useChainStatus,
  useClusterStatus,
  useNodeStatus,
  useOperatorAuthority,
  useOperatorRisk,
  useOperatorSigningActivity,
  useUpcomingDuties,
} from "../sdk";
import { useNavigate } from "react-router-dom";

const ACTIVE_CLUSTER_ID = DEFAULT_ACTIVE_CLUSTER_ID;

export function Home() {
  const status = useNodeStatus();
  const chain = useChainStatus();
  const cluster = useClusterStatus(ACTIVE_CLUSTER_ID);
  const ops = useOps();
  const navigate = useNavigate();

  const clusterData = cluster.data;
  const members = clusterData?.members ?? [];
  const primaryOperatorId = members[0]?.operatorId ?? null;
  const authority = useOperatorAuthority(primaryOperatorId);
  const authorityIndex = authority.data?.authorityIndex ?? null;
  const risk = useOperatorRisk(authorityIndex, 200);
  const signing = useOperatorSigningActivity(authorityIndex, 200);
  const duties = useUpcomingDuties(authorityIndex, 500);
  const reachable = status.reachable && (chain.data?.reachable ?? true);
  const blockHeight =
    chain.data?.blockHeight || status.blockNumber || chain.data?.finalizedHeight || 0;
  const operatorCount = chain.data?.operatorCount ?? (clusterData ? members.length : null);
  const clusterCount = chain.data?.clusterCount ?? null;
  const clusterAvailable = Boolean(clusterData && !cluster.notExposed);
  const clusterModel = evaluateClusterModel(clusterData, clusterCount);
  const activeClusterLabel = clusterLabel(clusterData?.id ?? ACTIVE_CLUSTER_ID);
  const riskSummary = operatorRiskView(risk.data);
  const signingSummary = signingActivityView(signing.data);
  const recentSigning = signingSummary.entries.slice(-56);
  const attestation = duties.data?.duties.attestation;
  const keyRotation = duties.data?.duties.keyRotation;

  return (
    <section className="view fade-in">
      <header>
        <h1 className="view__title">Home</h1>
        <p className="view__subtitle">
          chain_id {chain.data?.chainId ?? status.chainId ?? "—"} · {clusterModel.targetSummary} · {clusterModel.thresholdSummary}
        </p>
      </header>

      {chain.notExposed || cluster.notExposed ? (
        <div
          className="halo halo--warn"
          style={{ alignSelf: "flex-start" }}
          title="Chain or cluster status not yet exposed on this node"
        >
          <span className="dot" /> Some methods not yet exposed — unavailable values are blank
        </div>
      ) : null}

      <div className="home-row home-row--hero">
        <div className="card card--padded home-ticker">
          <div className="home-ticker__head">
            <div>
              <div className="cap">current block height</div>
              <div className="home-ticker__number">
                {blockHeight ? blockHeight.toLocaleString() : "—"}
              </div>
            </div>
            <span className={reachable ? "halo halo--ok" : "halo halo--err"}>
              <span className="dot dot--pulse" />
              {reachable ? "synced" : "unreachable"}
            </span>
          </div>
          <div className="home-ticker__footer">
            <HeroStat label="Operators" value={operatorCount ? String(operatorCount) : "—"} tone="info" />
            <HeroStat label="Signing" value={signingSummary.signedPctLabel} tone="ok" />
            <HeroStat label="Missed" value={String(signingSummary.missed)} tone={signingSummary.missed > 0 ? "warn" : "gold"} />
            <HeroStat
              label="Removal risk"
              value={risk.data ? bpsToPercent(risk.data.missRateBps) : "—"}
              tone={riskSummary.tone === "err" ? "err" : riskSummary.tone}
            />
          </div>
        </div>

        <div className="card card--padded home-cluster-card">
          <div className="card__head">
            <div>
              <h3>Cluster {activeClusterLabel}</h3>
              <div className="sub">
                {clusterData
                  ? `${clusterData.threshold}-of-${clusterData.size} live quorum · ${clusterModel.seatSummary}`
                  : cluster.notExposed
                    ? "cluster status RPC not exposed"
                    : `${MONARCH_CLUSTER_THRESHOLD}-of-${MONARCH_CLUSTER_SIZE} target quorum`}
              </div>
            </div>
            <span className={clusterAvailable ? "halo halo--ok" : "halo halo--warn"}>
              <span className="dot" /> {clusterAvailable ? "live" : "blocked"}
            </span>
          </div>
          <ClusterRing
            members={members}
            threshold={clusterData?.threshold ?? 0}
            expectedSize={MONARCH_CLUSTER_SIZE}
            expectedThreshold={MONARCH_CLUSTER_THRESHOLD}
            size={250}
          />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => navigate("/cluster")}
          >
            Inspect cluster →
          </button>
        </div>
      </div>

      <div className="home-row">
        <div className="card card--padded">
          <div className="card__head">
            <div>
              <h3>Signing activity</h3>
              <div className="sub">
                {authorityIndex !== null
                  ? `lyth_signingActivity · authority ${authorityIndex}`
                  : "awaiting operator authority"}
              </div>
            </div>
            <span className={`halo halo--${signing.notExposed ? "warn" : "ok"}`}>
              <span className="dot" /> {signing.notExposed ? "not exposed" : signingSummary.signedPctLabel}
            </span>
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
                <span>{signingSummary.signed} signed</span>
                <span>{signingSummary.missed} missed · {signingSummary.noCert} no certificate</span>
              </div>
              <div className="stat__sub mono" style={{ marginTop: 10 }}>
                {risk.notExposed ? "risk window unavailable" : riskSummary.detail}
              </div>
            </>
          ) : (
            <div className="empty-state">
              {signing.notExposed
                ? "lyth_signingActivity is unavailable for the selected operator."
                : signing.error ?? "Signing activity is loading from the connected endpoint."}
            </div>
          )}
        </div>

        <div className="card card--padded">
          <div className="card__head">
            <div>
              <h3>Upcoming duties</h3>
              <div className="sub">
                {authorityIndex !== null
                  ? `lyth_upcomingDuties · horizon ${duties.data?.horizonRounds ?? 500} rounds`
                  : "awaiting operator authority"}
              </div>
            </div>
            <span className={`halo halo--${duties.notExposed ? "warn" : "info"}`}>
              <span className="dot" /> {duties.notExposed ? "not exposed" : "live schedule"}
            </span>
          </div>
          {duties.data ? (
            <div className="grid-2">
              <div>
                <div className="cap">attestation</div>
                <div className="stat__sub">
                  {attestation
                    ? `${attestation.kind} · rounds ${attestation.startRound.toString()}-${attestation.endRound.toString()}`
                    : "no attestation window returned"}
                </div>
              </div>
              <div>
                <div className="cap">key rotation</div>
                <div className="stat__sub">
                  {keyRotation && "nextRound" in keyRotation
                    ? `round ${keyRotation.nextRound.toString()} · epoch ${keyRotation.epochLengthRounds.toString()} rounds`
                    : keyRotation
                      ? keyRotation.reason
                      : "no key-rotation window returned"}
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              {duties.notExposed
                ? "lyth_upcomingDuties is unavailable for the selected operator."
                : duties.error ?? "Duty schedule is loading from the connected endpoint."}
            </div>
          )}
        </div>
      </div>

      <div className="quick-grid">
        <QuickAction
          title="Rotate signing share"
          caption="Submit DKG attestation"
          onClick={() =>
            ops.requestOp({
              kind: "rotate-keys",
              title: "Rotate signing share",
              sub: "Submit DKG re-share attestation",
              intro:
                "After the key-share ceremony produces participant ML-DSA-65 consensus pubkeys and per-signer attestation signatures, Desktop submits attestDkgReshare(uint64,bytes,bytes) from the operator signer.",
              fields: [
                {
                  key: "cluster",
                  label: "Cluster",
                  value: activeClusterLabel,
                },
                {
                  key: "operators",
                  label: "Operators",
                  value: clusterData
                    ? `${clusterData.threshold}-of-${clusterData.size} quorum`
                    : "cluster loading",
                },
              ],
              icon: "KY",
              risk: "high",
              destructive: true,
              needsPasskey: true,
              confirmLabel: "Sign DKG attestation",
            })
          }
        />
        <QuickAction
          title="Graceful restart"
          caption="Drain, restart, watch logs"
          onClick={() =>
            ops.requestOp({
              kind: "operator-restart",
              title: "Graceful restart",
              sub: "Cycle operator-node service",
              intro:
                "Stops the service, lets the cluster maintain quorum without this operator, then rejoins after the service is healthy.",
              fields: [
                { key: "node", label: "Node", value: status.endpoint },
                { key: "downtime", label: "Downtime", value: "operator-controlled" },
              ],
              icon: "RS",
              risk: "low",
              needsPasskey: true,
            })
          }
        />
        <QuickAction
          title="Export backup"
          caption="Offline Talos copy when stopped"
          onClick={() =>
            ops.requestOp({
              kind: "export-backup",
              title: "Export backup",
              sub: "Export stopped Protocore data",
              intro:
                "Exports /var/lib/protocore through the Talos Copy API as a local .tar.gz plus a manifest. This is an offline backup path only: Desktop refuses to run unless ext-protocore is already stopped or offline.",
              fields: [
                { key: "scope", label: "Scope", value: "/var/lib/protocore" },
                { key: "transport", label: "Transport", value: "Talos Copy API" },
                { key: "requirement", label: "Requirement", value: "ext-protocore stopped/offline" },
              ],
              icon: "BK",
              risk: "medium",
              needsPasskey: true,
              confirmLabel: "Export offline backup",
            })
          }
        />
      </div>
    </section>
  );
}

function HeroStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn" | "info" | "gold" | "err";
}) {
  return (
    <div className={`hero-stat hero-stat--${tone}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function QuickAction({
  title,
  caption,
  onClick,
}: {
  title: string;
  caption: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="quick-action card" onClick={onClick}>
      <span>
        <b>{title}</b>
        <small>{caption}</small>
      </span>
      <i aria-hidden>→</i>
    </button>
  );
}
