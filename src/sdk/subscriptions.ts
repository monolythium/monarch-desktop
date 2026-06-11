// ONE WebSocket to the connected node, shared by every live surface.
//
// The node upgrades `GET /ws` on the same host:port as the HTTP RPC and
// speaks JSON-RPC over text frames: `lyth_subscribe([topic])` answers a
// subscription id, then pushes `lyth_subscription` notifications
// (`params: { subscription, result }`). The packaged SDK's `lythSubscribe`
// only issues the HTTP call (which the server rejects — WebSocket-only),
// so this module owns the raw WS framing and exposes a tiny pub/sub
// store with auto-reconnect and a graceful "unavailable" flag so the
// polling cache can keep carrying the UI when push is not available.
//
// Topics used by Monarch: `newCommit` (round seals), `newHeads`
// (committed headers), `dagVertices` (per-seat vertex authorship for
// the Consensus Pulse).

import { useSyncExternalStore } from "react";
import { rpcEndpoint } from "./client";

export type LiveTopic = "newCommit" | "newHeads" | "dagVertices";

export type CommitEvent = {
  /** Committed block height. */
  height: number;
  /** DAG round that sealed, when the node has it in scope. */
  round: number | null;
  /** Canonical block hash that closed the round. */
  commitHash: string | null;
  /** Local arrival timestamp (ms). */
  at: number;
};

export type HeadEvent = {
  height: number;
  hash: string | null;
  parentHash: string | null;
  /** UNIX seconds from the header, when present. */
  timestamp: number | null;
  at: number;
};

export type VertexEvent = {
  height: number;
  round: number;
  /** Authoring seat (authority index). */
  author: number;
  vertexHash: string;
  at: number;
};

export type LiveEventMap = {
  newCommit: CommitEvent;
  newHeads: HeadEvent;
  dagVertices: VertexEvent;
};

export type LiveFeedState = "idle" | "connecting" | "live" | "unavailable";

export type LiveFeedStatus = {
  state: LiveFeedState;
  /** True once at least one subscription is confirmed on an open socket. */
  live: boolean;
  /** Consecutive failed connection attempts since the last good session. */
  attempts: number;
  lastError: string | null;
};

// ---- pure helpers (unit-tested) --------------------------------------

/** Derive the node's WS endpoint (`/ws`) from its HTTP RPC endpoint. */
export function wsEndpointFromRpc(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = value.startsWith("0x") || value.startsWith("0X")
      ? Number.parseInt(value, 16)
      : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function decodeCommitEvent(result: unknown, at = Date.now()): CommitEvent | null {
  if (!result || typeof result !== "object") return null;
  const row = result as Record<string, unknown>;
  const height = asNumber(row["number"]);
  if (height === null) return null;
  return {
    height,
    round: asNumber(row["round"]),
    commitHash: asString(row["commitHash"]),
    at,
  };
}

export function decodeHeadEvent(result: unknown, at = Date.now()): HeadEvent | null {
  if (!result || typeof result !== "object") return null;
  const row = result as Record<string, unknown>;
  const height = asNumber(row["number"]);
  if (height === null) return null;
  return {
    height,
    hash: asString(row["hash"]),
    parentHash: asString(row["parentHash"]),
    timestamp: asNumber(row["timestamp"]),
    at,
  };
}

export function decodeVertexEvent(result: unknown, at = Date.now()): VertexEvent | null {
  if (!result || typeof result !== "object") return null;
  const row = result as Record<string, unknown>;
  const height = asNumber(row["height"]);
  const round = asNumber(row["round"]);
  const author = asNumber(row["author"]);
  const vertexHash = asString(row["vertexHash"]);
  if (height === null || round === null || author === null || !vertexHash) return null;
  return { height, round, author, vertexHash, at };
}

// ---- the store --------------------------------------------------------

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
};

type WebSocketCtor = new (url: string) => WebSocketLike;

const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const TOPICS: readonly LiveTopic[] = ["newCommit", "newHeads", "dagVertices"];

export class LiveFeed {
  private readonly url: string | null;
  private readonly wsCtor: WebSocketCtor | null;
  private readonly listeners: Record<LiveTopic, Set<(ev: never) => void>> = {
    newCommit: new Set(),
    newHeads: new Set(),
    dagVertices: new Set(),
  };
  private readonly statusListeners = new Set<() => void>();
  private ws: WebSocketLike | null = null;
  private socketOpen = false;
  private nextId = 1;
  private pendingSubs = new Map<number, LiveTopic>();
  private subIdToTopic = new Map<string, LiveTopic>();
  private requestedTopics = new Set<LiveTopic>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private teardownTimer: ReturnType<typeof setTimeout> | null = null;
  private status: LiveFeedStatus = { state: "idle", live: false, attempts: 0, lastError: null };
  private lastCommit: CommitEvent | null = null;
  private lastHead: HeadEvent | null = null;

  constructor(url: string | null, wsCtor?: WebSocketCtor | null) {
    this.url = url;
    this.wsCtor =
      wsCtor !== undefined
        ? wsCtor
        : typeof WebSocket !== "undefined"
          ? (WebSocket as unknown as WebSocketCtor)
          : null;
  }

  /** Attach a topic listener. Opens the socket on the first listener. */
  subscribe<K extends LiveTopic>(topic: K, fn: (ev: LiveEventMap[K]) => void): () => void {
    this.listeners[topic].add(fn as (ev: never) => void);
    if (this.teardownTimer !== null) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
    if (this.ws === null && this.totalListeners() >= 1) {
      this.open();
    } else if (this.socketOpen && !this.requestedTopics.has(topic)) {
      this.requestSubscribe(topic);
    }
    return () => {
      this.listeners[topic].delete(fn as (ev: never) => void);
      // Linger before closing: React resubscribes external stores
      // across renders, and a momentary zero-listener window must not
      // bounce the socket.
      if (this.totalListeners() === 0 && this.teardownTimer === null) {
        this.teardownTimer = setTimeout(() => {
          this.teardownTimer = null;
          if (this.totalListeners() === 0) this.teardown();
        }, 1000);
      }
    };
  }

  subscribeStatus(fn: () => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  getStatus(): LiveFeedStatus {
    return this.status;
  }

  getLastCommit(): CommitEvent | null {
    return this.lastCommit;
  }

  getLastHead(): HeadEvent | null {
    return this.lastHead;
  }

  private totalListeners(): number {
    return TOPICS.reduce((sum, topic) => sum + this.listeners[topic].size, 0);
  }

  private setStatus(next: Partial<LiveFeedStatus>): void {
    const merged = { ...this.status, ...next };
    // Only notify on real changes — status subscribers are React
    // stores, and a no-op notification forces a pointless rerender.
    if (
      merged.state === this.status.state &&
      merged.live === this.status.live &&
      merged.attempts === this.status.attempts &&
      merged.lastError === this.status.lastError
    ) {
      return;
    }
    this.status = merged;
    for (const fn of this.statusListeners) fn();
  }

  private open(): void {
    if (this.ws) return;
    if (!this.url || !this.wsCtor) {
      this.setStatus({ state: "unavailable", live: false, lastError: "WebSocket transport not available" });
      return;
    }
    this.setStatus({ state: "connecting", live: false });
    let socket: WebSocketLike;
    try {
      socket = new this.wsCtor(this.url);
    } catch (err) {
      this.setStatus({
        state: "unavailable",
        live: false,
        lastError: (err as Error)?.message ?? String(err),
      });
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    socket.onopen = () => {
      this.socketOpen = true;
      for (const topic of TOPICS) {
        if (this.listeners[topic].size > 0) this.requestSubscribe(topic);
      }
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onerror = () => {
      // onclose follows; record the failure mode for the status chip.
      this.setStatus({ lastError: "WebSocket error" });
    };
    socket.onclose = () => {
      this.resetSocketState();
      if (this.totalListeners() > 0) {
        this.setStatus({
          state: "unavailable",
          live: false,
          attempts: this.status.attempts + 1,
        });
        this.scheduleReconnect();
      } else {
        this.setStatus({ state: "idle", live: false });
      }
    };
  }

  private resetSocketState(): void {
    this.ws = null;
    this.socketOpen = false;
    this.pendingSubs.clear();
    this.subIdToTopic.clear();
    this.requestedTopics.clear();
  }

  private teardown(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.teardownTimer !== null) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
    const socket = this.ws;
    this.resetSocketState();
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      try {
        socket.close();
      } catch {
        // closing an already-failed socket is fine
      }
    }
    this.setStatus({ state: "idle", live: false });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.totalListeners() === 0) return;
    const delay = Math.min(
      BASE_RECONNECT_MS * 2 ** Math.max(0, this.status.attempts - 1),
      MAX_RECONNECT_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.totalListeners() > 0) this.open();
    }, delay);
  }

  private requestSubscribe(topic: LiveTopic): void {
    if (!this.ws || !this.socketOpen) return;
    const id = this.nextId;
    this.nextId += 1;
    this.pendingSubs.set(id, topic);
    this.requestedTopics.add(topic);
    try {
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "lyth_subscribe", params: [topic] }));
    } catch (err) {
      this.pendingSubs.delete(id);
      this.requestedTopics.delete(topic);
      this.setStatus({ lastError: (err as Error)?.message ?? String(err) });
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    // Subscription confirmations.
    const id = msg["id"];
    if (typeof id === "number" && this.pendingSubs.has(id)) {
      const topic = this.pendingSubs.get(id)!;
      this.pendingSubs.delete(id);
      const result = msg["result"];
      if (typeof result === "string") {
        this.subIdToTopic.set(result, topic);
        if (!this.status.live) {
          this.setStatus({ state: "live", live: true, attempts: 0, lastError: null });
        }
      } else {
        // Node rejected this topic — flag it, keep the other topics alive.
        this.requestedTopics.delete(topic);
        const error = msg["error"] as { message?: string } | undefined;
        this.setStatus({ lastError: error?.message ?? `subscribe ${topic} rejected` });
      }
      return;
    }

    if (msg["method"] !== "lyth_subscription") return;
    const params = msg["params"] as { subscription?: unknown; result?: unknown } | undefined;
    const subId = typeof params?.subscription === "string" ? params.subscription : null;
    if (!subId) return;
    const topic = this.subIdToTopic.get(subId);
    if (!topic) return;
    this.dispatch(topic, params?.result);
  }

  private dispatch(topic: LiveTopic, result: unknown): void {
    if (topic === "newCommit") {
      const ev = decodeCommitEvent(result);
      if (!ev) return;
      this.lastCommit = ev;
      for (const fn of this.listeners.newCommit) (fn as (e: CommitEvent) => void)(ev);
      return;
    }
    if (topic === "newHeads") {
      const ev = decodeHeadEvent(result);
      if (!ev) return;
      this.lastHead = ev;
      for (const fn of this.listeners.newHeads) (fn as (e: HeadEvent) => void)(ev);
      return;
    }
    const ev = decodeVertexEvent(result);
    if (!ev) return;
    for (const fn of this.listeners.dagVertices) (fn as (e: VertexEvent) => void)(ev);
  }
}

// ---- app-wide singleton + hooks ---------------------------------------

export const liveFeed = new LiveFeed(wsEndpointFromRpc(rpcEndpoint));

// Stable subscribe/getSnapshot identities — useSyncExternalStore
// resubscribes whenever the subscribe function changes, so inline
// closures here would bounce the shared socket on every render.
const subscribeStatus = (cb: () => void) => liveFeed.subscribeStatus(cb);
const getStatus = () => liveFeed.getStatus();
const subscribeCommit = (cb: () => void) => liveFeed.subscribe("newCommit", cb);
const getLastCommit = () => liveFeed.getLastCommit();
const subscribeHead = (cb: () => void) => liveFeed.subscribe("newHeads", cb);
const getLastHead = () => liveFeed.getLastHead();

/** Connection status of the shared node WS feed. */
export function useLiveFeedStatus(): LiveFeedStatus {
  return useSyncExternalStore(subscribeStatus, getStatus, getStatus);
}

/** Latest `newCommit` push (null until the first event lands). */
export function useLiveCommit(): CommitEvent | null {
  return useSyncExternalStore(subscribeCommit, getLastCommit, getLastCommit);
}

/** Latest `newHeads` push (null until the first event lands). */
export function useLiveHead(): HeadEvent | null {
  return useSyncExternalStore(subscribeHead, getLastHead, getLastHead);
}
