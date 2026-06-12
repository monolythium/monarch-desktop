// Per-view RPC hooks. Each hook calls a `@monolythium/core-sdk` method
// through the shared query cache (`queryCache.ts`): one fetch loop per
// method+args key, deduped across components, paused while the window
// is hidden, with exponential backoff when the endpoint is unreachable.
// Hooks return `{ data, loading, error, notExposed, lastUpdatedAt }`.
// Missing/gated production data returns `data: null` with `notExposed=true`
// so views can render named blockers instead of production-looking fixtures.
// The round/height hooks prefer the node WS push feed (`subscriptions.ts`)
// and fall back to cached polling when push is unavailable.

import { useMemo } from "react";
import type {
  ActiveCharterView,
  BridgeHealthResponse,
  ClusterDirectoryEntryResponse,
  ClusterDiversityView,
  ClusterResignationsResponse,
  ClusterStatusResponse,
  IndexerStatus,
  MetricsRangeResponse,
  OperatorCapabilitiesResponse,
  OperatorAuthorityResponse,
  OperatorFeeConfig,
  OperatorInfoResponse,
  OperatorNetworkMetadataView,
  OperatorRiskResponse,
  OperatorRouterConfig,
  OperatorSigningActivityResponse,
  OracleSignersResponse,
  ProverMarketStatusResponse,
  RegistryRecord,
  RoundInfo,
  RuntimeProvenanceResponse,
  UpcomingDutiesResponse,
} from "@monolythium/core-sdk";
import { addressToTypedBech32, deriveClusterAnchorAddress, formatLyth } from "@monolythium/core-sdk";
import { rpc } from "./client";
import { useQuery } from "./queryCache";
import { useLiveCommit } from "./subscriptions";
import {
  readClusterJoinRequest,
  type ClusterJoinRequestView,
} from "./clusterJoinOps";

const RPC_METHOD_NOT_FOUND = -32601;

export type RpcSlice<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  notExposed: boolean;
  lastUpdatedAt: number | null;
};

export type OperatorNetworkMetadataMap = Record<string, OperatorNetworkMetadataView | null>;

function isMethodNotFound(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | null;
  if (!e) return false;
  if (e.code === RPC_METHOD_NOT_FOUND) return true;
  const msg = (e.message ?? "").toLowerCase();
  return msg.includes("method not found") || msg.includes("not yet exposed");
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | null;
  const msg = (e?.message ?? "").toLowerCase();
  return e?.code === -32090 || msg.includes("not found") || msg.includes("unknown operator");
}

// SDK 0.3.10 hard-rejects a non-bech32m / raw-0x address before the RPC
// even leaves the client. Treat that as "nothing to show" (notExposed)
// rather than a stuck error, so an address-typed read never wedges on
// "loading" when handed an identifier of the wrong form.
function isAddressError(err: unknown): boolean {
  const msg = ((err as { message?: string } | null)?.message ?? "").toLowerCase();
  return msg.includes("bech32") || msg.includes("addresses are retired") || msg.includes("malformed address");
}

function isClusterJoinViewUnavailable(err: unknown): boolean {
  if (isMethodNotFound(err) || isNotFound(err)) return true;
  const msg = ((err as { message?: string } | null)?.message ?? "").toLowerCase();
  return (
    msg.includes("unknown selector") ||
    msg.includes("unsupported selector") ||
    msg.includes("selector not") ||
    msg.includes("execution reverted")
  );
}

function shortOperatorId(operatorId: string): string {
  if (operatorId.length <= 16) return operatorId;
  return `${operatorId.slice(0, 8)}…${operatorId.slice(-6)}`;
}

// A missing required argument (no operator/cluster selected yet) is the
// same UX state as a gated surface: nothing to show, but not an error.
const NO_TARGET = { code: RPC_METHOD_NOT_FOUND, message: "method not found: no target selected" };

// One cache entry per method+args. The key carries every argument so
// distinct targets never share a loop, and identical hooks across
// components share one.
function usePolledRpc<T>(
  key: string,
  fetcher: () => Promise<T>,
  notExposedWhen: (err: unknown) => boolean = isMethodNotFound,
): RpcSlice<T> {
  return useQuery<T>(key, fetcher, { notExposedWhen });
}

// ---- live methods ----------------------------------------------------

export function useCurrentRound(): RpcSlice<RoundInfo> {
  const polled = usePolledRpc<RoundInfo>(
    "lyth_currentRound",
    () => rpc.lythCurrentRound(),
    () => false,
  );
  const commit = useLiveCommit();
  return useMemo(() => {
    // WS push wins when it is at least as fresh as the last poll —
    // `RoundInfo.height` stays "latest committed height".
    if (commit && (polled.lastUpdatedAt === null || commit.at >= polled.lastUpdatedAt)) {
      return {
        data: { height: BigInt(commit.height) },
        loading: false,
        error: null,
        notExposed: false,
        lastUpdatedAt: commit.at,
      };
    }
    return polled;
  }, [polled, commit]);
}

export function useClusterDirectory(page = 0, limit = 100): RpcSlice<ClusterDirectoryEntryResponse[]> {
  return usePolledRpc(
    `lyth_clusterDirectory:${page}:${limit}`,
    async () => (await rpc.lythClusterDirectory(page, limit)).clusters,
    () => false,
  );
}

export function useProviderDirectory(
  capabilityMask = 0,
  cursor: string | null = null,
  limit = 50,
): RpcSlice<RegistryRecord[]> {
  return usePolledRpc(
    `lyth_listProviders:${capabilityMask}:${cursor ?? ""}:${limit}`,
    () => rpc.lythListProviders(capabilityMask, cursor, limit),
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function useIndexerStatus(): RpcSlice<IndexerStatus | null> {
  return usePolledRpc("lyth_indexerStatus", () => rpc.lythIndexerStatus(), () => false);
}

export function useRuntimeProvenance(): RpcSlice<RuntimeProvenanceResponse> {
  return usePolledRpc("lyth_runtimeProvenance", () => rpc.lythRuntimeProvenance());
}

export function useOperatorCapabilities(): RpcSlice<OperatorCapabilitiesResponse> {
  return usePolledRpc("lyth_operatorCapabilities", () => rpc.lythOperatorCapabilities());
}

// ---- 0.3.10 operator reads (gateable / indexer-projected) -----------
// operator-router (0x100B), prover-market (0x100C), oracle (0x1009),
// cluster-diversity + operator-network-metadata (0x1005), and bridge
// health (0x1008) all landed in @monolythium/core-sdk 0.3.10. They are
// gateable precompiles that answer `method not found` until the milestone
// activates them. The cache keeps the panel honest on the gated path —
// `notExposed=true`, data null, "available when activated" — instead of
// faking a production value. Two of them (prover-market, oracle) are also
// indexer-projected: when the node runs without the projection they return
// a real body carrying `status: "indexer_unavailable"`, so the view inspects
// `data.status` rather than `notExposed`. Bridge-health is a plain native
// read (no such fallback body); cluster-diversity / network-metadata are
// node-registry (0x1005) reads.

export function useClusterJoinRequestView(
  clusterId: number | string | null,
  operatorIdHex: string | null,
): RpcSlice<ClusterJoinRequestView> {
  return usePolledRpc(
    `clusterJoinRequestView:${clusterId ?? ""}:${operatorIdHex ?? ""}`,
    () =>
      clusterId !== null && operatorIdHex
        ? readClusterJoinRequest(rpc, { clusterId, operatorIdHex })
        : Promise.reject(NO_TARGET),
    isClusterJoinViewUnavailable,
  );
}

export function useOperatorRouterConfig(): RpcSlice<OperatorRouterConfig> {
  return usePolledRpc("lyth_operatorRouterConfig", () => rpc.lythOperatorRouterConfig());
}

// `operator` MUST be the operator's bech32m USER (wallet) address — the
// fee registration is keyed by `parse_user_address` on-chain. It is NOT
// the cluster-member operatorId; there is
// no client-side derivation between the two. Feed `OperatorInfoResponse.
// chainAddress`, guarded to a `mono1…` form by the caller.
export function useOperatorFeeConfig(operator: string | null): RpcSlice<OperatorFeeConfig> {
  return usePolledRpc(
    `lyth_operatorFeeConfig:${operator ?? ""}`,
    () => (operator ? rpc.lythOperatorFeeConfig(operator) : Promise.reject(NO_TARGET)),
    (err) => isMethodNotFound(err) || isNotFound(err) || isAddressError(err),
  );
}

export function useClusterDiversity(clusterId: number): RpcSlice<ClusterDiversityView> {
  return usePolledRpc(
    `lyth_getClusterDiversity:${clusterId}`,
    () => rpc.lythGetClusterDiversity(clusterId),
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

// Component A — the settled per-cluster ServiceScore the reward path reads
// each block. SDK 0.4.17 SLOADs the `TAG_SERVICE_SCORE` slot at `0x1005`;
// `0n` means the cluster has never been scored (not an error). This is the
// headline of the service-reward model: rewards track this PROVED-SERVICE
// score, not the cluster's stake (which only sets rank).
export function useClusterServiceScore(clusterId: number | null): RpcSlice<bigint> {
  return usePolledRpc(
    `lyth_getClusterServiceScore:${clusterId ?? ""}`,
    () => (clusterId !== null ? rpc.lythGetClusterServiceScore(clusterId) : Promise.reject(NO_TARGET)),
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

// Component H — the cluster's ACTIVE economics charter (operator/delegator
// split + per-seat shares). SDK 0.4.17 reads it from node-registry storage;
// `{ present: false }` for genesis / 3-arg-formCluster clusters that never
// adopted a charter. Used here only for the operator/delegator earnings
// split term-read, NOT for amendment (that path lives in CharterPanel).
export function useClusterCharter(clusterId: number | null): RpcSlice<ActiveCharterView> {
  return usePolledRpc(
    `lyth_getClusterCharter:${clusterId ?? ""}`,
    () => (clusterId !== null ? rpc.lythGetClusterCharter(clusterId) : Promise.reject(NO_TARGET)),
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function useClusterResignations(
  operator: string | null = null,
  status: "pending" | "applied" | "all" = "all",
): RpcSlice<ClusterResignationsResponse> {
  return usePolledRpc(
    `lyth_getClusterResignations:${operator ?? ""}:${status}`,
    () => rpc.lythGetClusterResignations(operator, status),
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function useOperatorNetworkMetadata(operatorId: string | null): RpcSlice<OperatorNetworkMetadataView> {
  return usePolledRpc(
    `lyth_getOperatorNetworkMetadata:${operatorId ?? ""}`,
    () => (operatorId ? rpc.lythGetOperatorNetworkMetadata(operatorId) : Promise.reject(NO_TARGET)),
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function normalizeOperatorIdList(
  operatorIds: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of operatorIds) {
    const id = raw?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function useOperatorNetworkMetadataMap(
  operatorIds: readonly (string | null | undefined)[],
): RpcSlice<OperatorNetworkMetadataMap> {
  const ids = normalizeOperatorIdList(operatorIds);
  const key = ids.join("|");
  return usePolledRpc(
    `operatorNetworkMetadataMap:${key}`,
    async () => {
      if (ids.length === 0) return {};
      const rows = await Promise.all(
        ids.map(async (operatorId) => {
          try {
            return [operatorId, await rpc.lythGetOperatorNetworkMetadata(operatorId)] as const;
          } catch (err) {
            if (isNotFound(err)) return [operatorId, null] as const;
            throw err;
          }
        }),
      );
      return Object.fromEntries(rows);
    },
    (err) => isMethodNotFound(err),
  );
}

export function useProverMarketStatus(): RpcSlice<ProverMarketStatusResponse> {
  return usePolledRpc("lyth_proverMarketStatus", () => rpc.lythProverMarketStatus());
}

export function useOracleSigners(): RpcSlice<OracleSignersResponse> {
  return usePolledRpc("lyth_oracleSigners", () => rpc.lythOracleSigners());
}

export function useBridgeHealth(): RpcSlice<BridgeHealthResponse> {
  return usePolledRpc("lyth_bridgeHealth", () => rpc.lythBridgeHealth());
}

export function useOperatorAuthority(operatorId: string | null): RpcSlice<OperatorAuthorityResponse> {
  return usePolledRpc(
    `lyth_resolveOperatorAuthority:${operatorId ?? ""}`,
    () => (operatorId ? rpc.lythResolveOperatorAuthority(operatorId) : Promise.reject(NO_TARGET)),
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function useOperatorRisk(
  authorityIndex: number | null,
  windowRounds = 200,
): RpcSlice<OperatorRiskResponse> {
  return usePolledRpc(
    `lyth_operatorRisk:${authorityIndex ?? ""}:${windowRounds}`,
    () =>
      authorityIndex !== null
        ? rpc.lythOperatorRisk(authorityIndex, windowRounds)
        : Promise.reject(NO_TARGET),
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function useOperatorSigningActivity(
  authorityIndex: number | null,
  limit = 200,
): RpcSlice<OperatorSigningActivityResponse> {
  return usePolledRpc(
    `lyth_signingActivity:${authorityIndex ?? ""}:${limit}`,
    () =>
      authorityIndex !== null
        ? rpc.lythSigningActivity(authorityIndex, limit)
        : Promise.reject(NO_TARGET),
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function useUpcomingDuties(
  authorityIndex: number | null,
  horizonRounds = 500,
): RpcSlice<UpcomingDutiesResponse> {
  return usePolledRpc(
    `lyth_upcomingDuties:${authorityIndex ?? ""}:${horizonRounds}`,
    () =>
      authorityIndex !== null
        ? rpc.lythUpcomingDuties(authorityIndex, horizonRounds)
        : Promise.reject(NO_TARGET),
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function useMetricsRange(
  selectors: readonly string[],
  range: readonly [number | bigint | string, number | bigint | string] | null = null,
): RpcSlice<MetricsRangeResponse> {
  const selectorKey = selectors.join("|");
  const rangeKey = range ? `${range[0].toString()}:${range[1].toString()}` : "latest";
  return usePolledRpc(
    `lyth_metricsRange:${selectorKey}:${rangeKey}`,
    () =>
      selectors.length > 0
        ? rpc.lythMetricsRange([...selectors], range)
        : Promise.reject(NO_TARGET),
    (err) => isMethodNotFound(err),
  );
}

// ---- display helpers for the 0.3.10 reads (pure, unit-tested) -------

/** Format a `0..=10000` basis-points score (diversity tuple) as a percent string. */
export function bpsToPercent(bps: number | null | undefined, digits = 1): string {
  if (bps === null || bps === undefined || Number.isNaN(bps)) return "—";
  return `${(bps / 100).toFixed(digits)}%`;
}

/** Format a `0x`-hex uint256 lythoshi amount as a LYTH string via the SDK formatter. */
export function formatLythHex(hex: string | null | undefined): string {
  if (!hex) return "—";
  try {
    return formatLyth(BigInt(hex));
  } catch {
    return "—";
  }
}

/** Human label for the node-registry wire hosting-class string. */
export function hostingClassLabel(
  raw: "bare_metal" | "co_location" | "cloud" | string | null | undefined,
): string {
  switch (raw) {
    case "bare_metal":
      return "bare-metal";
    case "co_location":
      return "co-location";
    case "cloud":
      return "cloud";
    default:
      return "—";
  }
}

// ---- operator / cluster view models --------------------------------

export type OperatorInfo = {
  id: string;
  moniker: string;
  jailed: boolean;
  bondedStake: string;
  pubkey: string;
  /** Operator's on-chain account (bech32m `mono1…`) — the fee-config key. */
  address: string;
  active: boolean;
};

export type ClusterMemberState = "nominal" | "lag" | "maintenance" | "jail";

export type ClusterStatus = {
  id: number;
  threshold: number;
  size: number;
  state: ClusterMemberState;
  members: { id: number; operatorId: string; handle: string; state: ClusterMemberState }[];
  epoch: number;
  /** Cluster anchor (bech32m `monok1…`), derived from the roster + threshold; null if the roster key set is incomplete. */
  anchorAddress: string | null;
};

type OperatorInfoWireAliases = OperatorInfoResponse & {
  consensusKeyFingerprint?: string | null;
  blsKeyFingerprint?: string | null;
};

type ClusterMemberWireAliases = {
  consensusPubkey?: string | null;
  blsPubkey?: string | null;
};

function operatorConsensusKeyFingerprint(data: OperatorInfoResponse): string | null {
  const row = data as OperatorInfoWireAliases;
  return row.consensusKeyFingerprint ?? row.blsKeyFingerprint ?? null;
}

// The cluster anchor is derived by the SDK from the roster and threshold,
// displayed under the `monok` HRP. Returns null if any member's roster key
// is incomplete.
function deriveAnchor(members: readonly ClusterMemberWireAliases[], threshold: number): string | null {
  try {
    const rosterKeys: string[] = [];
    for (const member of members) {
      const key = member.consensusPubkey ?? member.blsPubkey;
      if (!key) return null;
      rosterKeys.push(key);
    }
    const hex = deriveClusterAnchorAddress(rosterKeys, threshold);
    return addressToTypedBech32("cluster", hex);
  } catch {
    return null;
  }
}

export type ChainStatus = {
  chainId: number;
  blockHeight: number;
  finalizedHeight: number;
  operatorCount: number;
  clusterCount: number;
  mempoolDepth: number;
  reachable: boolean;
};

export function mapOperatorInfo(data: OperatorInfoResponse): OperatorInfo {
  return {
    id: data.operatorId,
    moniker: data.moniker ?? data.alias ?? shortOperatorId(data.operatorId),
    jailed: data.lifecycleState === "jailed" || data.lifecycleState === "tombstoned",
    bondedStake: data.bondedAmount,
    pubkey: operatorConsensusKeyFingerprint(data) ?? data.operatorKeyFingerprint ?? data.chainAddress,
    address: data.chainAddress,
    active: data.activeClusterIds.length > 0 && data.lifecycleState !== "tombstoned",
  };
}

function normalizeMemberState(raw: string): ClusterMemberState {
  const s = raw.toLowerCase();
  if (s.includes("maintenance")) return "maintenance";
  if (s.includes("jail") || s.includes("offline") || s.includes("tombstone")) return "jail";
  if (s.includes("lag") || s.includes("miss")) return "lag";
  return "nominal";
}

export function mapClusterStatus(data: ClusterStatusResponse): ClusterStatus {
  const members = data.members.map((m, i) => ({
    id: i + 1,
    operatorId: m.operatorId,
    handle: shortOperatorId(m.operatorId) || `operator-${i + 1}`,
    state: normalizeMemberState(m.state),
  }));
  const state: ClusterMemberState =
    data.offline > 0 ? "jail" : data.lagging > 0 ? "lag" : data.maintenance > 0 ? "maintenance" : "nominal";
  return {
    id: data.clusterId,
    threshold: data.threshold,
    size: data.size,
    state,
    members,
    epoch: data.epoch !== null ? Number(data.epoch) : 0,
    anchorAddress: deriveAnchor(data.members, data.threshold),
  };
}

export function useOperatorInfo(operatorId: string | null): RpcSlice<OperatorInfo> {
  return usePolledRpc(
    `lyth_operatorInfo:${operatorId ?? ""}`,
    async () =>
      operatorId
        ? mapOperatorInfo(await rpc.lythOperatorInfo(operatorId))
        : Promise.reject(NO_TARGET),
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function useClusterStatus(id: number | null): RpcSlice<ClusterStatus> {
  return usePolledRpc(
    `lyth_clusterStatus:${id ?? ""}`,
    async () =>
      id !== null
        ? mapClusterStatus(await rpc.lythClusterStatus(id))
        : Promise.reject(NO_TARGET),
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

function normalizeChainStatus(raw: Partial<ChainStatus>): ChainStatus {
  return {
    chainId: raw.chainId ?? 0,
    blockHeight: raw.blockHeight ?? 0,
    finalizedHeight: raw.finalizedHeight ?? 0,
    operatorCount: raw.operatorCount ?? 0,
    clusterCount: raw.clusterCount ?? 0,
    mempoolDepth: raw.mempoolDepth ?? 0,
    reachable: raw.reachable ?? false,
  };
}

// `lyth_chainStatus` with a basic-RPC composition fallback for nodes
// that don't expose the native method. `viaFallback` maps onto the
// slice's `notExposed` so views keep the "some methods not yet exposed"
// banner — while still carrying the composed data.
type ChainStatusFetch = { status: ChainStatus; viaFallback: boolean };

async function fetchChainStatus(): Promise<ChainStatusFetch> {
  try {
    const data = await rpc.call<Partial<ChainStatus>>("lyth_chainStatus", []);
    return { status: normalizeChainStatus(data), viaFallback: false };
  } catch (err) {
    if (!isMethodNotFound(err)) throw err;
  }

  const [chainId, block, round, directory] = await Promise.all([
    rpc.ethChainId().catch(() => null),
    rpc.ethBlockNumber().catch(() => null),
    rpc.lythCurrentRound().catch(() => null),
    rpc.lythClusterDirectory(0, 100).catch(() => null),
  ]);
  const operatorCount = directory?.clusters.reduce((sum, c) => sum + c.size, 0) ?? 0;
  return {
    status: {
      chainId: chainId !== null ? Number(chainId) : 0,
      blockHeight: block !== null ? Number(block) : 0,
      finalizedHeight: round ? Number(round.height) : 0,
      operatorCount,
      clusterCount: directory?.totalClusters ?? directory?.clusters.length ?? 0,
      mempoolDepth: 0,
      reachable: chainId !== null && block !== null,
    },
    viaFallback: true,
  };
}

export function useChainStatus(): RpcSlice<ChainStatus> {
  const polled = usePolledRpc<ChainStatusFetch>("lyth_chainStatus", fetchChainStatus, () => false);
  const commit = useLiveCommit();
  return useMemo(() => {
    let data = polled.data?.status ?? null;
    // Overlay the freshest committed height from the WS feed; heights
    // are monotonic so `max` never regresses the polled value.
    if (data && commit && commit.height > data.blockHeight) {
      data = { ...data, blockHeight: commit.height, reachable: true };
    }
    return {
      data,
      loading: polled.loading,
      error: polled.error,
      notExposed: polled.data?.viaFallback ?? polled.notExposed,
      lastUpdatedAt:
        commit && polled.lastUpdatedAt !== null
          ? Math.max(commit.at, polled.lastUpdatedAt)
          : polled.lastUpdatedAt,
    };
  }, [polled, commit]);
}
