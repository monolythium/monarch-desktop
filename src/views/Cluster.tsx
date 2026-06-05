import { ClusterRing } from "../components/ClusterRing";
import { useOps } from "../ops";
import {
  DEFAULT_ACTIVE_CLUSTER_ID,
  MONARCH_ACTIVE_OPERATOR_SEATS,
  MONARCH_CLUSTER_SIZE,
  MONARCH_CLUSTER_THRESHOLD,
  MONARCH_STANDBY_OPERATOR_SEATS,
  MONARCH_TARGET_ACTIVE_OPERATOR_SEATS,
  MONARCH_TARGET_OPERATOR_POSITIONS,
  MONARCH_TARGET_STANDBY_OPERATOR_SEATS,
  bpsToPercent,
  clusterResignationSummary,
  clusterLabel,
  evaluateClusterModel,
  formatLythHex,
  formatResignationHeight,
  hostingClassLabel,
  resignationStatusTone,
  useBridgeHealth,
  useChainStatus,
  useClusterDirectory,
  useClusterDiversity,
  useClusterResignations,
  useClusterStatus,
  useCurrentRound,
  useOperatorNetworkMetadataMap,
  useOracleSigners,
  useProviderDirectory,
} from "../sdk";

const ACTIVE_CLUSTER_ID = DEFAULT_ACTIVE_CLUSTER_ID;

export function Cluster() {
  const cluster = useClusterStatus(ACTIVE_CLUSTER_ID);
  const chain = useChainStatus();
  const round = useCurrentRound();
  const diversity = useClusterDiversity(ACTIVE_CLUSTER_ID);
  const resignations = useClusterResignations(null, "all");
  const oracle = useOracleSigners();
  const bridge = useBridgeHealth();
  const clusters = useClusterDirectory(0, 100);
  const providers = useProviderDirectory(0, null, 50);
  const memberMetadata = useOperatorNetworkMetadataMap(
    cluster.data?.members.map((member) => member.operatorId) ?? [],
  );
  const ops = useOps();

  const c = cluster.data;
  const members = c?.members ?? [];
  const live = members.filter((m) => m.state === "nominal").length;
  const lagging = members.filter((m) => m.state === "lag").length;
  const offline = members.filter((m) => m.state === "jail").length;
  const lag = members.find((m) => m.state === "lag");
  const leadMemberId = members[0]?.operatorId ?? null;
  const leadMeta = leadMemberId ? memberMetadata.data?.[leadMemberId] ?? null : null;
  const clusterRows = clusters.data ?? [];
  const resignationRows = resignations.data?.rows ?? [];
  const resignationSummary = clusterResignationSummary(resignationRows);
  const clusterModel = evaluateClusterModel(c, chain.data?.clusterCount ?? null);
  const activeClusterLabel = clusterLabel(c?.id ?? ACTIVE_CLUSTER_ID);
  const activeClusterId = c?.id ?? ACTIVE_CLUSTER_ID;
  const modelTone =
    clusterModel.state === "aligned" ? "halo--ok"
    : clusterModel.state === "degraded" ? "halo--err"
    : "halo--warn";

  return (
    <section className="view fade-in">
      <header>
        <h1 className="view__title">
          Cluster {activeClusterLabel}
        </h1>
        <p className="view__subtitle">
          distributed operator cluster · {c ? `${c.threshold}-of-${c.size} quorum` : clusterModel.thresholdSummary}
          {round.data ? ` · round ${round.data.height.toLocaleString()}` : null}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() =>
              ops.requestOp({
                kind: "cluster-name-register",
                title: "Set cluster name",
                sub: "Register public cluster name",
                intro:
                  "Posts register(string,uint64) to cluster-name registry 0x1104 from the cluster primary anchor key. Monoscan and Desktop read the resulting canonical name through lyth_getClusterName.",
                fields: [
                  { key: "cluster", label: "Cluster id", value: String(activeClusterId) },
                  { key: "source", label: "Source", value: "lyth_getClusterName" },
                  { key: "authority", label: "Authority", value: "primary anchor key" },
                ],
                clusterNameInput: {
                  clusterId: String(activeClusterId),
                  name: "",
                },
                icon: "CN",
                risk: "medium",
                needsPasskey: true,
                confirmLabel: "Sign cluster name tx",
              })
            }
          >
            Set name
          </button>
        </div>
      </header>

      {cluster.notExposed ? (
        <div className="halo halo--warn" style={{ alignSelf: "flex-start" }}>
          <span className="dot" /> cluster RPC not yet exposed — member list unavailable
        </div>
      ) : null}

      <div className="card card--padded">
        <div className="card__head" style={{ padding: 0, marginBottom: 12 }}>
          <div>
            <h3>Whitepaper cluster model</h3>
            <div className="sub">
              {clusterModel.targetSummary} · {clusterModel.seatSummary}
            </div>
          </div>
          <span className={`halo ${modelTone}`}>
            <span className="dot" /> {clusterModel.label}
          </span>
        </div>
        <div className="grid-4">
          <ModelStat label="network seats" value={MONARCH_TARGET_OPERATOR_POSITIONS.toLocaleString()} sub={`${MONARCH_TARGET_ACTIVE_OPERATOR_SEATS} active · ${MONARCH_TARGET_STANDBY_OPERATOR_SEATS} standby`} />
          <ModelStat label="cluster seats" value={String(MONARCH_CLUSTER_SIZE)} sub={`${MONARCH_ACTIVE_OPERATOR_SEATS} active · ${MONARCH_STANDBY_OPERATOR_SEATS} standby`} />
          <ModelStat label="threshold" value={`${MONARCH_CLUSTER_THRESHOLD}-of-${MONARCH_CLUSTER_SIZE}`} sub="tolerates three outages" />
          <ModelStat label="connected cluster" value={c ? `${clusterModel.liveOperators}/${c.size}` : "—"} sub={c ? `${clusterModel.offlineOperators} offline` : "awaiting lyth_clusterStatus"} />
        </div>
        {clusterModel.blockers.length > 0 ? (
          <div className="stat__sub mono" style={{ marginTop: 12 }}>
            {clusterModel.blockers.join(" · ")}
          </div>
        ) : null}
      </div>

      <div className="card card--flush">
        <div className="card__head" style={{ padding: "16px 20px 0" }}>
          <div>
            <h3>Cluster directory</h3>
            <div className="sub">
              {clusters.notExposed
                ? "lyth_clusterDirectory unavailable"
                : clusterRows.length > 0
                  ? `${clusterRows.length} clusters visible`
                  : "loading"}
            </div>
          </div>
          {clusters.notExposed ? (
            <span className="halo halo--warn">
              <span className="dot" /> directory read unavailable
            </span>
          ) : (
            <span className="halo halo--ok">
              <span className="dot" /> live
            </span>
          )}
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>cluster</th>
              <th>quorum</th>
              <th>health</th>
              <th>regions</th>
              <th>active</th>
              <th>admission</th>
            </tr>
          </thead>
          <tbody>
            {clusterRows.slice(0, 12).map((row) => {
              const label = clusterLabel(row.clusterId);
              return (
                <tr key={row.clusterId}>
                  <td>{label}</td>
                  <td className="mono">{row.threshold}-of-{row.size}</td>
                  <td>{row.aggregateHealth}</td>
                  <td>{row.regionDiversity?.join(", ") ?? "-"}</td>
                  <td>
                    <span className={row.active ? "halo halo--ok" : "halo halo--warn"}>
                      <span className="dot" /> {row.active ? "active" : "inactive"}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() =>
                        ops.requestOp({
                          kind: "cluster-request-join",
                          title: `Request join for ${label}`,
                          sub: "Prepare CJ-1 join request",
                          intro:
                            "Prepares requestClusterJoin(uint32,bytes) for the selected cluster. Desktop preloads the cluster id, derives the operator ML-DSA-65 consensus pubkey from the stored PQM-1 mnemonic when available, preflights the request view, then signs and submits on CJ-1 runtimes.",
                          fields: [
                            { key: "cluster", label: "Cluster", value: label },
                            { key: "flow", label: "Flow", value: "CJ-1 requestClusterJoin; runtime preflight gated" },
                            { key: "seal-roster", label: "Seal roster", value: "consensus-only until the decrypt roster updates" },
                          ],
                          clusterJoinRequestInput: {
                            clusterId: String(row.clusterId),
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
                  </td>
                </tr>
              );
            })}
            {clusterRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="mono" style={{ color: "var(--fg-500)" }}>
                  {clusters.notExposed
                    ? "Cluster directory RPC is not exposed by this endpoint."
                    : "No clusters returned by the connected endpoint."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {clusterRows.length > 12 ? (
          <div className="stat__sub mono" style={{ padding: "0 20px 16px" }}>
            Showing 12 of {clusterRows.length} clusters.
          </div>
        ) : null}
      </div>

      <div className="card card--flush">
        <div className="card__head" style={{ padding: "16px 20px 0" }}>
          <div>
            <h3>Provider directory</h3>
            <div className="sub">
              {providers.notExposed
                ? "lyth_listProviders unavailable"
                : providers.data
                  ? `${providers.data.length} registered providers`
                  : "loading"}
            </div>
          </div>
          {providers.notExposed ? (
            <span className="halo halo--warn">
              <span className="dot" /> registry read unavailable
            </span>
          ) : null}
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>peer</th>
              <th>endpoint</th>
              <th>capabilities</th>
              <th>uptime</th>
              <th>bond</th>
              <th>admission</th>
            </tr>
          </thead>
          <tbody>
            {(providers.data ?? []).slice(0, 12).map((provider) => (
              <tr key={provider.peerId}>
                <td className="mono">{compactHex(provider.peerId)}</td>
                <td className="mono" title={provider.endpoint}>
                  {provider.endpoint.length > 42
                    ? `${provider.endpoint.slice(0, 30)}…${provider.endpoint.slice(-8)}`
                    : provider.endpoint}
                </td>
                <td className="mono">0x{provider.capabilities.toString(16).padStart(4, "0")}</td>
                <td className="mono">{bpsToPercent(provider.uptimeBps)}</td>
                <td className="mono">{formatLythHex(provider.bond)}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() =>
                      ops.requestOp({
                        kind: "cluster-vote-admit",
                        title: `Vote admit ${compactHex(provider.peerId)} to ${activeClusterLabel}`,
                        sub: "Prepare CJ-1 admit vote",
                        intro:
                          "Prepares voteClusterAdmit(uint32,bytes32,bytes) for the connected cluster. Desktop preflights the candidate request, then signs and submits from the stored operator key on CJ-1 runtimes.",
                        fields: [
                          { key: "cluster", label: "Cluster", value: activeClusterLabel },
                          { key: "candidate", label: "Candidate", value: compactHex(provider.peerId) },
                          { key: "flow", label: "Flow", value: "CJ-1 voteClusterAdmit; runtime preflight gated" },
                        ],
                        clusterVoteAdmitInput: {
                          clusterId: String(activeClusterId),
                          operatorIdHex: provider.peerId,
                          voterPubkeyHex: "",
                        },
                        icon: "VA",
                        risk: "high",
                        destructive: true,
                        needsPasskey: true,
                        confirmLabel: "Prepare admit vote",
                      })
                    }
                  >
                    Vote admit
                  </button>
                </td>
              </tr>
            ))}
            {(providers.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={6} className="mono" style={{ color: "var(--fg-500)" }}>
                  {providers.notExposed
                    ? "Provider directory RPC is not exposed by this endpoint."
                    : "No providers returned by the connected endpoint."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {(providers.data ?? []).length > 12 ? (
          <div className="stat__sub mono" style={{ padding: "0 20px 16px" }}>
            Showing 12 of {providers.data?.length ?? 0} providers.
          </div>
        ) : null}
      </div>

      <div className="cluster-layout">
        <div className="card card--padded cluster-ring-card">
          <ClusterRing
            members={members}
            threshold={c?.threshold ?? 0}
            expectedSize={MONARCH_CLUSTER_SIZE}
            expectedThreshold={MONARCH_CLUSTER_THRESHOLD}
            size={340}
          />
          <div className="cluster-counts">
            <Count label="live" value={live} tone="ok" />
            <Count label="lagging" value={lagging} tone="warn" />
            <Count label="offline" value={offline} tone="err" />
          </div>
        </div>

        <div className="card card--flush">
          <div className="card__head" style={{ padding: "16px 20px 0" }}>
            <div>
              <h3>Member directory</h3>
              <div className="sub">
                {members.length > 0
                  ? `${members.length} operators from live cluster status`
                  : cluster.notExposed
                    ? "blocked by lyth_clusterStatus"
                    : "loading"}
              </div>
            </div>
          </div>
          <table className="tbl cluster-table">
            <thead>
              <tr>
                <th>operator</th>
                <th>hosting</th>
                <th>region</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const meta = memberMetadata.data?.[m.operatorId] ?? null;
                const tone =
                  m.state === "nominal" ? "halo--ok"
                  : m.state === "lag" ? "halo--warn"
                  : m.state === "maintenance" ? "halo--info"
                  : "halo--err";
                return (
                  <tr key={m.id}>
                    <td>
                      <span className="member-cell">
                        <span className={`avatar avatar--${m.state}`}>{initials(m.handle)}</span>
                        <span className="mono">{m.handle}</span>
                      </span>
                    </td>
                    <td>
                      {meta
                        ? hostingClassLabel(meta.hostingClass)
                        : memberMetadata.notExposed
                          ? "not exposed"
                          : "—"}
                    </td>
                    <td>{meta?.geoRegion ?? (memberMetadata.notExposed ? "not exposed" : "—")}</td>
                    <td>
                      <span className={`halo ${tone}`}>
                        <span className="dot" /> {stateLabel(m.state)}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {members.length === 0 ? (
                <tr>
                  <td colSpan={4} className="mono" style={{ color: "var(--fg-500)" }}>
                    No live cluster members returned by the connected endpoint.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {lag ? (
        <div className="card card--padded lag-card">
          <div>
            <div className="cap text-warn">who's lagging</div>
            <h3>{lag.handle} is not nominal</h3>
            <p>
              Cluster status reports this operator as {stateLabel(lag.state)}.
              Network diagnostics require a live endpoint in operator metadata.
            </p>
          </div>
          <div className="lag-card__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() =>
                ops.requestOp({
                  kind: "operator-restart",
                  title: `Restart ${lag.handle}`,
                  sub: "Graceful service restart",
                  intro:
                    "Stops and starts the operator-node service after a drain window. Cluster quorum remains intact.",
                  fields: [
                    { key: "operator", label: "Operator", value: lag.handle },
                    { key: "state", label: "State", value: stateLabel(lag.state) },
                  ],
                  icon: "RS",
                  risk: "low",
                  needsPasskey: true,
                })
              }
            >
              Restart operator
            </button>
          </div>
        </div>
      ) : null}

      <div className="card card--flush">
        <div className="card__head" style={{ padding: "16px 20px 0" }}>
          <div>
            <h3>Cluster resignations</h3>
            <div className="sub">
              {resignations.notExposed
                ? "lyth_getClusterResignations unavailable"
                : `${resignationSummary.pending + resignationSummary.wirePending} pending · ${resignationSummary.applied} applied`}
            </div>
          </div>
          <span className={`halo halo--${resignationSummary.pending + resignationSummary.wirePending > 0 ? "warn" : "ok"}`}>
            <span className="dot" /> {resignationSummary.total} rows
          </span>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>operator key</th>
              <th>status</th>
              <th>effective height</th>
              <th>nonce</th>
            </tr>
          </thead>
          <tbody>
            {resignationRows.slice(0, 8).map((row) => {
              const tone = resignationStatusTone(row.status);
              return (
                <tr key={`${row.operator}-${row.nonce.toString()}`}>
                  <td className="mono">{compactHex(row.operator)}</td>
                  <td>
                    <span className={`halo halo--${tone}`}>
                      <span className="dot" /> {row.status}
                      {row.expedited ? " · expedited" : ""}
                    </span>
                  </td>
                  <td className="mono">{formatResignationHeight(row.effective_at_height)}</td>
                  <td className="mono">{row.nonce.toString()}</td>
                </tr>
              );
            })}
            {resignationRows.length === 0 ? (
              <tr>
                <td colSpan={4} className="mono" style={{ color: "var(--fg-500)" }}>
                  {resignations.notExposed
                    ? "Cluster resignation RPC is not exposed by this endpoint."
                    : "No pending or applied cluster resignation rows returned."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {resignationRows.length > 8 ? (
          <div className="stat__sub mono" style={{ padding: "0 20px 16px" }}>
            Showing 8 of {resignationRows.length} resignation rows.
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="card__head">
          <div>
            <h3>Diversity &amp; network services</h3>
            <div className="sub">on-chain cluster diversity score · oracle &amp; bridge posture</div>
          </div>
          {diversity.notExposed || oracle.notExposed || bridge.notExposed ? (
            <span className="halo halo--warn">
              <span className="dot" /> some reads not yet exposed
            </span>
          ) : null}
        </div>
        <div className="cap" style={{ marginBottom: 4 }}>cluster anchor · derived from roster + threshold</div>
        <div className="mono" style={{ wordBreak: "break-all", marginBottom: 16, color: "var(--fg-500)" }}>
          {c?.anchorAddress ?? "— (resolves once members expose full roster keys)"}
        </div>
        <div className="grid-2">
          <div>
            <div className="cap">cluster diversity score</div>
            <div className="numeral numeral--gold">
              {diversity.data ? bpsToPercent(diversity.data.score) : diversity.notExposed ? "—" : "…"}
            </div>
            <div className="stat__sub mono">
              {diversity.data
                ? `ASN ${bpsToPercent(diversity.data.asnVariance)} · geo ${bpsToPercent(diversity.data.geoVariance)} · hosting ${bpsToPercent(diversity.data.hostingSpread)}`
                : diversity.notExposed
                  ? "diversity scoring not yet exposed"
                  : "loading"}
            </div>
            <div className="stat__sub mono" style={{ marginTop: 8 }}>
              {memberMetadata.notExposed
                ? "lead operator network metadata not exposed"
                : leadMeta
                  ? `lead: ${hostingClassLabel(leadMeta.hostingClass)} · ${leadMeta.geoRegion ?? "geo —"} · ASN ${leadMeta.asn ?? "—"}`
                  : "lead operator: loading"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div>
              <div className="stat__label">oracle writers</div>
              <div className="mono">
                {oracle.notExposed
                  ? "not exposed"
                  : oracle.data?.status === "indexer_unavailable"
                    ? "indexer unavailable"
                    : (oracle.data?.writers.length ?? 0)}
              </div>
            </div>
            <div>
              <div className="stat__label">bridge routes</div>
              <div className="mono">
                {bridge.notExposed
                  ? "not exposed"
                  : `${bridge.data?.records.length ?? 0} · ${
                      bridge.data?.records.filter((r) => r.circuitBreaker.paused).length ?? 0
                    } paused`}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ModelStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div>
      <div className="stat__label">{label}</div>
      <div className="numeral numeral--gold">{value}</div>
      <div className="stat__sub mono">{sub}</div>
    </div>
  );
}

function Count({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "err";
}) {
  return (
    <div className={`cluster-count cluster-count--${tone}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function initials(handle: string): string {
  return handle
    .split(/[-_]/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function stateLabel(state: string): string {
  return state === "jail" ? "offline" : state;
}

function compactHex(value: string): string {
  return value.length > 30 ? `${value.slice(0, 16)}…${value.slice(-10)}` : value;
}
