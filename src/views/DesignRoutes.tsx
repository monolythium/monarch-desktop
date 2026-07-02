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
  NODE_REGISTRY_MIN_SELF_BOND_LYTHOSHI,
  protocoreUpdateStatus,
  releaseAttestationStatus,
  rpcEndpoint,
  useInstallerImageExists,
  useLatestProtocoreRelease,
  talosProtocoreReadiness,
  talosService,
  talosStatus,
  useBridgeHealth,
  useChainStatus,
  useClusterDirectory,
  useClusterStatus,
  useIndexerStatus,
  useNodeStatus,
  useOpenSeats,
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
import type { OpenSeatView, RuntimeProvenanceResponse } from "@monolythium/core-sdk";
import { shortAddr, toMono1 } from "../sdk/address";
import { isValidUpgradeImage } from "../ops/OtaApplyForm";

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
    source: "chain status",
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
    source: "runtime provenance",
    level: "critical",
  },
  {
    id: "bridge-paused",
    label: "Bridge route paused",
    source: "bridge health",
    level: "warn",
  },
  {
    id: "oracle-indexer",
    label: "Oracle signer projection unavailable",
    source: "oracle signer set",
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
  const [tab, setTab] = useState<"operators" | "clusters" | "seats">("operators");
  const [voteClusterId, setVoteClusterId] = useState<number>(ACTIVE_CLUSTER_ID);
  const providers = useProviderDirectory(0, null, 100);
  const clusters = useClusterDirectory(0, 100);
  const chain = useChainStatus();
  const openSeats = useOpenSeats(chain.data?.blockHeight ?? null);
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
        <button
          type="button"
          className={tab === "seats" ? "is-on" : ""}
          onClick={() => setTab("seats")}
        >
          Open seats
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
                <span className="dot" /> {providers.notExposed ? "unavailable" : "live"}
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
                      title={providers.notExposed ? "Provider directory is unavailable from this endpoint." : "No providers returned."}
                      detail={providers.error ?? "The connected endpoint has no provider rows to list."}
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : tab === "clusters" ? (
        <div className="card card--flush">
          <div className="card__head" style={{ padding: "16px 20px 0" }}>
            <div>
              <h3>Cluster directory</h3>
              <div className="sub">Operator seat discovery from the live cluster-directory RPC.</div>
            </div>
            <span className={clusters.notExposed ? "halo halo--warn" : "halo halo--ok"}>
              <span className="dot" /> {clusters.notExposed ? "unavailable" : "live"}
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
                      title={clusters.notExposed ? "Cluster directory is unavailable from this endpoint." : "No clusters returned."}
                      detail={clusters.error ?? "The connected endpoint has no cluster rows to list."}
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
        <OpenSeatsPanel seats={openSeats} />
      )}

      <div className="card card--padded" style={{ display: "grid", gap: 6 }}>
        <div className="card__head">
          <div>
            <h3>Self-service cluster admission is live</h3>
            <div className="sub">
              The open-seat primitive is live on the connected testnet. Apply to an advertised seat
              and the cluster's operators vote 7-of-10 to admit you; the CJ-1 request and admit-vote
              drawer flows are also wired and sign with your operator key.
            </div>
          </div>
          <span className="halo halo--ok">
            <span className="dot" /> live
          </span>
        </div>
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Live seat discovery is event/indexer-backed — on a node with the indexer disabled the Open
          seats list is unavailable, but you can still apply by entering a cluster and seat id
          directly. Applying escrows your full self-bond (5,000+ LYTH), refundable until admission.
        </span>
      </div>
    </section>
  );
}

const SEAT_CAPABILITY_LABELS: { bit: number; label: string }[] = [
  { bit: 0x0001, label: "RPC" },
  { bit: 0x0002, label: "State sync" },
  { bit: 0x0004, label: "Snapshots" },
  { bit: 0x0008, label: "Archival" },
  { bit: 0x0010, label: "Prover" },
  { bit: 0x0020, label: "Bridge" },
  { bit: 0x0040, label: "Oracle" },
];

function seatCapabilityLabel(mask: number): string {
  const labels = SEAT_CAPABILITY_LABELS.filter((cap) => (mask & cap.bit) !== 0).map(
    (cap) => cap.label,
  );
  return labels.length > 0 ? labels.join(", ") : "any tier";
}

function seatStatusTone(status: OpenSeatView["status"]): "ok" | "warn" | "info" {
  switch (status) {
    case "open":
      return "ok";
    case "filled":
      return "info";
    default:
      return "warn";
  }
}

function bondLabel(lythoshi: bigint): string {
  return `${formatLythHex(`0x${lythoshi.toString(16)}`)} LYTH`;
}

// The self-bond escrowed at apply is max(self-bond floor, the seat's advertised
// minBond) — applyForSeat reverts SeatBondTooLow below this.
function seatSelfBond(minBondLythoshi: bigint): bigint {
  return minBondLythoshi > NODE_REGISTRY_MIN_SELF_BOND_LYTHOSHI
    ? minBondLythoshi
    : NODE_REGISTRY_MIN_SELF_BOND_LYTHOSHI;
}

function OpenSeatsPanel({ seats }: { seats: ReturnType<typeof useOpenSeats> }) {
  const rows = useMemo(() => seats.data ?? [], [seats.data]);
  const availableCount = rows.filter(
    (seat) => seat.status === "open" && seat.filledCount < seat.seatCount,
  ).length;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="card card--padded">
        <div className="card__head">
          <div>
            <h3>Earn a seat in a cluster</h3>
            <div className="sub">
              Apply to an advertised open seat and the cluster votes 7-of-10 to admit you. Applying
              escrows your full self-bond (5,000+ LYTH) up front, refundable if you withdraw before
              admission; on admission the chain keeps the already-escrowed bond.
            </div>
          </div>
          <span className={availableCount > 0 ? "halo halo--ok" : "halo halo--warn"}>
            <span className="dot" /> {availableCount} open
          </span>
        </div>
        <div className="inline-actions">
          <CatalogButton kind="seat-apply" variant="primary">
            Apply to a seat
          </CatalogButton>
          <CatalogButton kind="seat-withdraw-application">Withdraw my application</CatalogButton>
          <CatalogButton kind="seat-vote-admit">Vote to admit an applicant</CatalogButton>
        </div>
        <div className="inline-actions" style={{ marginTop: 8 }}>
          <CatalogButton kind="seat-advertise">Advertise a seat</CatalogButton>
          <CatalogButton kind="seat-close">Close a seat</CatalogButton>
        </div>
        <div className="empty-state" style={{ marginTop: 12 }}>
          Already know the cluster and seat id? Use “Apply to a seat” and enter them directly — live
          seat discovery below depends on the connected node exposing the seat-event index. Applied
          already? “Withdraw my application” returns your escrowed self-bond before admission. Running
          a cluster? “Advertise a seat” to publish a vacancy, “Close a seat” to take one down.
        </div>
      </div>

      <div className="card card--flush">
        <div className="card__head" style={{ padding: "16px 20px 0" }}>
          <div>
            <h3>Advertised open seats</h3>
            <div className="sub">
              Live vacancies projected from the cluster seat-event history (event/indexer backed).
            </div>
          </div>
          <span className={seats.notExposed ? "halo halo--warn" : "halo halo--ok"}>
            <span className="dot" /> {seats.notExposed ? "unavailable" : "live"}
          </span>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>cluster</th>
              <th>seat</th>
              <th>type</th>
              <th>service tier</th>
              <th>self-bond</th>
              <th>filled</th>
              <th>status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((seat) => {
              const available = seat.status === "open" && seat.filledCount < seat.seatCount;
              return (
                <tr key={`${seat.clusterId}:${seat.seatId}`}>
                  <td>{clusterLabel(seat.clusterId)}</td>
                  <td className="mono">#{seat.seatId}</td>
                  <td>
                    <span className={`pill-status ${seat.kind === "active" ? "pill-status--gold" : "pill-status--info"}`}>
                      {seat.kind}
                    </span>
                  </td>
                  <td className="mono" title={`capability mask 0x${seat.capabilityMask.toString(16).padStart(4, "0")}`}>
                    {seatCapabilityLabel(seat.capabilityMask)}
                  </td>
                  <td className="mono">{bondLabel(seat.minBondLythoshi)}</td>
                  <td className="mono">{seat.filledCount}/{seat.seatCount}</td>
                  <td>
                    <span className={`halo halo--${seatStatusTone(seat.status)}`}>
                      <span className="dot" /> {seat.status}
                    </span>
                  </td>
                  <td>
                    <CatalogButton
                      kind="seat-apply"
                      overrides={{
                        title: `Apply for seat #${seat.seatId} in ${clusterLabel(seat.clusterId)}`,
                        fields: [
                          { key: "cluster", label: "Cluster", value: clusterLabel(seat.clusterId) },
                          { key: "seat", label: "Seat", value: `#${seat.seatId} · ${seat.kind}` },
                          { key: "tier", label: "Service tier", value: seatCapabilityLabel(seat.capabilityMask) },
                          { key: "bond", label: "Self-bond (escrowed now)", value: bondLabel(seatSelfBond(seat.minBondLythoshi)) },
                          { key: "flow", label: "Flow", value: "applyForSeat; full self-bond escrowed now, 7-of-10 admit" },
                        ],
                        seatApplyInput: {
                          clusterId: String(seat.clusterId),
                          seatId: String(seat.seatId),
                          operatorPubkeyHex: "",
                          selfBondLythoshi: seatSelfBond(seat.minBondLythoshi).toString(),
                        },
                      }}
                    >
                      {available ? "Apply" : "View"}
                    </CatalogButton>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <Blocker
                    title={
                      seats.notExposed
                        ? "Live seat discovery is unavailable from this endpoint."
                        : "No open seats advertised in the scanned window."
                    }
                    detail={
                      seats.notExposed
                        ? "Open-seat discovery is event/indexer-backed; the connected node does not expose the seat-event index (the public testnet profile runs with the indexer disabled). You can still apply by entering a cluster and seat id directly above."
                        : seats.error ?? "No cluster has an advertised vacancy in the recent block window. You can still apply directly if you know the cluster and seat id."
                    }
                  />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
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
          value={router.data?.enabled ? "enabled" : router.notExposed ? "unavailable" : "disabled"}
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
          status={prover.data ? (prover.data.status ?? "live") : prover.loading ? "loading" : "unavailable"}
          detail={
            prover.data
              ? `${prover.data.openRequests ?? 0} open, ${prover.data.assignedRequests ?? 0} assigned, floor ${formatLythHex(prover.data.feeFloor)}`
              : prover.error ?? "market data unavailable"
          }
          tone={prover.data && !prover.data.status ? "ok" : "warn"}
        />
        <ServiceSurface
          title="Oracle writers"
          status={oracle.data ? (oracle.data.status ?? "live") : oracle.loading ? "loading" : "unavailable"}
          detail={
            oracle.data
              ? `${oracle.data.writers.length} active writers`
              : oracle.error ?? "writer set unavailable"
          }
          tone={oracle.data && !oracle.data.status ? "ok" : "warn"}
        />
        <ServiceSurface
          title="Bridge relays"
          status={bridge.data ? `${bridge.data.records.length} routes` : bridge.loading ? "loading" : "unavailable"}
          detail={
            bridge.data
              ? `${bridgePaused} paused routes`
              : bridge.error ?? "relay data unavailable"
          }
          tone={bridge.data && bridgePaused === 0 ? "ok" : "warn"}
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
        subtitle="Local operation receipts with deterministic audit hashes. Cluster-wide audit history is not available from this endpoint yet."
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
  // A disabled indexer still returns a body ({enabled:false,status:"disabled"});
  // the narrow SDK type omits those runtime fields, so read them via a cast and
  // render "disabled" (warn) instead of a green "height 0".
  const indexerRuntime = indexer.data as
    | { enabled?: boolean; status?: string; disabledReason?: string }
    | null;
  const indexerDisabled =
    !!indexerRuntime && (indexerRuntime.enabled === false || indexerRuntime.status === "disabled");
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
          value={indexerDisabled ? "disabled" : indexer.data ? `height ${formatCount(indexer.data.currentHeight)}` : indexer.notExposed ? "unavailable" : "unknown"}
          sub={indexerDisabled ? (indexerRuntime?.disabledReason && indexerRuntime.disabledReason !== "indexer_disabled" ? indexerRuntime.disabledReason.replace(/_/g, " ") : "indexer disabled") : indexer.data ? `schema ${indexer.data.schemaVersion}` : indexer.error ?? "lyth_indexerStatus"}
          tone={indexerDisabled || indexer.notExposed ? "warn" : indexer.data ? "ok" : "info"}
        />
        <StatCard label="capabilities" value={capabilities.notExposed ? "unavailable" : String(Object.keys(capabilities.data?.surfaces ?? {}).length)} sub="operator capability registry" tone={capabilities.notExposed ? "warn" : "ok"} />
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
                    title="No governance capability rows available."
                    detail={capabilities.notExposed ? "Governance capability data is not available from this endpoint." : "This endpoint does not provide proposal or memo-signal rows for Desktop yet."}
                  />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Blocker
        title="Proposal voting is not available in this build."
        detail="Desktop needs chain read APIs and a signed transaction helper before votes or proposal submissions can run."
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
        title="Delivery channels are not available in this build."
        detail="Desktop can evaluate local rules now; webhook, email, and OS notification delivery need a signed channel configuration before they can run."
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
  // The send-to-able form is bech32m mono1…; the raw 0x hex is EVM-format
  // only and is rejected by send paths, so the receive address shown to
  // humans must be the mono1 form (the hex is kept as a secondary detail).
  const fundingMono1 = toMono1(fundingAddress);
  const fundingHex = fundingAddress && fundingAddress.startsWith("0x") ? fundingAddress : null;

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
      ) : fundingMono1 ? (
        <div className="card card--padded" style={{ display: "grid", gap: 6 }}>
          <div className="kv" style={{ gap: 12 }}>
            <span className="kv__k">Your funding address</span>
            <span className="mono" style={{ fontSize: 12, overflowWrap: "anywhere", textAlign: "right", minWidth: 0 }}>
              {fundingMono1}
              <button
                type="button"
                className="copy-btn"
                style={{ marginLeft: 8 }}
                onClick={() => void navigator.clipboard?.writeText(fundingMono1)}
                aria-label="Copy funding address"
              >
                CP
              </button>
            </span>
          </div>
          {fundingHex ? (
            <div className="kv" style={{ gap: 12 }}>
              <span className="kv__k" style={{ color: "var(--fg-500)" }}>EVM-format</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-500)", overflowWrap: "anywhere", textAlign: "right", minWidth: 0 }}>
                {fundingHex}
              </span>
            </div>
          ) : null}
          <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
            Send LYTH to the <b>mono1…</b> address above to fund the 5,000 LYTH registration{" "}
            <Term k="bond">bond</Term> and transaction fees — the chain rejects the raw 0x form. The
            bond is paid from this address when you register.
          </span>
        </div>
      ) : null}

      <div className="grid-3">
        <StatCard label="your account" value={shortAddr(fundingMono1, 12, 10)} sub={self.registered === true ? "registered operator" : self.registered === false ? "not registered yet" : "chain address"} tone={fundingMono1 ? "ok" : "warn"} />
        <StatCard label="bonded stake" value={operator.data?.bondedStake ?? "-"} sub="lythoshi from registry" tone="gold" />
        <StatCard
          label="fee config"
          value={feeConfig.data ? bpsToPercent(feeConfig.data.feeBps) : feeConfig.notExposed ? "unavailable" : "loading"}
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
        subtitle="Connect to a node, store a operator key, and submit the node-registry registration. The full guided journey lives on the Welcome page."
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
          title="Store operator key"
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
            <CatalogButton kind="operator-register" variant="primary">Open registration form</CatalogButton>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => navigate("/marketplace")}>Browse marketplace</button>
          </div>
          <div className="empty-state" style={{ marginTop: 14 }}>
            The register form derives the ML-DSA pubkey and possession proof from the stored recovery phrase at signing time.
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
            </CatalogButton>          </div>
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
            </CatalogButton>          </div>
          <Blocker
            title="Compatible runtime required."
            detail="Desktop validates the proposed roster and consent signatures, preflights formCluster, and signs only when the connected runtime accepts the call."
          />
        </div>
      </div>
    </section>
  );
}

function formatReleaseDate(value: string): string {
  if (!value) return "unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

const CHANGELOG_PREVIEW_LINES = 6;

// The git commit is the only reliable cross-release identity, compared on its
// first 12 chars (see protocoreRelease.ts). Show exactly that prefix.
function shortCommit12(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "—";
  return trimmed.slice(0, 12);
}

function ReleaseChangelog({ notes, htmlUrl }: { notes: string; htmlUrl: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(
    () => notes.split(/\r?\n/).filter((line) => line.length > 0),
    [notes],
  );
  const hasMore = lines.length > CHANGELOG_PREVIEW_LINES;
  const shown = expanded ? lines : lines.slice(0, CHANGELOG_PREVIEW_LINES);

  return (
    <div style={{ marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 6 }}>changelog</div>
      {shown.length > 0 ? (
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 11.5,
            lineHeight: 1.5,
            color: "var(--fg-300)",
            fontFamily: "var(--font-mono, monospace)",
          }}
        >
          {shown.join("\n")}
        </pre>
      ) : (
        <div style={{ fontSize: 11.5, color: "var(--fg-400)" }}>No release notes published.</div>
      )}
      <div className="inline-actions" style={{ marginTop: 8 }}>
        {hasMore ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
        {htmlUrl ? (
          <a className="btn btn--ghost btn--sm" href={htmlUrl} target="_blank" rel="noreferrer noopener">
            View on GitHub
          </a>
        ) : null}
      </div>
    </div>
  );
}

function LatestSignedReleaseCard({
  ops,
  provenance,
}: {
  ops: OpsRequester;
  provenance: RuntimeProvenanceResponse | null;
}) {
  const feed = useLatestProtocoreRelease();
  const release = feed.data;
  const status = useMemo(
    () => protocoreUpdateStatus({ release, provenance }),
    [release, provenance],
  );
  // Resolve whether the derived installer image tag actually exists on ghcr,
  // BEFORE offering Apply — a released tag whose installer image is not yet
  // published is a guaranteed dead end at image pull. Called unconditionally
  // (hook rules); it no-ops with a null image ref.
  const installerExistence = useInstallerImageExists(release?.installerImage ?? null);

  // Mirror updater.ts silence: a failed/empty fetch never blocks the page.
  if (feed.loading && !release) {
    return (
      <div className="card card--padded">
        <div className="card__head">
          <div>
            <h3>Latest protocore release</h3>
            <div className="sub">Checking the protocore release feed…</div>
          </div>
        </div>
      </div>
    );
  }

  if (!release) {
    return (
      <div className="card card--padded">
        <div className="card__head">
          <div>
            <h3>Latest protocore release</h3>
            <div className="sub" style={{ color: "var(--fg-400)" }}>
              Release feed unavailable — could not read the latest protocore release.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const installerOk = isValidUpgradeImage(release.installerImage);
  // The installer image must resolve on ghcr. Treat "exists" and "unverified"
  // (registry unreachable / running outside Tauri) as OK — blocking on an
  // inability to check is worse than a rejected pull — but a confirmed 404
  // ("absent") or an in-flight check ("checking") disables Apply.
  const installerResolvable =
    installerExistence === "exists" || installerExistence === "unverified";
  // Offer Apply when a newer signed release exists to move to — both when the
  // node is on an older signed release ("update-available") and when it is on
  // an unreleased/dev build ("dev-build"). Both can move onto the signed build.
  const applyEnabled =
    (status.state === "update-available" || status.state === "dev-build") &&
    installerOk &&
    installerResolvable;
  const nodeCommit = provenance?.runtime.gitCommit ?? null;

  const applyUpdate = () => {
    if (!applyEnabled) return;
    const entry = OP_CATALOG.find((candidate) => candidate.kind === "ota-apply");
    if (!entry) return;
    ops.requestOp(
      catalogRequest(entry, {
        otaApplyInput: {
          image: release.installerImage,
          stage: false,
          rebootMode: "default",
          // Carry the target identity so the OTA flow confirms the node came
          // back on THIS release's build, and shows its friendly tag meanwhile.
          targetMonoCoreCommit: release.monoCoreCommit ?? undefined,
          targetTag: release.tag,
        },
      }),
    );
  };

  return (
    <div className="card card--padded">
      <div className="card__head">
        <div>
          <h3>Latest protocore release</h3>
          <div className="sub">
            The newest protocore release published on GitHub, compared against your node's build.
          </div>
        </div>
        <div className="inline-actions">
          <span className={status.className} title={status.title}>
            <span className="dot" /> {status.text}
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={feed.refresh}
            disabled={feed.loading}
          >
            {feed.loading ? "Checking…" : "Re-check"}
          </button>
        </div>
      </div>

      <div className="grid-3" style={{ marginTop: 12 }}>
        <StatCard label="version" value={release.tag} sub={release.name} tone="info" />
        <StatCard label="released" value={formatReleaseDate(release.publishedAt)} sub="published on GitHub" tone="info" />
        <StatCard
          label="signature"
          value={release.signed ? "signed" : "unsigned"}
          sub={
            release.signed
              ? release.sbom
                ? "cosign signature + SBOM published"
                : "cosign signature published"
              : "no cosign signature on release"
          }
          tone={release.signed ? "ok" : "warn"}
        />
      </div>

      <div className="grid-2" style={{ marginTop: 12 }}>
        <div className="kv" style={{ gap: 12 }}>
          <span className="kv__k">Release commit</span>
          <span className="mono">{shortCommit12(release.monoCoreCommit)}</span>
        </div>
        <div className="kv" style={{ gap: 12 }}>
          <span className="kv__k">Node commit</span>
          <span className="mono">{shortCommit12(nodeCommit)}</span>
        </div>
      </div>

      <div style={{ marginTop: 6 }}>
        <span
          className={release.signed ? "halo halo--ok" : "halo halo--warn"}
          title={
            release.signed
              ? "The cosign .sig/.pem and SBOM assets are present on the published GitHub release. This is an assets-present check, not an on-device cosign verification."
              : "The published release is missing a cosign .sig/.pem pair."
          }
        >
          <span className="dot" />{" "}
          {release.signed
            ? release.sbom
              ? "cosign signature + SBOM published"
              : "cosign signature published"
            : "unsigned release"}
        </span>
      </div>

      <ReleaseChangelog notes={release.notes} htmlUrl={release.htmlUrl} />

      <div className="inline-actions" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={applyUpdate}
          disabled={!applyEnabled}
          title={
            status.state === "current"
              ? "Node already matches the latest signed release."
              : status.state === "unknown"
                ? "Cannot compare the node build against this release."
                : !installerOk
                  ? "The derived installer image reference is not a valid upgrade image."
                  : installerExistence === "absent"
                    ? `The installer image ${release.installerImage} does not exist on ghcr yet — applying would fail at image pull. It is published alongside the release.`
                    : installerExistence === "checking"
                      ? "Checking that the installer image exists on ghcr…"
                      : status.state === "dev-build"
                        ? "Apply the latest signed release to move this node off its unreleased build onto a signed build."
                        : "Open the guarded OS upgrade drawer pre-filled with this release."
          }
        >
          Apply this update
        </button>
        <span style={{ fontSize: 10.5, color: "var(--fg-400)", alignSelf: "center" }}>
          Opens the guarded Talos upgrade drawer (preserve=true). You still review and confirm.
        </span>
      </div>
    </div>
  );
}

export function Attestation() {
  const ops = useOps();
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

      <LatestSignedReleaseCard ops={ops} provenance={provenance.data} />

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
        subtitle="operator key generation and storage, attestation, and backup actions."
      />

      <div className="grid-2">
        <OperatorKeySettings />
        <div className="card card--padded">
          <div className="card__head">
            <div>
              <h3>Key operations</h3>
              <div className="sub">Review and authorize key actions before they run.</div>
            </div>
          </div>
          <div className="stack-actions">
            <CatalogButton kind="export-backup">Export offline backup</CatalogButton>
            {presence.hasFoundationKey ? (
              <CatalogButton kind="emergency-key-rotation" variant="danger">Emergency key rotation</CatalogButton>
            ) : null}
          </div>
        </div>
      </div>

      <Blocker
        title="Passkey management is not available in this build."
        detail="Desktop currently stores operator recovery phrases in the OS keychain and uses chain and Monarch OS operations. Passkey lifecycle needs a dedicated runtime bridge before it can be exposed."
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
        subtitle="Operator restore, offline backup, and incident controls."
      />

      <div className="grid-3">
        <StatCard label="your operator" value={shortHex(operatorId)} sub={self.clusterId !== null ? clusterLabel(self.clusterId) : self.status === "no-key" ? "no operator key stored" : "no cluster seat"} tone={operatorId ? "ok" : "warn"} />
        <StatCard label="restore path" value="support-guided" sub="recovery executor" tone="warn" />
        <StatCard label="peer recovery" value="future" sub="cluster approval needed" tone="warn" />
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
                Recovery and admission controls are unavailable on this install.
              </div>
            )}
          </div>
        </div>
        <div className="card card--padded">
          <div className="card__head">
            <div>
              <h3>Future recovery path</h3>
              <div className="sub">Cluster-vouched recovery after active-member approval.</div>
            </div>
          </div>
          <Blocker
            title="Peer-vouched recovery is not available in this build."
            detail="The policy flow needs cluster votes, threshold acknowledgement collection, and a chain helper that applies the approved recovery change."
          />
        </div>
      </div>
    </section>
  );
}
