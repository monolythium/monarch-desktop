// Wires `@monolythium/core-sdk` into the Tauri 2 React 19 shell.
// A single shared `RpcClient` is held at module scope so views don't
// re-construct it. The endpoint is overridable via `VITE_RPC_ENDPOINT`
// (or `TAURI_RPC_ENDPOINT`) at build time, or via the local app setting
// at runtime. Default is the local node RPC on 8545.

import { RpcClient } from "@monolythium/core-sdk";

export const FALLBACK_ENDPOINT = "http://127.0.0.1:8545";
export const RPC_ENDPOINT_STORAGE_KEY = "monarch.rpcEndpoint";

function normaliseEndpoint(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("RPC endpoint must use http:// or https://");
  }

  return parsed.toString().replace(/\/$/, "");
}

function envEndpoint(): string | null {
  const env = import.meta.env as Record<string, string | undefined>;
  return normaliseEndpoint(env.VITE_RPC_ENDPOINT ?? env.TAURI_RPC_ENDPOINT);
}

export function getStoredRpcEndpoint(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return normaliseEndpoint(window.localStorage.getItem(RPC_ENDPOINT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function setStoredRpcEndpoint(endpoint: string | null): string | null {
  if (typeof window === "undefined") return null;

  const next = normaliseEndpoint(endpoint);
  if (next) {
    window.localStorage.setItem(RPC_ENDPOINT_STORAGE_KEY, next);
  } else {
    window.localStorage.removeItem(RPC_ENDPOINT_STORAGE_KEY);
  }
  return next;
}

function resolveEndpoint(): string {
  return getStoredRpcEndpoint() ?? envEndpoint() ?? FALLBACK_ENDPOINT;
}

export const rpc = new RpcClient(resolveEndpoint());
export const rpcEndpoint = rpc.endpoint;
