// Per-view RPC hooks. Each hook calls a `@monolythium/core-sdk` method,
// polls every `POLL_MS`, and returns `{ data, loading, error, notExposed }`.
// Missing/gated production data returns `data: null` with `notExposed=true`
// so views can render named blockers instead of production-looking fixtures.

import { useEffect, useRef, useState } from "react";
import type {
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
import {
  readClusterJoinRequest,
  type ClusterJoinRequestView,
} from "./clusterJoinOps";

const POLL_MS = 5000;
const RPC_METHOD_NOT_FOUND = -32601;

export type RpcSlice<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  notExposed: boolean;
  lastUpdatedAt: number | null;
};

export type OperatorNetworkMetadataMap = Record<string, OperatorNetworkMetadataView | null>;

const empty = <T,>(): RpcSlice<T> => ({
  data: null,
  loading: true,
  error: null,
  notExposed: false,
  lastUpdatedAt: null,
});

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

// ---- live methods ----------------------------------------------------

export function useCurrentRound(): RpcSlice<RoundInfo> {
  const [slice, setSlice] = useState<RpcSlice<RoundInfo>>(empty);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const fetchOnce = async () => {
      try {
        const round = await rpc.lythCurrentRound();
        if (!aliveRef.current) return;
        setSlice({ data: round, loading: false, error: null, notExposed: false, lastUpdatedAt: Date.now() });
      } catch (err) {
        if (!aliveRef.current) return;
        setSlice((prev) => ({ ...prev, loading: false, error: (err as Error)?.message ?? String(err), lastUpdatedAt: Date.now() }));
      }
    };
    void fetchOnce();
    const id = window.setInterval(() => void fetchOnce(), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
  }, []);

  return slice;
}

export function useClusterDirectory(page = 0, limit = 100): RpcSlice<ClusterDirectoryEntryResponse[]> {
  const [slice, setSlice] = useState<RpcSlice<ClusterDirectoryEntryResponse[]>>(empty);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const fetchOnce = async () => {
      try {
        const directory = await rpc.lythClusterDirectory(page, limit);
        if (!aliveRef.current) return;
        setSlice({ data: directory.clusters, loading: false, error: null, notExposed: false, lastUpdatedAt: Date.now() });
      } catch (err) {
        if (!aliveRef.current) return;
        setSlice((prev) => ({ ...prev, loading: false, error: (err as Error)?.message ?? String(err), lastUpdatedAt: Date.now() }));
      }
    };
    void fetchOnce();
    const id = window.setInterval(() => void fetchOnce(), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
  }, [page, limit]);

  return slice;
}

export function useProviderDirectory(
  capabilityMask = 0,
  cursor: string | null = null,
  limit = 50,
): RpcSlice<RegistryRecord[]> {
  return usePolledRpc(
    () => rpc.lythListProviders(capabilityMask, cursor, limit),
    [capabilityMask, cursor, limit],
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function useIndexerStatus(): RpcSlice<IndexerStatus | null> {
  const [slice, setSlice] = useState<RpcSlice<IndexerStatus | null>>(empty);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const fetchOnce = async () => {
      try {
        const idx = await rpc.lythIndexerStatus();
        if (!aliveRef.current) return;
        setSlice({ data: idx, loading: false, error: null, notExposed: false, lastUpdatedAt: Date.now() });
      } catch (err) {
        if (!aliveRef.current) return;
        setSlice((prev) => ({ ...prev, loading: false, error: (err as Error)?.message ?? String(err), lastUpdatedAt: Date.now() }));
      }
    };
    void fetchOnce();
    const id = window.setInterval(() => void fetchOnce(), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
  }, []);

  return slice;
}

export function useRuntimeProvenance(): RpcSlice<RuntimeProvenanceResponse> {
  const [slice, setSlice] = useState<RpcSlice<RuntimeProvenanceResponse>>(empty);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const fetchOnce = async () => {
      try {
        const provenance = await rpc.lythRuntimeProvenance();
        if (!aliveRef.current) return;
        setSlice({ data: provenance, loading: false, error: null, notExposed: false, lastUpdatedAt: Date.now() });
      } catch (err) {
        if (!aliveRef.current) return;
        if (isMethodNotFound(err)) {
          setSlice({ data: null, loading: false, error: null, notExposed: true, lastUpdatedAt: Date.now() });
          return;
        }
        setSlice((prev) => ({ ...prev, loading: false, error: (err as Error)?.message ?? String(err), lastUpdatedAt: Date.now() }));
      }
    };
    void fetchOnce();
    const id = window.setInterval(() => void fetchOnce(), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
  }, []);

  return slice;
}

export function useOperatorCapabilities(): RpcSlice<OperatorCapabilitiesResponse> {
  const [slice, setSlice] = useState<RpcSlice<OperatorCapabilitiesResponse>>(empty);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const fetchOnce = async () => {
      try {
        const capabilities = await rpc.lythOperatorCapabilities();
        if (!aliveRef.current) return;
        setSlice({ data: capabilities, loading: false, error: null, notExposed: false, lastUpdatedAt: Date.now() });
      } catch (err) {
        if (!aliveRef.current) return;
        if (isMethodNotFound(err)) {
          setSlice({ data: null, loading: false, error: null, notExposed: true, lastUpdatedAt: Date.now() });
          return;
        }
        setSlice((prev) => ({ ...prev, loading: false, error: (err as Error)?.message ?? String(err), lastUpdatedAt: Date.now() }));
      }
    };
    void fetchOnce();
    const id = window.setInterval(() => void fetchOnce(), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
  }, []);

  return slice;
}

// ---- 0.3.10 operator reads (gateable / indexer-projected) -----------
// operator-router (0x100B), prover-market (0x100C), oracle (0x1009),
// cluster-diversity + operator-network-metadata (0x1005), and bridge
// health (0x1008) all landed in @monolythium/core-sdk 0.3.10. They are
// gateable precompiles that answer `method not found` until the milestone
// activates them. `usePolledRpc` keeps the panel honest on the gated path —
// `notExposed=true`, data null, "available when activated" — instead of
// faking a production value. Two of them (prover-market, oracle) are also
// indexer-projected: when the node runs without the projection they return
// a real body carrying `status: "indexer_unavailable"`, so the view inspects
// `data.status` rather than `notExposed`. Bridge-health is a plain native
// read (no such fallback body); cluster-diversity / network-metadata are
// node-registry (0x1005) reads.

function usePolledRpc<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  notExposedWhen: (err: unknown) => boolean = isMethodNotFound,
): RpcSlice<T> {
  const [slice, setSlice] = useState<RpcSlice<T>>(empty);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const fetchOnce = async () => {
      try {
        const data = await fetcher();
        if (!aliveRef.current) return;
        setSlice({ data, loading: false, error: null, notExposed: false, lastUpdatedAt: Date.now() });
      } catch (err) {
        if (!aliveRef.current) return;
        if (notExposedWhen(err)) {
          setSlice({ data: null, loading: false, error: null, notExposed: true, lastUpdatedAt: Date.now() });
          return;
        }
        setSlice((prev) => ({ ...prev, loading: false, error: (err as Error)?.message ?? String(err), lastUpdatedAt: Date.now() }));
      }
    };
    void fetchOnce();
    const id = window.setInterval(() => void fetchOnce(), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
    // fetcher closes over the deps below; deps drive re-subscription.
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return slice;
}

// A missing required argument (no operator/cluster selected yet) is the
// same UX state as a gated surface: nothing to show, but not an error.
const NO_TARGET = { code: RPC_METHOD_NOT_FOUND, message: "method not found: no target selected" };

export function useClusterJoinRequestView(
  clusterId: number | string | null,
  operatorIdHex: string | null,
): RpcSlice<ClusterJoinRequestView> {
  return usePolledRpc(
    () =>
      clusterId !== null && operatorIdHex
        ? readClusterJoinRequest(rpc, { clusterId, operatorIdHex })
        : Promise.reject(NO_TARGET),
    [clusterId, operatorIdHex],
    isClusterJoinViewUnavailable,
  );
}

export function useOperatorRouterConfig(): RpcSlice<OperatorRouterConfig> {
  return usePolledRpc(() => rpc.lythOperatorRouterConfig(), []);
}

// `operator` MUST be the operator's bech32m USER (wallet) address — the
// fee registration is keyed by `parse_user_address` on-chain. It is NOT
// the cluster-member operatorId; there is
// no client-side derivation between the two. Feed `OperatorInfoResponse.
// chainAddress`, guarded to a `mono1…` form by the caller.
export function useOperatorFeeConfig(operator: string | null): RpcSlice<OperatorFeeConfig> {
  return usePolledRpc(
    () => (operator ? rpc.lythOperatorFeeConfig(operator) : Promise.reject(NO_TARGET)),
    [operator],
    (err) => isMethodNotFound(err) || isNotFound(err) || isAddressError(err),
  );
}

export function useClusterDiversity(clusterId: number): RpcSlice<ClusterDiversityView> {
  return usePolledRpc(
    () => rpc.lythGetClusterDiversity(clusterId),
    [clusterId],
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function useClusterResignations(
  operator: string | null = null,
  status: "pending" | "applied" | "all" = "all",
): RpcSlice<ClusterResignationsResponse> {
  return usePolledRpc(
    () => rpc.lythGetClusterResignations(operator, status),
    [operator, status],
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function useOperatorNetworkMetadata(operatorId: string | null): RpcSlice<OperatorNetworkMetadataView> {
  return usePolledRpc(
    () => (operatorId ? rpc.lythGetOperatorNetworkMetadata(operatorId) : Promise.reject(NO_TARGET)),
    [operatorId],
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
    [key],
    (err) => isMethodNotFound(err),
  );
}

export function useProverMarketStatus(): RpcSlice<ProverMarketStatusResponse> {
  return usePolledRpc(() => rpc.lythProverMarketStatus(), []);
}

export function useOracleSigners(): RpcSlice<OracleSignersResponse> {
  return usePolledRpc(() => rpc.lythOracleSigners(), []);
}

export function useBridgeHealth(): RpcSlice<BridgeHealthResponse> {
  return usePolledRpc(() => rpc.lythBridgeHealth(), []);
}

export function useOperatorAuthority(operatorId: string | null): RpcSlice<OperatorAuthorityResponse> {
  return usePolledRpc(
    () => (operatorId ? rpc.lythResolveOperatorAuthority(operatorId) : Promise.reject(NO_TARGET)),
    [operatorId],
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function useOperatorRisk(
  authorityIndex: number | null,
  windowRounds = 200,
): RpcSlice<OperatorRiskResponse> {
  return usePolledRpc(
    () =>
      authorityIndex !== null
        ? rpc.lythOperatorRisk(authorityIndex, windowRounds)
        : Promise.reject(NO_TARGET),
    [authorityIndex, windowRounds],
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function useOperatorSigningActivity(
  authorityIndex: number | null,
  limit = 200,
): RpcSlice<OperatorSigningActivityResponse> {
  return usePolledRpc(
    () =>
      authorityIndex !== null
        ? rpc.lythSigningActivity(authorityIndex, limit)
        : Promise.reject(NO_TARGET),
    [authorityIndex, limit],
    (err) => isMethodNotFound(err) || isNotFound(err),
  );
}

export function useUpcomingDuties(
  authorityIndex: number | null,
  horizonRounds = 500,
): RpcSlice<UpcomingDutiesResponse> {
  return usePolledRpc(
    () =>
      authorityIndex !== null
        ? rpc.lythUpcomingDuties(authorityIndex, horizonRounds)
        : Promise.reject(NO_TARGET),
    [authorityIndex, horizonRounds],
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
    () =>
      selectors.length > 0
        ? rpc.lythMetricsRange([...selectors], range)
        : Promise.reject(NO_TARGET),
    [selectorKey, rangeKey],
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

// The cluster anchor is derived by the SDK from the roster and threshold,
// displayed under the `monok` HRP. Returns null if any member's roster key
// is incomplete.
function deriveAnchor(members: { blsPubkey: string }[], threshold: number): string | null {
  try {
    const hex = deriveClusterAnchorAddress(members.map((m) => m.blsPubkey), threshold);
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

function mapOperatorInfo(data: OperatorInfoResponse): OperatorInfo {
  return {
    id: data.operatorId,
    moniker: data.moniker ?? data.alias ?? shortOperatorId(data.operatorId),
    jailed: data.lifecycleState === "jailed" || data.lifecycleState === "tombstoned",
    bondedStake: data.bondedAmount,
    pubkey: data.blsKeyFingerprint ?? data.operatorKeyFingerprint ?? data.chainAddress,
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

function mapClusterStatus(data: ClusterStatusResponse): ClusterStatus {
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
  const [slice, setSlice] = useState<RpcSlice<OperatorInfo>>(empty);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;

    const fetchOnce = async () => {
      if (!operatorId) {
        setSlice({ data: null, loading: false, error: null, notExposed: true, lastUpdatedAt: Date.now() });
        return;
      }
      try {
        const data = await rpc.lythOperatorInfo(operatorId);
        if (!aliveRef.current) return;
        setSlice({ data: mapOperatorInfo(data), loading: false, error: null, notExposed: false, lastUpdatedAt: Date.now() });
      } catch (err) {
        if (!aliveRef.current) return;
        if (isMethodNotFound(err) || isNotFound(err)) {
          setSlice({ data: null, loading: false, error: null, notExposed: true, lastUpdatedAt: Date.now() });
          return;
        }
        setSlice((prev) => ({ ...prev, loading: false, error: (err as Error)?.message ?? String(err), lastUpdatedAt: Date.now() }));
      }
    };

    void fetchOnce();
    const idInterval = window.setInterval(() => void fetchOnce(), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(idInterval);
    };
  }, [operatorId]);

  return slice;
}

export function useClusterStatus(id: number | null): RpcSlice<ClusterStatus> {
  const [slice, setSlice] = useState<RpcSlice<ClusterStatus>>(empty);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;

    const fetchOnce = async () => {
      if (id === null) {
        setSlice({ data: null, loading: false, error: null, notExposed: true, lastUpdatedAt: Date.now() });
        return;
      }
      try {
        const data = await rpc.lythClusterStatus(id);
        if (!aliveRef.current) return;
        setSlice({ data: mapClusterStatus(data), loading: false, error: null, notExposed: false, lastUpdatedAt: Date.now() });
      } catch (err) {
        if (!aliveRef.current) return;
        if (isMethodNotFound(err) || isNotFound(err)) {
          setSlice({ data: null, loading: false, error: null, notExposed: true, lastUpdatedAt: Date.now() });
          return;
        }
        setSlice((prev) => ({ ...prev, loading: false, error: (err as Error)?.message ?? String(err), lastUpdatedAt: Date.now() }));
      }
    };

    void fetchOnce();
    const idInterval = window.setInterval(() => void fetchOnce(), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(idInterval);
    };
  }, [id]);

  return slice;
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

export function useChainStatus(): RpcSlice<ChainStatus> {
  const [slice, setSlice] = useState<RpcSlice<ChainStatus>>(empty);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;

    const fetchOnce = async () => {
      try {
        const data = await rpc.call<Partial<ChainStatus>>("lyth_chainStatus", []);
        if (!aliveRef.current) return;
        setSlice({ data: normalizeChainStatus(data), loading: false, error: null, notExposed: false, lastUpdatedAt: Date.now() });
        return;
      } catch (err) {
        if (!isMethodNotFound(err)) {
          if (!aliveRef.current) return;
          setSlice((prev) => ({ ...prev, loading: false, error: (err as Error)?.message ?? String(err), lastUpdatedAt: Date.now() }));
          return;
        }
      }

      try {
        const [chainId, block, round, directory] = await Promise.all([
          rpc.ethChainId().catch(() => null),
          rpc.ethBlockNumber().catch(() => null),
          rpc.lythCurrentRound().catch(() => null),
          rpc.lythClusterDirectory(0, 100).catch(() => null),
        ]);
        if (!aliveRef.current) return;
        const operatorCount = directory?.clusters.reduce((sum, c) => sum + c.size, 0) ?? 0;
        const data: ChainStatus = {
          chainId: chainId !== null ? Number(chainId) : 0,
          blockHeight: block !== null ? Number(block) : 0,
          finalizedHeight: round ? Number(round.height) : 0,
          operatorCount,
          clusterCount: directory?.totalClusters ?? directory?.clusters.length ?? 0,
          mempoolDepth: 0,
          reachable: chainId !== null && block !== null,
        };
        setSlice({ data, loading: false, error: null, notExposed: true, lastUpdatedAt: Date.now() });
      } catch (err) {
        if (!aliveRef.current) return;
        setSlice((prev) => ({ ...prev, loading: false, error: (err as Error)?.message ?? String(err), lastUpdatedAt: Date.now() }));
      }
    };

    void fetchOnce();
    const id = window.setInterval(() => void fetchOnce(), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
  }, []);

  return slice;
}
