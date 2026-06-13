// Native RPC transport for the in-app SDK.
//
// In the Tauri webview the app runs on a secure origin (`tauri://localhost`),
// so a direct `fetch()` from the SDK's `RpcClient` to a node's plain-http
// `:8545` is blocked by the webview as mixed content — surfacing as the
// opaque "Load failed" transport error on every `lyth_*` / `eth_*` read.
//
// We route the JSON-RPC POST through the native HTTP stack (`rpc_proxy`
// Tauri command) instead, which has no cross-origin / mixed-content
// restriction. Outside Tauri (`pnpm dev`, vitest) we hand back `undefined`
// so the SDK keeps using the platform `fetch`.

import { RpcClient } from "@monolythium/core-sdk";
import { invoke, isTauri } from "@tauri-apps/api/core";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function endpointOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

// A `fetch`-shaped function that forwards the request body through the
// native proxy and re-wraps the raw response so `RpcClient` can call
// `.json()` / read `.ok` / read `.status` exactly as it would for a real
// fetch Response. POST-JSON only: this is fed solely to the SDK's RpcClient
// (which always POSTs a JSON-RPC body); it ignores init.method/headers and
// must NOT be reused for the SDK's REST/NodeApiClient (which GETs with query
// params — those would be silently dropped).
const NULL_BODY_STATUS = new Set([204, 205, 304]);

const tauriRpcFetch: FetchLike = async (input, init) => {
  const rpcEndpoint = endpointOf(input);
  const body = typeof init?.body === "string" ? init.body : "";
  let status: number;
  let text: string;
  try {
    // rpc_proxy returns [httpStatus, body] so the node's real status flows
    // through — a 404/502 from a wrong path or downed proxy must not look 200.
    [status, text] = await invoke<[number, string]>("rpc_proxy", { rpcEndpoint, body });
  } catch (err) {
    // Throw a network-style error so RpcClient wraps it as SdkError.transport,
    // matching the failure shape callers already handle.
    throw new TypeError(typeof err === "string" ? err : ((err as Error)?.message ?? String(err)));
  }
  // The Response constructor forbids a body for null-body statuses (204/205/
  // 304); pass null there so a misconfigured proxy returning one doesn't throw.
  return new Response(NULL_BODY_STATUS.has(status) ? null : text, {
    status,
    headers: { "content-type": "application/json" },
  });
};

/** The fetch implementation `RpcClient` should use, or `undefined` outside Tauri. */
export function rpcFetch(): FetchLike | undefined {
  return isTauri() ? tauriRpcFetch : undefined;
}

/**
 * Construct an `RpcClient` wired to the native transport when running inside
 * Tauri. Use this everywhere instead of `new RpcClient(...)` so no view ever
 * issues a mixed-content fetch to the node.
 */
export function makeRpcClient(
  endpoint: string,
  options: { headers?: Record<string, string> } = {},
): RpcClient {
  const fetch = rpcFetch();
  return new RpcClient(endpoint, fetch ? { ...options, fetch } : options);
}
