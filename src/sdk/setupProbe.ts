// Setup-wizard node connection probe.
//
// The first-run wizard needs to test reachability against an endpoint the
// operator types BEFORE it is saved as the active endpoint — so this builds
// a throwaway `RpcClient` for the candidate URL and runs a small bundle of
// reads (chain id, latest height, sync state, client version). Nothing here
// touches the shared module-scoped `rpc` client or localStorage; the wizard
// persists the endpoint via `setStoredRpcEndpoint` only on success/continue.
//
// `normalizeNodeEndpoint` is the lenient input parser the hero step uses: it
// accepts a bare IP/host (`178.105.12.9`) and defaults it to
// `http://<host>:8545`, accepts `host:port`, and accepts a full
// `http(s)://host:port` URL. It throws a clear message for genuinely
// malformed input so the field can show why.

import { RpcClient } from "@monolythium/core-sdk";
import { makeRpcClient } from "./rpcTransport";

/** Default operator RPC port — matches the chain's `8545`. */
export const DEFAULT_RPC_PORT = 8545;

export type ProbeOutcome = "ok" | "wrong-chain" | "unreachable" | "error";

export type NodeProbeResult = {
  outcome: ProbeOutcome;
  /** Normalized endpoint the probe ran against. */
  endpoint: string;
  /** Decimal chain id, when the node answered `eth_chainId`. */
  chainId: number | null;
  /** Latest block height, when the node answered `eth_blockNumber`. */
  blockNumber: number | null;
  /** true = caught up, false = still syncing, null = couldn't tell. */
  synced: boolean | null;
  /** `web3_clientVersion` string, when exposed. */
  clientVersion: string | null;
  /** Human-readable failure reason for the `unreachable` / `error` cases. */
  error: string | null;
};

/**
 * Coerce loose operator input into a canonical `http(s)://host:port` URL.
 *
 * Rules:
 *   - empty -> throws.
 *   - already has a scheme -> validated as a URL, must be http/https,
 *     a missing port is left as-is (https defaults to 443, http to 80 in
 *     the browser; operators pasting a full URL know their port).
 *   - bare `host` -> `http://host:8545`.
 *   - bare `host:port` -> `http://host:port`.
 *
 * The trailing slash is stripped to match `client.ts` normalisation so the
 * value compares equal to what `setStoredRpcEndpoint` ultimately stores.
 */
export function normalizeNodeEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Enter your node URL or IP address.");

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const candidate = hasScheme ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("That doesn't look like a valid host, IP, or URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Node endpoint must use http:// or https://");
  }
  if (!url.hostname) {
    throw new Error("Missing host — enter an IP or hostname.");
  }

  // A bare host (no scheme, no explicit port) defaults to the chain RPC port.
  if (!hasScheme && !url.port) {
    url.port = String(DEFAULT_RPC_PORT);
  }

  return url.toString().replace(/\/$/, "");
}

function isTimeout(err: unknown): boolean {
  const msg = ((err as { message?: string } | null)?.message ?? "").toLowerCase();
  return msg.includes("timeout") || msg.includes("timed out") || msg.includes("abort");
}

function isConnectionRefused(err: unknown): boolean {
  const msg = ((err as { message?: string } | null)?.message ?? "").toLowerCase();
  return (
    msg.includes("refused") ||
    msg.includes("failed to fetch") ||
    msg.includes("network") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed")
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("request timed out")), ms);
    }),
  ]);
}

/**
 * Live reachability probe against a candidate endpoint. Pure with respect to
 * app state: builds and discards its own client, never mutates the shared
 * `rpc`. `expectedChainId`, when supplied, turns a reachable-but-wrong-chain
 * node into an explicit `wrong-chain` outcome (used by re-test affordances).
 */
export async function probeNodeEndpoint(
  endpoint: string,
  opts: { timeoutMs?: number; expectedChainId?: number | null } = {},
): Promise<NodeProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 6_000;
  const base: NodeProbeResult = {
    outcome: "error",
    endpoint,
    chainId: null,
    blockNumber: null,
    synced: null,
    clientVersion: null,
    error: null,
  };

  let probe: RpcClient;
  try {
    probe = makeRpcClient(endpoint);
  } catch (err) {
    return { ...base, error: (err as Error)?.message ?? String(err) };
  }

  // chain id is the reachability anchor — if it fails the node is down.
  let chainId: bigint;
  try {
    chainId = await withTimeout(probe.ethChainId(), timeoutMs);
  } catch (err) {
    if (isTimeout(err)) {
      return {
        ...base,
        outcome: "unreachable",
        error: "Timed out — no response from that endpoint. Check the IP, port, and that the node RPC is up.",
      };
    }
    if (isConnectionRefused(err)) {
      return {
        ...base,
        outcome: "unreachable",
        error: "Connection refused — nothing is listening there. Check the host/port and that protocore's RPC is exposed.",
      };
    }
    return {
      ...base,
      outcome: "unreachable",
      error: (err as Error)?.message ?? String(err),
    };
  }

  const chainIdNum = Number(chainId);

  // The rest are best-effort enrichment; a node that answered chain id is
  // reachable even if these individually fail.
  const [blockNumber, sync, clientVersion] = await Promise.all([
    withTimeout(probe.ethBlockNumber(), timeoutMs)
      .then((n) => Number(n))
      .catch(() => null),
    withTimeout(probe.ethSyncing(), timeoutMs).catch(() => undefined),
    withTimeout(probe.web3ClientVersion(), timeoutMs).catch(() => null),
  ]);

  // `eth_syncing` returns `null` when fully synced, a status object while
  // catching up. `undefined` here means the call itself failed — unknown.
  const synced = sync === undefined ? null : sync === null;

  if (
    opts.expectedChainId !== undefined &&
    opts.expectedChainId !== null &&
    chainIdNum !== opts.expectedChainId
  ) {
    return {
      ...base,
      outcome: "wrong-chain",
      chainId: chainIdNum,
      blockNumber,
      synced,
      clientVersion: clientVersion ?? null,
      error: `Reachable, but this node reports chain ${chainIdNum} — expected chain ${opts.expectedChainId}.`,
    };
  }

  return {
    outcome: "ok",
    endpoint,
    chainId: chainIdNum,
    blockNumber,
    synced,
    clientVersion: clientVersion ?? null,
    error: null,
  };
}
