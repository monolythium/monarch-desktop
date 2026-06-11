import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { OperatorKeySettings } from "../components/OperatorKeySettings";
import { Term } from "../components/Term";
import { useKeychainPresence, useSelfOperator } from "../hooks/useSelfOperator";
import {
  OP_CATALOG,
  useOps,
  type OpCatalogEntry,
  type OpKind,
  type OpRequest,
} from "../ops";
import {
  isAuditReadyOperationReceipt,
  verifyStoredReceiptHash,
  type ReceiptHashVerification,
} from "../ops/receipts";
import "../styles/livedata.css";
import {
  DEFAULT_ACTIVE_CLUSTER_ID,
  bpsToPercent,
  clusterLabel,
  desktopReleaseReadiness,
  formatLythHex,
  inTauri,
  KEYCHAIN_ACCOUNTS,
  keychainGet,
  releaseAttestationStatus,
  rpcEndpoint,
  talosProtocoreReadiness,
  talosService,
  talosStatus,
  useBridgeHealth,
  useChainStatus,
  useClusterDirectory,
  useClusterStatus,
  useIndexerStatus,
  useNodeStatus,
  useOperatorCapabilities,
  useOperatorFeeConfig,
  useOperatorInfo,
  useOperatorRouterConfig,
  useOracleSigners,
  useProviderDirectory,
  useProverMarketStatus,
  useRuntimeProvenance,
  type ProtocoreReadiness,
  type TalosServiceInfo,
  type TalosStatus,
} from "../sdk";

const ACTIVE_CLUSTER_ID = DEFAULT_ACTIVE_CLUSTER_ID;

type OpsRequester = {
  requestOp: (op: OpRequest) => void;
};

type TalosSnapshot = {
  status: TalosStatus | null;
  service: TalosServiceInfo | null;
  readiness: ProtocoreReadiness | null;
  expectedDigest: string;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: number | null;
};

const EMPTY_TALOS_SNAPSHOT: TalosSnapshot = {
  status: null,
  service: null,
  readiness: null,
  expectedDigest: "",
  loading: true,
  error: null,
  lastUpdatedAt: null,
};

const ALERT_RULES = [
  {
    id: "node-unreachable",
    label: "Connected node unreachable",
    source: "lyth_chainStatus",
    level: "critical",
  },
  {
    id: "protocore-unhealthy",
    label: "Protocore is not serving RPC",
    source: "Talos readiness",
    level: "critical",
  },
  {
    id: "release-digest",
    label: "Runtime digest does not match expected release",
    source: "lyth_runtimeProvenance",
    level: "critical",
  },
  {
    id: "bridge-paused",
    label: "Bridge route paused",
    source: "lyth_bridgeHealth",
    level: "warn",
  },
  {
    id: "oracle-indexer",
    label: "Oracle signer projection unavailable",
    source: "lyth_oracleSigners",
    level: "warn",
  },
] as const;

function catalogRequest(
  entry: OpCatalogEntry,
  overrides: Partial<OpRequest> = {},
): OpRequest {
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
    ...overrides,
  };
}

function requestCatalogOp(
  ops: OpsRequester,
  kind: OpKind,
  overrides: Partial<OpRequest> = {},
): void {
  const entry = OP_CATALOG.find((candidate) => candidate.kind === kind);
  if (!entry) return;
  ops.requestOp(catalogRequest(entry, overrides));
}

function CatalogButton({
  kind,
  children,
  variant = "ghost",
  size = "sm",
  overrides,
}: {
  kind: OpKind;
  children: ReactNode;
  variant?: "primary" | "ghost" | "danger";
  size?: "sm" | "md";
  overrides?: Partial<OpRequest>;
}) {
  const ops = useOps();
  const className = [
    "btn",
    variant === "primary"
      ? "btn--primary"
      : variant === "danger"
        ? "btn--danger"
        : "btn--ghost",
    size === "sm" ? "btn--sm" : "",
  ].filter(Boolean).join(" ");

  return (
    <button
      type="button"
      className={className}
      onClick={() => requestCatalogOp(ops, kind, overrides)}
    >
      {children}
    </button>
  );
}

function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="view-head">
      <div>
        <h1 className="view__title">{title}</h1>
        <p className="view__subtitle">{subtitle}</p>
      </div>
      {action ? <div className="view-head__actions">{action}</div> : null}
    </header>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone = "info",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "ok" | "warn" | "err" | "info" | "gold";
}) {
  return (
    <div className="card surface-stat">
      <span className={`halo halo--${tone}`}>
        <span className="dot" /> {label}
      </span>
      <strong>{value}</strong>
      {sub ? <small>{sub}</small> : null}
    </div>
  );
}

function Blocker({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <b style={{ color: "var(--fg-100)" }}>{title}</b>
      <div style={{ marginTop: 4 }}>{detail}</div>
    </div>
  );
}

function shortHex(value: string | null | undefined, head = 10, tail = 8): string {
  if (!value) return "-";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function formatCount(value: number | bigint | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return value.toLocaleString();
}

function formatReceiptTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function serviceTone(service: TalosServiceInfo | null): "ok" | "warn" | "err" | "info" {
  switch (service?.severity) {
    case "ok":
      return "ok";
    case "warn":
      return "warn";
    case "err":
      return "err";
    default:
      return "info";
  }
}

function useTalosSnapshot(): [TalosSnapshot, () => void] {
  const [snapshot, setSnapshot] = useState<TalosSnapshot>(EMPTY_TALOS_SNAPSHOT);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setSnapshot((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const [status, expectedDigest] = await Promise.all([
          talosStatus(),
          keychainGet(KEYCHAIN_ACCOUNTS.protocoreExpectedDigest),
        ]);
        let service: TalosServiceInfo | null = null;
        let readiness: ProtocoreReadiness | null = null;
        if (inTauri()) {
          [service, readiness] = await Promise.all([
            talosService("ext-protocore").then((result) => result.service),
            talosProtocoreReadiness(rpcEndpoint),
          ]);
        }
        if (!cancelled) {
          setSnapshot({
            status,
            service,
            readiness,
            expectedDigest: expectedDigest ?? "",
            loading: false,
            error: inTauri() ? null : "Talos control is available in the desktop runtime.",
            lastUpdatedAt: Date.now(),
          });
        }
      } catch (err) {
        if (!cancelled) {
          setSnapshot((prev) => ({
            ...prev,
            loading: false,
            error: (err as Error)?.message ?? String(err),
            lastUpdatedAt: Date.now(),
          }));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  return [snapshot, () => setRefreshTick((value) => value + 1)];
}

export function Marketplace() {
  const [tab, setTab] = useState<"operators" | "clusters">("operators");
  const [voteClusterId, setVoteClusterId] = useState<number>(ACTIVE_CLUSTER_ID);
  const providers = useProviderDirectory(0, null, 100);
  const clusters = useClusterDirectory(0, 100);
  const chain = useChainStatus();
  const rows = useMemo(
    () => [...(providers.data ?? [])].sort((a, b) => b.uptimeBps - a.uptimeBps),
    [providers.data],
  );
  const clusterRows = useMemo(() => clusters.data ?? [], [clusters.data]);
  const fallbackVoteClusterId = useMemo(
    () =>
      clusterRows.find((cluster) => cluster.clusterId === ACTIVE_CLUSTER_ID)?.clusterId
      ?? clusterRows[0]?.clusterId
      ?? ACTIVE_CLUSTER_ID,
    [clusterRows],
  );
  const selectedVoteCluster =
    clusterRows.find((cluster) => cluster.clusterId === voteClusterId)
    ?? clusterRows.find((cluster) => cluster.clusterId === fallbackVoteClusterId)
    ?? null;
  const targetVoteClusterId = selectedVoteCluster?.clusterId ?? fallbackVoteClusterId;
  const targetVoteClusterLabel = clusterLabel(targetVoteClusterId);

  useEffect(() => {
    if (clusterRows.length === 0) return;
    if (!clusterRows.some((cluster) => cluster.clusterId === voteClusterId)) {
      setVoteClusterId(fallbackVoteClusterId);
    }
  }, [clusterRows, fallbackVoteClusterId, voteClusterId]);

  return (
    <section className="view fade-in">
      <PageHeader
        title="Marketplace"
        subtitle="Live provider and cluster directories with CJ-1 request and vote preparation."
        action={<CatalogButton kind="operator-register" variant="primary" size="md">Register operator</CatalogButton>}
      />

      <div className="grid-3">
        <StatCard
          label="providers"
          value={providers.notExposed ? "blocked" : String(providers.data?.length ?? 0)}
          sub={providers.notExposed ? "lyth_listProviders unavailable" : "registry rows"}
          tone={providers.notExposed ? "warn" : "ok"}
        />
        <StatCard
          label="clusters"
          value={clusters.notExposed ? "blocked" : String(clusters.data?.length ?? 0)}
          sub={clusters.notExposed ? "lyth_clusterDirectory unavailable" : "directory rows"}
          tone={clusters.notExposed ? "warn" : "ok"}
        />
        <StatCard
          label="network"
          value={`chain ${chain.data?.chainId ?? "-"}`}
          sub={`${formatCount(chain.data?.operatorCount)} operators visible`}
          tone={chain.error ? "warn" : "info"}
        />
      </div>

      <div className="segmented">
        <button
          type="button"
          className={tab === "operators" ? "is-on" : ""}
          onClick={() => setTab("operators")}
        >
          Operators
        </button>
        <button
          type="button"
          className={tab === "clusters" ? "is-on" : ""}
          onClick={() => setTab("clusters")}
        >
          Clusters
        </button>
      </div>

      {tab === "operators" ? (
        <div className="card card--flush">
          <div className="card__head" style={{ padding: "16px 20px 0" }}>
            <div>
              <h3>Operator directory</h3>
              <div className="sub">Sorted by uptime from the node-registry provider list.</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12, flexWrap: "wrap" }}>
              {clusterRows.length > 0 ? (
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="stat__label">vote target</span>
                  <select
                    value={targetVoteClusterId}
                    onChange={(event) => setVoteClusterId(Number(event.currentTarget.value))}
                    style={{
                      minWidth: 150,
                      border: "1px solid var(--glass-stroke)",
                      borderRadius: 8,
                      background: "rgba(255, 255, 255, 0.04)",
                      padding: "7px 10px",
                      color: "var(--fg-100)",
                    }}
                  >
                    {clusterRows.map((cluster) => (
                      <option key={cluster.clusterId} value={cluster.clusterId}>
                        {clusterLabel(cluster.clusterId)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <span className={providers.notExposed ? "halo halo--warn" : "halo halo--ok"}>
                <span className="dot" /> {providers.notExposed ? "not exposed" : "live"}
              </span>
            </div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>peer</th>
                <th>endpoint</th>
                <th>capability mask</th>
                <th>uptime</th>
                <th>bond</th>
                <th>registered</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 25).map((provider) => (
                <tr key={provider.peerId}>
                  <td className="mono">{shortHex(provider.peerId)}</td>
                  <td className="mono" title={provider.endpoint}>{shortHex(provider.endpoint, 32, 10)}</td>
                  <td className="mono">0x{provider.capabilities.toString(16).padStart(4, "0")}</td>
                  <td className="mono">{bpsToPercent(provider.uptimeBps)}</td>
                  <td className="mono">{formatLythHex(provider.bond)}</td>
                  <td className="mono">{formatCount(provider.registeredAtBlock)}</td>
                  <td>
                    <CatalogButton
                      kind="cluster-vote-admit"
                      overrides={{
                        title: `Vote admit ${shortHex(provider.peerId)} to ${targetVoteClusterLabel}`,
                        fields: [
                          { key: "cluster", label: "Cluster", value: targetVoteClusterLabel },
                          { key: "candidate", label: "Candidate", value: shortHex(provider.peerId) },
                          { key: "flow", label: "Flow", value: "CJ-1 voteClusterAdmit; runtime preflight gated" },
                        ],
                        clusterVoteAdmitInput: {
                          clusterId: String(targetVoteClusterId),
                          operatorIdHex: provider.peerId,
                          voterPubkeyHex: "",
                        },
                      }}
                    >
                      Vote admit
                    </CatalogButton>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <Blocker
                      title={providers.notExposed ? "Provider directory is not exposed." : "No providers returned."}
                      detail={providers.error ?? "The connected endpoint has no provider rows to list."}
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card card--flush">
          <div className="card__head" style={{ padding: "16px 20px 0" }}>
            <div>
              <h3>Cluster directory</h3>
              <div className="sub">Operator seat discovery from the live cluster-directory RPC.</div>
            </div>
            <span className={clusters.notExposed ? "halo halo--warn" : "halo halo--ok"}>
              <span className="dot" /> {clusters.notExposed ? "not exposed" : "live"}
            </span>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>cluster</th>
                <th>quorum</th>
                <th>health</th>
                <th>regions</th>
                <th>active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(clusters.data ?? []).slice(0, 25).map((cluster) => (
                <tr key={cluster.clusterId}>
                  <td>{clusterLabel(cluster.clusterId)}</td>
                  <td className="mono">{cluster.threshold}-of-{cluster.size}</td>
                  <td>{cluster.aggregateHealth}</td>
                  <td>{cluster.regionDiversity?.join(", ") ?? "-"}</td>
                  <td>
                    <span className={cluster.active ? "halo halo--ok" : "halo halo--warn"}>
                      <span className="dot" /> {cluster.active ? "active" : "inactive"}
                    </span>
                  </td>
                  <td>
                    <CatalogButton
                      kind="cluster-request-join"
                      overrides={{
                        title: `Request join for ${clusterLabel(cluster.clusterId)}`,
                        fields: [
                          { key: "cluster", label: "Cluster", value: clusterLabel(cluster.clusterId) },
                          { key: "flow", label: "Flow", value: "CJ-1 requestClusterJoin; runtime preflight gated" },
                        ],
                        clusterJoinRequestInput: {
                          clusterId: String(cluster.clusterId),
                          operatorPubkeyHex: "",
                          bondLythoshi: "0",
                        },
                      }}
                    >
                      Request join
                    </CatalogButton>
                  </td>
                </tr>
              ))}
              {(clusters.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <Blocker
                      title={clusters.notExposed ? "Cluster directory is not exposed." : "No clusters returned."}
                      detail={clusters.error ?? "The connected endpoint has no cluster rows to list."}
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      <Blocker
        title="Self-service request-to-join is not live yet."
        detail="Desktop now prepares the requestClusterJoin and voteClusterAdmit drawer flows. Execution is still blocked until the CJ-1 cluster-vote precompile is live on the connected chain and the installed SDK package exposes the helpers."
      />
    </section>
  );
}

export function Services() {
  const [snapshot, refreshTalos] = useTalosSnapshot();
  const providers = useProviderDirectory(0, null, 100);
  const router = useOperatorRouterConfig();
  const prover = useProverMarketStatus();
  const oracle = useOracleSigners();
  const bridge = useBridgeHealth();
  const service = snapshot.service;
  const readiness = snapshot.readiness;
  const bridgePaused = bridge.data?.records.filter((record) => record.circuitBreaker.paused).length ?? 0;

  return (
    <section className="view fade-in">
      <PageHeader
        title="Services"
        subtitle="Node services and on-chain service surfaces backed by Talos and registry reads."
        action={<button type="button" className="btn btn--ghost" onClick={refreshTalos}>Refresh</button>}
      />

      <div className="grid-4">
        <StatCard
          label="ext-protocore"
          value={service?.displayState ?? (snapshot.loading ? "loading" : "unknown")}
          sub={service?.summary ?? snapshot.error ?? "Talos service snapshot"}
          tone={serviceTone(service)}
        />
        <StatCard
          label="rpc readiness"
          value={readiness?.displayState ?? "not checked"}
          sub={readiness?.summary ?? "Talos readiness probe"}
          tone={readiness?.severity === "ok" ? "ok" : readiness?.severity === "err" ? "err" : "warn"}
        />
        <StatCard
          label="providers"
          value={providers.notExposed ? "blocked" : String(providers.data?.length ?? 0)}
          sub="node-registry provider rows"
          tone={providers.notExposed ? "warn" : "ok"}
        />
        <StatCard
          label="router"
          value={router.data?.enabled ? "enabled" : router.notExposed ? "not exposed" : "disabled"}
          sub={router.data ? `max fee ${bpsToPercent(router.data.protocolMaxOperatorFeeBps)}` : "operator router config"}
          tone={router.data?.enabled ? "ok" : "warn"}
        />
      </div>

      <div className="card card--padded">
        <div className="card__head">
          <div>
            <h3>Monarch OS service control</h3>
            <div className="sub">Actions use the existing Talos operation path and produce local receipts.</div>
          </div>
          <span className={`halo halo--${snapshot.status?.reachable ? "ok" : "warn"}`}>
            <span className="dot" /> {snapshot.status?.reachable ? "Talos reachable" : "Talos not connected"}
          </span>
        </div>
        <div className="inline-actions">
          <CatalogButton kind="operator-start" variant="primary">Start service</CatalogButton>
          <CatalogButton kind="operator-restart">Restart service</CatalogButton>
          <CatalogButton kind="operator-stop" variant="danger">Stop service</CatalogButton>
          <CatalogButton kind="export-backup">Export offline backup</CatalogButton>
        </div>
      </div>

      <div className="grid-3">
        <ServiceSurface
          title="Prover market"
          status={prover.notExposed ? "not exposed" : prover.data?.status ?? "live"}
          detail={
            prover.data
              ? `${prover.data.openRequests ?? 0} open, ${prover.data.assignedRequests ?? 0} assigned, floor ${formatLythHex(prover.data.feeFloor)}`
              : prover.error ?? "lyth_proverMarketStatus"
          }
          tone={prover.notExposed || prover.data?.status ? "warn" : "ok"}
        />
        <ServiceSurface
          title="Oracle writers"
          status={oracle.notExposed ? "not exposed" : oracle.data?.status ?? "live"}
          detail={
            oracle.data
              ? `${oracle.data.writers.length} active writers`
              : oracle.error ?? "lyth_oracleSigners"
          }
          tone={oracle.notExposed || oracle.data?.status ? "warn" : "ok"}
        />
        <ServiceSurface
          title="Bridge relays"
          status={bridge.notExposed ? "not exposed" : `${bridge.data?.records.length ?? 0} routes`}
          detail={
            bridge.data
              ? `${bridgePaused} paused routes`
              : bridge.error ?? "lyth_bridgeHealth"
          }
          tone={bridgePaused > 0 ? "warn" : bridge.notExposed ? "warn" : "ok"}
        />
      </div>

      <Blocker
        title="Service-role enable and budget controls still need a chain/API surface."
        detail="The design includes role toggles, CPU caps, and rate limits. Desktop can display and control ext-protocore now; service-role registration must wait for an SDK-backed operation instead of writing local-only toggles."
      />
    </section>
  );
}

function ServiceSurface({
  title,
  status,
  detail,
  tone,
}: {
  title: string;
  status: string;
  detail: string;
  tone: "ok" | "warn" | "err" | "info";
}) {
  return (
    <div className="card">
      <div className="card__head">
        <div>
          <h3>{title}</h3>
          <div className="sub">{detail}</div>
        </div>
        <span className={`halo halo--${tone}`}>
          <span className="dot" /> {status}
        </span>
      </div>
    </div>
  );
}

function verifyBadge(check: ReceiptHashVerification) {
  switch (check.status) {
    case "match":
      return (
        <span className="halo halo--ok" title={`recomputed ${shortHex(check.computedHash)}`}>
          <span className="dot" /> hash verified
        </span>
      );
    case "mismatch":
      return (
        <span
          className="halo halo--err"
          title={`stored ${shortHex(check.storedHash)} ≠ recomputed ${shortHex(check.computedHash)}`}
        >
          <span className="dot" /> hash mismatch
        </span>
      );
    case "no-stored-hash":
      return (
        <span className="halo halo--warn" title="stored row carries no audit hash">
          <span className="dot" /> no stored hash
        </span>
      );
    default:
      return (
        <span className="halo halo--warn" title="receipt not found in storage">
          <span className="dot" /> not in storage
        </span>
      );
  }
}

export function Audit() {
  const ops = useOps();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "ok" | "error">("all");
  const [verifications, setVerifications] = useState<Record<string, ReceiptHashVerification>>({});
  const rows = ops.receipts.filter((receipt) => {
    if (status !== "all" && receipt.status !== status) return false;
    const haystack = `${receipt.kind} ${receipt.title} ${receipt.message} ${receipt.transport} ${receipt.txHash ?? ""} ${receipt.auditPayloadHash ?? ""}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  const copyAudit = () => {
    const payload = JSON.stringify(ops.receipts, null, 2);
    void navigator.clipboard?.writeText(payload);
  };

  return (
    <section className="view fade-in">
      <PageHeader
        title="Audit"
        subtitle="Local operation receipts with deterministic audit hashes. Cluster-wide audit stream is not exposed yet."
        action={<button type="button" className="btn btn--primary" onClick={copyAudit}>Copy JSON</button>}
      />

      <div className="grid-3">
        <StatCard label="receipts" value={String(ops.receipts.length)} sub="stored locally" tone="gold" />
        <StatCard
          label="audit-ready"
          value={String(ops.receipts.filter(isAuditReadyOperationReceipt).length)}
          sub="schema plus hash verified"
          tone="ok"
        />
        <StatCard
          label="errors"
          value={String(ops.receipts.filter((receipt) => receipt.status === "error").length)}
          sub="blocked or failed operations"
          tone={ops.receipts.some((receipt) => receipt.status === "error") ? "warn" : "ok"}
        />
      </div>

      <div className="card">
        <div className="audit-filters">
          <label>
            <span className="cap">search</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="kind, hash, tx, transport" />
          </label>
          <label>
            <span className="cap">status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value as "all" | "ok" | "error")}>
              <option value="all">all</option>
              <option value="ok">ok</option>
              <option value="error">error</option>
            </select>
          </label>
          <button type="button" className="btn btn--ghost btn--sm" onClick={ops.clearReceipts}>Clear local receipts</button>
        </div>
      </div>

      <div className="card card--flush">
        <table className="tbl">
          <thead>
            <tr>
              <th>when</th>
              <th>operation</th>
              <th>status</th>
              <th>transport</th>
              <th>receipt hash</th>
              <th>verify</th>
              <th>tx</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((receipt) => (
              <tr key={receipt.id}>
                <td className="mono">{formatReceiptTime(receipt.createdAt)}</td>
                <td>
                  <b>{receipt.title}</b>
                  <div className="stat__sub mono">{receipt.kind}</div>
                </td>
                <td>
                  <span className={receipt.status === "ok" ? "halo halo--ok" : "halo halo--err"}>
                    <span className="dot" /> {receipt.status}
                  </span>
                </td>
                <td className="mono">{receipt.transport}</td>
                <td className="mono">{shortHex(receipt.auditPayloadHash)}</td>
                <td>
                  <span className="lv-verify">
                    {verifications[receipt.id] ? verifyBadge(verifications[receipt.id]!) : null}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      title="Recompute the canonical SHA-256 from the stored payload and compare"
                      onClick={() =>
                        setVerifications((prev) => ({
                          ...prev,
                          [receipt.id]: verifyStoredReceiptHash(receipt.id),
                        }))
                      }
                    >
                      Re-verify
                    </button>
                  </span>
                </td>
                <td className="mono">{shortHex(receipt.txHash)}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <Blocker
                    title="No matching receipts."
                    detail="Run a Talos or chain operation through the drawer to populate the local audit trail."
                  />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Blocker
        title="Cluster audit stream is still a blocker."
        detail="The design includes cross-operator audit events and anchor proofs. The live app has local receipt hashes today; cluster-level audit RPC/indexer support is still needed."
      />
    </section>
  );
}

export function Governance() {
  const chain = useChainStatus();
  const indexer = useIndexerStatus();
  const capabilities = useOperatorCapabilities();
  const surfaces = Object.entries(capabilities.data?.surfaces ?? {})
    .filter(([name]) => /gov|proposal|memo|signal/i.test(name))
    .slice(0, 8);

  return (
    <section className="view fade-in">
      <PageHeader
        title="Governance"
        subtitle="Readiness for operator proposal and memo-signal flows."
      />

      <div className="grid-4">
        <StatCard label="chain" value={String(chain.data?.chainId ?? "-")} sub={`height ${formatCount(chain.data?.blockHeight)}`} tone={chain.error ? "warn" : "ok"} />
        <StatCard
          label="indexer"
          value={indexer.data ? `height ${formatCount(indexer.data.currentHeight)}` : indexer.notExposed ? "not exposed" : "unknown"}
          sub={indexer.data ? `schema ${indexer.data.schemaVersion}` : indexer.error ?? "lyth_indexerStatus"}
          tone={indexer.notExposed ? "warn" : indexer.data ? "ok" : "info"}
        />
        <StatCard label="capabilities" value={capabilities.notExposed ? "not exposed" : String(Object.keys(capabilities.data?.surfaces ?? {}).length)} sub="operator capability registry" tone={capabilities.notExposed ? "warn" : "ok"} />
        <StatCard label="binding txs" value="blocked" sub="no governance submit helper" tone="warn" />
      </div>

      <div className="card card--flush">
        <div className="card__head" style={{ padding: "16px 20px 0" }}>
          <div>
            <h3>Governance surfaces</h3>
            <div className="sub">Live capability rows matching governance, proposal, memo, or signal.</div>
          </div>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>surface</th>
              <th>status</th>
              <th>tracking</th>
            </tr>
          </thead>
          <tbody>
            {surfaces.map(([name, surface]) => (
              <tr key={name}>
                <td className="mono">{name}</td>
                <td>{surface.status}</td>
                <td className="mono">{surface.tracking ?? "-"}</td>
              </tr>
            ))}
            {surfaces.length === 0 ? (
              <tr>
                <td colSpan={3}>
                  <Blocker
                    title="No governance capability rows exposed."
                    detail={capabilities.notExposed ? "lyth_operatorCapabilities is not available on this endpoint." : "The chain and SDK do not yet expose a production governance proposal or memo-signal surface for Desktop."}
                  />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Blocker
        title="Prototype proposal voting is intentionally not wired."
        detail="The design page has proposal lists, memo votes, and treasury panels backed by design-only data. Desktop needs chain read APIs and a signed transaction helper before votes or proposal submissions can be real."
      />
    </section>
  );
}

export function Alerts() {
  const [snapshot] = useTalosSnapshot();
  const node = useNodeStatus();
  const bridge = useBridgeHealth();
  const oracle = useOracleSigners();
  const provenance = useRuntimeProvenance();
  const releaseStatus = releaseAttestationStatus({
    expectedDigest: snapshot.expectedDigest,
    service: snapshot.service,
    provenance: provenance.data,
    provenanceLoading: provenance.loading,
    provenanceError: provenance.error,
    provenanceNotExposed: provenance.notExposed,
    rpcEndpoint,
  });
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem("monarch.alertRules.v1") ?? "{}") as Record<string, boolean>;
      return parsed;
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("monarch.alertRules.v1", JSON.stringify(enabled));
    } catch {
      // Browser storage may be unavailable in locked-down webviews.
    }
  }, [enabled]);

  const activeStates: Record<string, boolean> = {
    "node-unreachable": !node.reachable,
    "protocore-unhealthy": snapshot.readiness !== null && snapshot.readiness.severity !== "ok",
    "release-digest": releaseStatus.className.includes("halo--err"),
    "bridge-paused": Boolean(bridge.data?.records.some((record) => record.circuitBreaker.paused)),
    "oracle-indexer": oracle.notExposed || oracle.data?.status === "indexer_unavailable",
  };
  const enabledCount = ALERT_RULES.filter((rule) => enabled[rule.id] ?? true).length;
  const firingCount = ALERT_RULES.filter((rule) => (enabled[rule.id] ?? true) && activeStates[rule.id]).length;

  return (
    <section className="view fade-in">
      <PageHeader
        title="Alerts"
        subtitle="Local alert rules evaluated against live chain, Talos, release, bridge, and oracle signals."
      />

      <div className="grid-3">
        <StatCard label="enabled rules" value={`${enabledCount}/${ALERT_RULES.length}`} sub="stored locally" tone="gold" />
        <StatCard label="firing now" value={String(firingCount)} sub="based on current reads" tone={firingCount > 0 ? "warn" : "ok"} />
        <StatCard label="delivery" value="in-app" sub="webhooks and OS notifications not implemented" tone="warn" />
      </div>

      <div className="card">
        <div className="alert-rule-list">
          {ALERT_RULES.map((rule) => {
            const isEnabled = enabled[rule.id] ?? true;
            const firing = isEnabled && activeStates[rule.id];
            return (
              <div className="alert-rule" key={rule.id}>
                <div>
                  <b>{rule.label}</b>
                  <small>{rule.source} · {rule.level}</small>
                </div>
                <span className={firing ? "halo halo--warn" : "halo halo--ok"}>
                  <span className="dot" /> {firing ? "firing" : "clear"}
                </span>
                <button
                  type="button"
                  className={isEnabled ? "btn btn--ghost btn--sm" : "btn btn--primary btn--sm"}
                  onClick={() => setEnabled((prev) => ({ ...prev, [rule.id]: !isEnabled }))}
                >
                  {isEnabled ? "Disable" : "Enable"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <Blocker
        title="Delivery channels are not wired yet."
        detail="The design includes webhook, email, and quiet-hour configuration. Desktop can evaluate local rules now; a notification bridge and signed channel configuration still need implementation."
      />
    </section>
  );
}

export function Wallets() {
  const navigate = useNavigate();
  // YOUR wallet — identity derived from the stored key, not member[0].
  const self = useSelfOperator();
  const operator = useOperatorInfo(self.operatorId);
  const operatorAddress =
    !operator.notExposed && operator.data?.address.startsWith("mono1")
      ? operator.data.address
      : null;
  const feeConfig = useOperatorFeeConfig(operatorAddress);
  const fundingAddress = operator.data?.address ?? self.address;

  return (
    <section className="view fade-in">
      <PageHeader
        title="Treasury"
        subtitle="YOUR operator account, bond, fee recipient, and wallet blockers."
        action={<CatalogButton kind="redelegate" variant="primary" size="md">Redelegate</CatalogButton>}
      />

      {self.status === "no-key" ? (
        <div className="card card--padded" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div>
            <b style={{ fontSize: 14 }}>No operator key stored</b>
            <p style={{ fontSize: 12, color: "var(--fg-400)", margin: "4px 0 0" }}>
              Treasury shows the wallet derived from YOUR operator key. Save or generate your
              24-word mnemonic to see your address, bond, and balance here.
            </p>
          </div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => navigate("/keys")}>
            Set up your operator key →
          </button>
        </div>
      ) : fundingAddress ? (
        <div className="card card--padded" style={{ display: "grid", gap: 6 }}>
          <div className="kv" style={{ gap: 12 }}>
            <span className="kv__k">Your funding address</span>
            <span className="mono" style={{ fontSize: 12, overflowWrap: "anywhere", textAlign: "right", minWidth: 0 }}>
              {fundingAddress}
              <button
                type="button"
                className="copy-btn"
                style={{ marginLeft: 8 }}
                onClick={() => void navigator.clipboard?.writeText(fundingAddress)}
                aria-label="Copy funding address"
              >
                CP
              </button>
            </span>
          </div>
          <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
            Send LYTH here to fund the 5,000 LYTH registration <Term k="bond">bond</Term> and
            transaction fees. The bond is paid from this address when you register.
          </span>
        </div>
      ) : null}

      <div className="grid-3">
        <StatCard label="your account" value={shortHex(fundingAddress, 12, 10)} sub={self.registered === true ? "registered operator" : self.registered === false ? "not registered yet" : "chain address"} tone={fundingAddress ? "ok" : "warn"} />
        <StatCard label="bonded stake" value={operator.data?.bondedStake ?? "-"} sub="lythoshi from registry" tone="gold" />
        <StatCard
          label="fee config"
          value={feeConfig.data ? bpsToPercent(feeConfig.data.feeBps) : feeConfig.notExposed ? "not exposed" : "loading"}
          sub={feeConfig.data?.recipient ?? feeConfig.error ?? "operator router fee recipient"}
          tone={feeConfig.data ? "ok" : "warn"}
        />
      </div>

      <div className="card">
        <div className="card__head">
          <div>
            <h3>Spendable wallet actions</h3>
            <div className="sub">The operator key signs registry and delegation transactions today.</div>
          </div>
        </div>
        <div className="inline-actions">
          <CatalogButton kind="operator-register" variant="primary">Register operator</CatalogButton>
          <CatalogButton kind="redelegate">Redelegate stake</CatalogButton>
          <button type="button" className="btn btn--ghost btn--sm" disabled title="Wallet transfer helper is not implemented">Send LYTH</button>
          <button type="button" className="btn btn--ghost btn--sm" disabled title="Reward claim helper is not implemented">Claim rewards</button>
        </div>
      </div>

      <Blocker
        title="Full wallet send, receive, and reward claim flows are not implemented in Monarch Desktop."
        detail="The design's wallet page overlaps the browser wallet. Desktop currently supports operator registry, redelegation, and fee-read surfaces; generic transfers and reward claims need wallet SDK support before they should appear as executable actions."
      />
    </section>
  );
}

export function SetupOperator() {
  const navigate = useNavigate();
  const node = useNodeStatus();
  const [snapshot, refreshTalos] = useTalosSnapshot();
  // Steps 3-4 are PROBED, not hardcoded: keychain presence and the live
  // on-chain registration row for the derived operator id.
  const presence = useKeychainPresence();
  const self = useSelfOperator();
  const keyStatus: "ok" | "warn" | "info" = presence.checking
    ? "info"
    : presence.hasOperatorKey
      ? "ok"
      : "warn";
  const registerStatus: "ok" | "warn" | "info" | "gold" =
    self.registered === true
      ? "ok"
      : self.status === "no-key" || self.registered === false
        ? "gold"
        : "info";

  return (
    <section className="view fade-in">
      <PageHeader
        title="Set up operator"
        subtitle="Connect to a node, store a PQM-1 key, and submit the node-registry registration. The full guided journey lives on the Welcome page."
        action={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => navigate("/welcome")}>Open checklist</button>
            <button type="button" className="btn btn--ghost" onClick={refreshTalos}>Refresh node</button>
          </>
        }
      />

      <div className="setup-steps">
        <SetupStep n={1} title="Connect node" status={node.reachable ? "ok" : "warn"} detail={`${node.endpoint} · chain ${node.chainId ?? "-"}`} />
        <SetupStep n={2} title="Verify Monarch OS" status={snapshot.readiness?.severity === "ok" ? "ok" : "warn"} detail={snapshot.readiness?.summary ?? snapshot.error ?? "Talos readiness not confirmed"} />
        <SetupStep
          n={3}
          title="Store PQM-1 key"
          status={keyStatus}
          detail={
            presence.checking
              ? "checking the OS keychain…"
              : presence.hasOperatorKey
                ? "operator mnemonic found in the OS keychain"
                : "no key stored — save or generate one in the panel below"
          }
        />
        <SetupStep
          n={4}
          title="Register on-chain"
          status={registerStatus}
          detail={
            self.registered === true
              ? "registration row found on-chain — done"
              : self.status === "no-key"
                ? "needs your operator key first"
                : self.registered === false
                  ? "not registered yet — submit the register tx below"
                  : "registration lookup unavailable on this endpoint"
          }
        />
      </div>

      <div className="grid-2">
        <OperatorKeySettings />
        <div className="card card--padded">
          <div className="card__head">
            <div>
              <h3>Registration</h3>
              <div className="sub">Publishes endpoint, capabilities, bond, and ML-DSA consensus material.</div>
            </div>
          </div>
          <div className="inline-actions">
            <CatalogButton kind="operator-register" variant="primary">Open register form</CatalogButton>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => navigate("/marketplace")}>Browse marketplace</button>
          </div>
          <div className="empty-state" style={{ marginTop: 14 }}>
            The register form derives the ML-DSA pubkey and possession proof from the stored PQM-1 mnemonic at signing time.
          </div>
        </div>
      </div>
    </section>
  );
}

function SetupStep({
  n,
  title,
  detail,
  status,
}: {
  n: number;
  title: string;
  detail: string;
  status: "ok" | "warn" | "err" | "info" | "gold";
}) {
  return (
    <div className="card setup-step">
      <span className={`halo halo--${status}`}>{n}</span>
      <b>{title}</b>
      <small>{detail}</small>
    </div>
  );
}

export function SetupCluster() {
  const navigate = useNavigate();
  const cluster = useClusterStatus(ACTIVE_CLUSTER_ID);
  const directory = useClusterDirectory(0, 100);
  const providers = useProviderDirectory(0, null, 100);
  const activeClusterLabel = clusterLabel(cluster.data?.id ?? ACTIVE_CLUSTER_ID);

  return (
    <section className="view fade-in">
      <PageHeader
        title="Set up cluster"
        subtitle="Join an existing cluster or form a new one through policy-gated admission."
        action={<button type="button" className="btn btn--ghost" onClick={() => navigate("/marketplace")}>Open marketplace</button>}
      />

      <div className="grid-4">
        <StatCard label="active cluster" value={activeClusterLabel} sub={cluster.data ? `${cluster.data.threshold}-of-${cluster.data.size}` : "not joined"} tone={cluster.data ? "ok" : "warn"} />
        <StatCard label="directory" value={String(directory.data?.length ?? 0)} sub="clusters visible" tone={directory.notExposed ? "warn" : "ok"} />
        <StatCard label="providers" value={String(providers.data?.length ?? 0)} sub="operators visible" tone={providers.notExposed ? "warn" : "ok"} />
        <StatCard label="join policy" value="guarded" sub="CJ-1 runtime gated" tone="warn" />
      </div>

      <div className="grid-2">
        <div className="card card--padded">
          <div className="card__head">
            <div>
              <h3>Join existing <Term k="cluster">cluster</Term></h3>
              <div className="sub">
                Prepare and preflight a <Term k="CJ-1">CJ-1</Term> request; compatible runtimes can sign and submit.
              </div>
            </div>
          </div>
          <div className="inline-actions">
            <CatalogButton
              kind="cluster-request-join"
              variant="primary"
              overrides={{
                clusterJoinRequestInput: {
                  clusterId: String(ACTIVE_CLUSTER_ID),
                  operatorPubkeyHex: "",
                  bondLythoshi: "0",
                },
              }}
            >
              Request join
            </CatalogButton>
            <CatalogButton kind="rotate-keys">Submit DKG attestation</CatalogButton>
          </div>
        </div>

        <div className="card card--padded">
          <div className="card__head">
            <div>
              <h3>Form new <Term k="cluster">cluster</Term></h3>
              <div className="sub">
                Gather 10 operators in the ceremony room, or prepare the 7 active + 3 standby{" "}
                <Term k="seat">seat</Term> roster manually.
              </div>
            </div>
          </div>
          <div className="inline-actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => navigate("/ceremony")}
            >
              Open ceremony room
            </button>
            <CatalogButton
              kind="cluster-form"
              overrides={{
                clusterFormInput: {
                  activePubkeysHex: "",
                  standbyPubkeysHex: "",
                  signaturesHex: "",
                },
              }}
            >
              Prepare roster manually
            </CatalogButton>
            <CatalogButton kind="rotate-keys">Submit DKG attestation</CatalogButton>
          </div>
          <Blocker
            title="Compatible runtime required."
            detail="Desktop validates the proposed roster and consent signatures, preflights formCluster, and signs only when the connected runtime accepts the call."
          />
        </div>
      </div>
    </section>
  );
}

export function Attestation() {
  const [snapshot, refreshTalos] = useTalosSnapshot();
  const provenance = useRuntimeProvenance();
  const releaseStatus = releaseAttestationStatus({
    expectedDigest: snapshot.expectedDigest,
    service: snapshot.service,
    provenance: provenance.data,
    provenanceLoading: provenance.loading,
    provenanceError: provenance.error,
    provenanceNotExposed: provenance.notExposed,
    rpcEndpoint,
  });
  const readiness = desktopReleaseReadiness({
    talosStatus: snapshot.status,
    talosConfig: null,
    protocore: snapshot.readiness,
    releaseAttestation: releaseStatus,
    operationReceipts: [],
    chat: null,
  });

  return (
    <section className="view fade-in">
      <PageHeader
        title="Attestation and OTA"
        subtitle="Release digest checks, runtime provenance, Talos readiness, and OS upgrade operations."
        action={<button type="button" className="btn btn--ghost" onClick={refreshTalos}>Refresh</button>}
      />

      <div className="grid-3">
        <StatCard label="runtime digest" value={releaseStatus.text} sub={releaseStatus.title} tone={releaseStatus.className.includes("halo--ok") ? "ok" : releaseStatus.className.includes("halo--err") ? "err" : "warn"} />
        <StatCard label="protocore" value={snapshot.readiness?.displayState ?? "not checked"} sub={snapshot.readiness?.summary ?? snapshot.error ?? "Talos readiness"} tone={snapshot.readiness?.severity === "ok" ? "ok" : "warn"} />
        <StatCard label="release gates" value={readiness.ok ? "ready" : `${readiness.blockers.length} blockers`} sub="desktop release readiness" tone={readiness.ok ? "ok" : "warn"} />
      </div>

      <div className="card card--padded">
        <div className="card__head">
          <div>
            <h3>OTA operations</h3>
            <div className="sub">Talos upgrade and rollback use the shared operation drawer.</div>
          </div>
        </div>
        <div className="inline-actions">
          <CatalogButton kind="ota-apply" variant="primary">Apply OS upgrade</CatalogButton>
          <CatalogButton kind="ota-rollback" variant="danger">Rollback OS image</CatalogButton>
        </div>
      </div>

      <div className="card card--flush">
        <table className="tbl">
          <thead>
            <tr>
              <th>gate</th>
              <th>status</th>
              <th>summary</th>
            </tr>
          </thead>
          <tbody>
            {readiness.gates.map((gate) => (
              <tr key={gate.id}>
                <td className="mono">{gate.id}</td>
                <td>
                  <span className={gate.ok ? "halo halo--ok" : "halo halo--warn"}>
                    <span className="dot" /> {gate.ok ? "ok" : "blocked"}
                  </span>
                </td>
                <td>{gate.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Keys() {
  const presence = useKeychainPresence();
  return (
    <section className="view fade-in">
      <PageHeader
        title="Keys"
        subtitle="PQM-1 operator key generation and storage, DKG attestation, backups, and emergency rotation entry points."
      />

      <div className="grid-2">
        <OperatorKeySettings />
        <div className="card card--padded">
          <div className="card__head">
            <div>
              <h3>Key operations</h3>
              <div className="sub">All executable actions route through the shared drawer.</div>
            </div>
          </div>
          <div className="stack-actions">
            <CatalogButton kind="rotate-keys" variant="primary">Rotate signing share</CatalogButton>
            <CatalogButton kind="export-backup">Export offline backup</CatalogButton>
            {presence.hasFoundationKey ? (
              <CatalogButton kind="emergency-key-rotation" variant="danger">Emergency key rotation</CatalogButton>
            ) : (
              <div className="empty-state" style={{ marginTop: 4 }}>
                Emergency key rotation is foundation-only and hidden — no foundation signer is
                stored on this install.
              </div>
            )}
          </div>
        </div>
      </div>

      <Blocker
        title="Passkey enrollment and revocation are not wired in this app."
        detail="The design includes local passkey administration. Desktop currently stores PQM-1 mnemonics in the OS keychain and uses chain/Talos operations; passkey lifecycle needs a dedicated runtime bridge."
      />
    </section>
  );
}

export function Recovery() {
  // YOUR operator id — derived from the stored key, not member[0].
  const self = useSelfOperator();
  const operatorId = self.operatorId;
  const presence = useKeychainPresence();
  const showFoundation = presence.hasFoundationKey;

  return (
    <section className="view fade-in">
      <PageHeader
        title="Recovery"
        subtitle="Operator restore, emergency rotation, offline backup, and incident controls."
      />

      <div className="grid-3">
        <StatCard label="your operator" value={shortHex(operatorId)} sub={self.clusterId !== null ? clusterLabel(self.clusterId) : self.status === "no-key" ? "no operator key stored" : "no cluster seat"} tone={operatorId ? "ok" : "warn"} />
        <StatCard label="restore path" value="foundation-gated" sub="removal-recovery executor" tone="warn" />
        <StatCard label="peer-vouched path" value="blocked" sub="cluster-vote API needed" tone="warn" />
      </div>

      <div className="grid-2">
        <div className="card card--padded">
          <div className="card__head">
            <div>
              <h3>Available recovery actions</h3>
              <div className="sub">These operations have drawer and SDK/Talos paths today.</div>
            </div>
          </div>
          <div className="stack-actions">
            {showFoundation ? (
              <CatalogButton
                kind="operator-restore"
                variant="primary"
                overrides={operatorId ? { restoreInput: { peerIdHex: operatorId } } : undefined}
              >
                Restore operator
              </CatalogButton>
            ) : null}
            <CatalogButton kind="export-backup">Export offline backup</CatalogButton>
            {showFoundation ? (
              <>
                <CatalogButton kind="freeze-admission" variant="danger">Freeze admission</CatalogButton>
                <CatalogButton kind="emergency-key-rotation" variant="danger">Emergency key rotation</CatalogButton>
              </>
            ) : (
              <div className="empty-state" style={{ marginTop: 4 }}>
                Foundation-only actions (restore, freeze admission, emergency key rotation) are
                hidden because no foundation signer is stored on this install — ordinary
                operators never need them.
              </div>
            )}
          </div>
        </div>
        <div className="card card--padded">
          <div className="card__head">
            <div>
              <h3>Preferred future path</h3>
              <div className="sub">Cluster-vouched recovery without foundation intervention.</div>
            </div>
          </div>
          <Blocker
            title="Peer-vouched recovery is not executable yet."
            detail="The policy flow needs cluster votes, threshold ACK collection, and a chain helper that applies the approved recovery change. The UI should stay blocked until those exist."
          />
        </div>
      </div>
    </section>
  );
}
