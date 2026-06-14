// Single hook that pulls live node state. The WS push feed
// (`subscriptions.ts`) drives round/height the instant a commit seals;
// the shared query cache keeps a 4s `lyth_chainStatus` poll underneath
// as the reachability probe and the fallback when push is unavailable.
// Falls back to "offline" when the endpoint is unreachable so the UI
// still renders meaningful chrome.
//
// Note: the SDK returns `bigint` for chain id, block height, and round
// height. We collapse to `number` for the chrome — heights stay within
// 2^53 for the lifetime of the chain.

import { useMemo } from "react";
import { rpc, rpcEndpoint } from "./client";
import { useQuery } from "./queryCache";
import { useLiveCommit, useLiveFeedStatus } from "./subscriptions";

export type NodeStatus = {
  endpoint: string;
  chainId: number | null;
  blockNumber: number | null;
  currentRound: number | null;
  reachable: boolean;
  lastError: string | null;
  lastUpdatedAt: number | null;
};

const POLL_MS = 4000;

type NativeChainStatus = {
  chainId?: number;
  blockHeight?: number;
  finalizedHeight?: number;
  reachable?: boolean;
};

type NodeStatusFetch = {
  chainId: number | null;
  blockNumber: number | null;
  currentRound: number | null;
  reachable: boolean;
};

// Chain id never changes for a connected node; cache the first answer so
// the fallback path doesn't re-ask every poll.
let cachedChainId: number | null = null;

type NativeSyncStatus = { localRound?: number; peerMaxRound?: number; lag?: number };

async function fetchNodeStatus(): Promise<NodeStatusFetch> {
  // `lyth_currentRound`'s `height` is the EXECUTION (block) height — NOT the DAG
  // round. The DAG round comes from `lyth_syncStatus.localRound`; the two are
  // decoupled (multiple heights commit per round), so they must NOT be conflated
  // — showing the block height under a "round" label is the bug this fixes.
  const [native, height, sync] = await Promise.all([
    rpc.call<NativeChainStatus>("lyth_chainStatus", []).catch(() => null),
    rpc.lythCurrentRound().catch(() => null),
    rpc.call<NativeSyncStatus>("lyth_syncStatus", []).catch(() => null),
  ]);
  const blockHeight = height !== null ? Number(height.height) : null;
  const dagRound = sync && typeof sync.localRound === "number" ? sync.localRound : null;

  if (native !== null) {
    if (typeof native.chainId === "number") cachedChainId = native.chainId;
    return {
      chainId: cachedChainId,
      blockNumber: native.blockHeight ?? blockHeight ?? native.finalizedHeight ?? null,
      currentRound: dagRound ?? native.finalizedHeight ?? null,
      reachable: native.reachable ?? true,
    };
  }

  // `lyth_chainStatus` can be disabled on a node; fall back to the block height
  // from `lyth_currentRound` (reliable) before eth-compat, so "block" is never
  // blank just because chainStatus/eth_blockNumber are off.
  const [block, chainId] = await Promise.all([
    rpc.ethBlockNumber().catch(() => null),
    cachedChainId === null
      ? rpc.ethChainId().catch(() => null)
      : Promise.resolve<bigint | null>(null),
  ]);
  if (chainId !== null) cachedChainId = Number(chainId);
  return {
    chainId: cachedChainId,
    blockNumber: blockHeight ?? (block !== null ? Number(block) : null),
    currentRound: dagRound,
    reachable: true,
  };
}

export function useNodeStatus(): NodeStatus {
  const polled = useQuery<NodeStatusFetch>("node:status", fetchNodeStatus, {
    intervalMs: POLL_MS,
    notExposedWhen: () => false,
  });
  const commit = useLiveCommit();
  const feed = useLiveFeedStatus();

  return useMemo(() => {
    const base: NodeStatus = {
      endpoint: rpcEndpoint,
      chainId: polled.data?.chainId ?? cachedChainId,
      blockNumber: polled.data?.blockNumber ?? null,
      currentRound: polled.data?.currentRound ?? null,
      reachable: polled.data?.reachable ?? false,
      lastError: polled.error,
      lastUpdatedAt: polled.lastUpdatedAt,
    };
    // Push feed overlay: when the socket is live, commits arrive the
    // moment they seal — fresher than any poll, and proof the node is
    // reachable even if an HTTP probe just failed.
    if (commit && feed.live) {
      return {
        ...base,
        blockNumber: Math.max(base.blockNumber ?? 0, commit.height),
        currentRound: commit.round ?? base.currentRound ?? commit.height,
        reachable: true,
        lastError: null,
        lastUpdatedAt: Math.max(base.lastUpdatedAt ?? 0, commit.at),
      };
    }
    return base;
  }, [polled, commit, feed.live]);
}
