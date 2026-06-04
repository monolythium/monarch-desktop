import { RpcClient, type OperatorNetworkMetadataView } from "@monolythium/core-sdk";
import { rpc, rpcEndpoint } from "./client";

export const CHAT_BOOTSTRAP_PEERS_STORAGE_KEY = "monarch.chatBootstrapPeers";

export type ChatPeerDiscoveryClient = {
  lythClusterStatus: (clusterId: number) => Promise<{
    members: readonly { operatorId: string }[];
  }>;
  lythGetOperatorNetworkMetadata: (operatorId: string) => Promise<OperatorNetworkMetadataView | unknown>;
};

export type ResolveClusterChatBootstrapPeersOptions = {
  endpoint?: string;
  clusterId?: number | null;
  configuredPeers?: readonly string[];
  client?: ChatPeerDiscoveryClient;
};

const CHAT_PEER_FIELD_NAMES = [
  "chatBootstrapPeers",
  "chat_bootstrap_peers",
  "chatBootstrapPeer",
  "chat_bootstrap_peer",
  "chatLibp2pPeers",
  "chat_libp2p_peers",
  "chatMultiaddrs",
  "chat_multiaddrs",
  "bootstrapPeers",
  "bootstrap_peers",
  "libp2pMultiaddrs",
  "libp2p_multiaddrs",
  "multiaddrs",
  "multiaddr",
  "peers",
] as const;

const CHAT_CONTAINER_FIELD_NAMES = [
  "chat",
  "operatorChat",
  "operator_chat",
  "monarchChat",
  "monarch_chat",
  "chatConfig",
  "chat_config",
  "libp2p",
  "p2p",
  "services",
  "serviceEndpoints",
  "service_endpoints",
] as const;

export function parseChatBootstrapPeers(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/u)
    .map((peer) => peer.trim())
    .filter(Boolean);
}

function envChatBootstrapPeers(): string[] {
  const env = import.meta.env as Record<string, string | undefined>;
  return parseChatBootstrapPeers(
    env.VITE_CHAT_BOOTSTRAP_PEERS ?? env.TAURI_CHAT_BOOTSTRAP_PEERS,
  );
}

export function getStoredChatBootstrapPeers(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return parseChatBootstrapPeers(
      window.localStorage.getItem(CHAT_BOOTSTRAP_PEERS_STORAGE_KEY),
    );
  } catch {
    return [];
  }
}

export function setStoredChatBootstrapPeers(peers: string[]): string[] {
  const normalized = parseChatBootstrapPeers(peers.join("\n"));
  if (typeof window === "undefined") return normalized;

  if (normalized.length > 0) {
    window.localStorage.setItem(
      CHAT_BOOTSTRAP_PEERS_STORAGE_KEY,
      normalized.join("\n"),
    );
  } else {
    window.localStorage.removeItem(CHAT_BOOTSTRAP_PEERS_STORAGE_KEY);
  }
  return normalized;
}

export function resolveChatBootstrapPeers(): string[] {
  const stored = getStoredChatBootstrapPeers();
  return stored.length > 0 ? stored : envChatBootstrapPeers();
}

export function isChatBootstrapPeer(value: string): boolean {
  return value.startsWith("/")
    && value.includes("/p2p/")
    && !/[\s,]/u.test(value)
    && value.split("/").filter(Boolean).length >= 4;
}

export function extractChatBootstrapPeersFromOperatorMetadata(metadata: unknown): string[] {
  const found: string[] = [];
  const root = record(metadata);
  if (!root) return found;

  for (const field of CHAT_PEER_FIELD_NAMES) {
    if (field.startsWith("chat")) collectPeerValues(root[field], found);
  }

  for (const field of CHAT_CONTAINER_FIELD_NAMES) {
    collectPeersFromChatContainer(root[field], found);
  }

  return dedupePeers(found).filter(isChatBootstrapPeer);
}

export async function discoverClusterChatBootstrapPeers(
  options: ResolveClusterChatBootstrapPeersOptions,
): Promise<string[]> {
  if (typeof options.clusterId !== "number") return [];
  const client = options.client ?? clientForEndpoint(options.endpoint);
  const cluster = await client.lythClusterStatus(options.clusterId).catch(() => null);
  const members = cluster?.members ?? [];
  if (members.length === 0) return [];

  const rows = await Promise.all(
    members.map((member) =>
      client.lythGetOperatorNetworkMetadata(member.operatorId)
        .then(extractChatBootstrapPeersFromOperatorMetadata)
        .catch(() => []),
    ),
  );
  return dedupePeers(rows.flat()).filter(isChatBootstrapPeer);
}

export async function resolveChatBootstrapPeersForCluster(
  options: ResolveClusterChatBootstrapPeersOptions = {},
): Promise<string[]> {
  const configured = options.configuredPeers
    ? dedupePeers(options.configuredPeers)
    : resolveChatBootstrapPeers();
  const discovered = await discoverClusterChatBootstrapPeers(options).catch(() => []);
  return dedupePeers([...configured, ...discovered]);
}

function clientForEndpoint(endpoint?: string): ChatPeerDiscoveryClient {
  return sameEndpoint(endpoint ?? rpcEndpoint, rpcEndpoint)
    ? rpc
    : new RpcClient(endpoint ?? rpcEndpoint);
}

function sameEndpoint(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/u, "") === b.trim().replace(/\/+$/u, "");
}

function collectPeersFromChatContainer(value: unknown, out: string[]): void {
  const obj = record(value);
  if (Array.isArray(value)) {
    for (const item of value) collectPeersFromServiceEntry(item, out);
    return;
  }
  if (!obj) return;

  for (const field of CHAT_PEER_FIELD_NAMES) {
    collectPeerValues(obj[field], out);
  }

  for (const nested of ["chat", "operatorChat", "operator_chat", "libp2p", "p2p"] as const) {
    if (obj[nested] !== value) collectPeersFromChatContainer(obj[nested], out);
  }
}

function collectPeersFromServiceEntry(value: unknown, out: string[]): void {
  const obj = record(value);
  if (!obj) return;
  const label = [
    obj.id,
    obj.name,
    obj.kind,
    obj.type,
    obj.protocol,
    obj.service,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  if (!label.includes("chat")) return;
  collectPeersFromChatContainer(obj, out);
}

function collectPeerValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(...parseChatBootstrapPeers(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPeerValues(item, out);
    return;
  }
  const obj = record(value);
  if (!obj) return;
  collectPeerValues(obj.multiaddr, out);
  collectPeerValues(obj.multiaddrs, out);
  collectPeerValues(obj.peer, out);
  collectPeerValues(obj.peers, out);
}

function dedupePeers(peers: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of peers) {
    const peer = raw.trim();
    if (!peer || seen.has(peer)) continue;
    seen.add(peer);
    out.push(peer);
  }
  return out;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
