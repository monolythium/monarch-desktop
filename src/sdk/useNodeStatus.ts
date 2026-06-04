// Single hook that pulls live node state via @monolythium/core-sdk.
// Prefer the native `lyth_chainStatus` surface. Older testnet builds still
// expose a compatibility height method, so keep a fallback until every public
// node has the native chain-status method.
// Falls back to "offline" when the endpoint is unreachable so the UI
// still renders meaningful chrome. Re-polls every 4s for block height +
// current round; chain id is fetched once.
//
// Note: the SDK returns `bigint` for chain id, block height, and round
// height. We collapse to `number` for the chrome — heights stay within
// 2^53 for the lifetime of the chain.

import { useEffect, useRef, useState } from "react";
import { rpc, rpcEndpoint } from "./client";

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

const initialStatus = (): NodeStatus => ({
  endpoint: rpcEndpoint,
  chainId: null,
  blockNumber: null,
  currentRound: null,
  reachable: false,
  lastError: null,
  lastUpdatedAt: null,
});

export function useNodeStatus(): NodeStatus {
  const [status, setStatus] = useState<NodeStatus>(initialStatus);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;

    const fetchOnce = async (includeChainId: boolean) => {
      try {
        const [native, round] = await Promise.all([
          rpc.call<NativeChainStatus>("lyth_chainStatus", []).catch(() => null),
          rpc.lythCurrentRound().catch(() => null),
        ]);
        if (!aliveRef.current) return;
        if (native !== null) {
          setStatus((prev) => ({
            endpoint: rpcEndpoint,
            chainId: includeChainId
              ? (native.chainId ?? prev.chainId)
              : prev.chainId,
            blockNumber:
              native.blockHeight ??
              native.finalizedHeight ??
              (round !== null ? Number(round.height) : prev.blockNumber),
            currentRound:
              round !== null
                ? Number(round.height)
                : native.finalizedHeight ?? prev.currentRound,
            reachable: native.reachable ?? true,
            lastError: null,
            lastUpdatedAt: Date.now(),
          }));
          return;
        }

        const [block, chainId] = await Promise.all([
          rpc.ethBlockNumber(),
          includeChainId ? rpc.ethChainId() : Promise.resolve<bigint | null>(null),
        ]);
        setStatus((prev) => ({
          endpoint: rpcEndpoint,
          chainId: includeChainId
            ? (chainId !== null ? Number(chainId as bigint) : null)
            : prev.chainId,
          blockNumber: Number(block),
          currentRound: round !== null ? Number(round.height) : prev.currentRound,
          reachable: true,
          lastError: null,
          lastUpdatedAt: Date.now(),
        }));
      } catch (err) {
        if (!aliveRef.current) return;
        const message = (err as Error)?.message ?? String(err);
        setStatus((prev) => ({
          ...prev,
          reachable: false,
          lastError: message,
          lastUpdatedAt: Date.now(),
        }));
      }
    };

    void fetchOnce(true);
    const id = window.setInterval(() => {
      void fetchOnce(false);
    }, POLL_MS);

    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
  }, []);

  return status;
}
