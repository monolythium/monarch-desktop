import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LiveFeed,
  decodeCommitEvent,
  decodeHeadEvent,
  decodeVertexEvent,
  wsEndpointFromRpc,
  type CommitEvent,
} from "./subscriptions";

describe("wsEndpointFromRpc", () => {
  it("derives ws:// from http:// and appends /ws", () => {
    expect(wsEndpointFromRpc("http://127.0.0.1:8545")).toBe("ws://127.0.0.1:8545/ws");
  });

  it("derives wss:// from https:// and strips trailing slashes", () => {
    expect(wsEndpointFromRpc("https://rpc.example.com/")).toBe("wss://rpc.example.com/ws");
  });

  it("returns null for non-http endpoints", () => {
    expect(wsEndpointFromRpc("ftp://nope")).toBeNull();
    expect(wsEndpointFromRpc("not a url")).toBeNull();
  });
});

describe("event decoders", () => {
  it("decodes the newCommit wire shape (hex fields)", () => {
    const ev = decodeCommitEvent({ number: "0x10", round: "0x2a", commitHash: "0xabcd" }, 7);
    expect(ev).toEqual({ height: 16, round: 42, commitHash: "0xabcd", at: 7 });
  });

  it("keeps round null when the producer had no round in scope", () => {
    const ev = decodeCommitEvent({ number: "0x10" }, 7);
    expect(ev?.round).toBeNull();
  });

  it("decodes the newHeads wire shape", () => {
    const ev = decodeHeadEvent(
      { number: "0x5", hash: "0xh", parentHash: "0xp", timestamp: "0x64" },
      9,
    );
    expect(ev).toEqual({ height: 5, hash: "0xh", parentHash: "0xp", timestamp: 100, at: 9 });
  });

  it("decodes the dagVertices wire shape (plain numbers)", () => {
    const ev = decodeVertexEvent(
      { height: 12, round: 30, author: 1, vertexHash: "0xv" },
      3,
    );
    expect(ev).toEqual({ height: 12, round: 30, author: 1, vertexHash: "0xv", at: 3 });
  });

  it("rejects malformed payloads instead of guessing", () => {
    expect(decodeCommitEvent(null)).toBeNull();
    expect(decodeCommitEvent({})).toBeNull();
    expect(decodeVertexEvent({ height: 1, round: 2 })).toBeNull();
  });
});

// Minimal in-memory WebSocket double for driving the feed.
class FakeWs {
  static instances: FakeWs[] = [];
  url: string;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWs.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  serverOpen(): void {
    this.onopen?.();
  }

  serverMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  serverClose(): void {
    this.onclose?.();
  }
}

describe("LiveFeed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWs.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function confirmSub(ws: FakeWs, frameIndex: number): string {
    const frame = JSON.parse(ws.sent[frameIndex]!) as { id: number; params: [string] };
    const subId = `0x${frame.id}`;
    ws.serverMessage({ jsonrpc: "2.0", id: frame.id, result: subId });
    return subId;
  }

  it("opens one socket, subscribes, and dispatches decoded events", async () => {
    const feed = new LiveFeed("ws://node/ws", FakeWs as never);
    const got: CommitEvent[] = [];
    const off = feed.subscribe("newCommit", (ev) => got.push(ev));

    expect(FakeWs.instances).toHaveLength(1);
    const ws = FakeWs.instances[0]!;
    ws.serverOpen();
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({
      method: "lyth_subscribe",
      params: ["newCommit"],
    });

    const subId = confirmSub(ws, 0);
    expect(feed.getStatus().live).toBe(true);

    ws.serverMessage({
      jsonrpc: "2.0",
      method: "lyth_subscription",
      params: { subscription: subId, result: { number: "0x64", round: "0xc8", commitHash: "0xff" } },
    });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ height: 100, round: 200, commitHash: "0xff" });
    expect(feed.getLastCommit()).toBe(got[0]);

    off();
    // Teardown lingers briefly so React store resubscribes don't bounce
    // the socket; it closes once the zero-listener window persists.
    expect(ws.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.closed).toBe(true);
    expect(feed.getStatus().live).toBe(false);
  });

  it("keeps the socket open across a momentary resubscribe window", async () => {
    const feed = new LiveFeed("ws://node/ws", FakeWs as never);
    const off = feed.subscribe("newCommit", () => undefined);
    const ws = FakeWs.instances[0]!;
    ws.serverOpen();
    confirmSub(ws, 0);

    off();
    const offAgain = feed.subscribe("newCommit", () => undefined);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ws.closed).toBe(false);
    expect(FakeWs.instances).toHaveLength(1);
    offAgain();
  });

  it("shares the socket across topics and routes by subscription id", () => {
    const feed = new LiveFeed("ws://node/ws", FakeWs as never);
    const commits: number[] = [];
    const vertices: number[] = [];
    const offA = feed.subscribe("newCommit", (ev) => commits.push(ev.height));
    const offB = feed.subscribe("dagVertices", (ev) => vertices.push(ev.author));

    expect(FakeWs.instances).toHaveLength(1);
    const ws = FakeWs.instances[0]!;
    ws.serverOpen();
    expect(ws.sent).toHaveLength(2);
    const commitSub = confirmSub(ws, 0);
    const vertexSub = confirmSub(ws, 1);

    ws.serverMessage({
      jsonrpc: "2.0",
      method: "lyth_subscription",
      params: { subscription: vertexSub, result: { height: 4, round: 9, author: 1, vertexHash: "0xv" } },
    });
    ws.serverMessage({
      jsonrpc: "2.0",
      method: "lyth_subscription",
      params: { subscription: commitSub, result: { number: "0x4" } },
    });
    expect(vertices).toEqual([1]);
    expect(commits).toEqual([4]);

    offA();
    offB();
  });

  it("flags unavailable and reconnects with backoff after a drop", async () => {
    const feed = new LiveFeed("ws://node/ws", FakeWs as never);
    const off = feed.subscribe("newCommit", () => undefined);
    const first = FakeWs.instances[0]!;
    first.serverOpen();
    confirmSub(first, 0);
    expect(feed.getStatus().live).toBe(true);

    first.serverClose();
    expect(feed.getStatus().state).toBe("unavailable");
    expect(feed.getStatus().live).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWs.instances).toHaveLength(2);
    const second = FakeWs.instances[1]!;
    second.serverOpen();
    confirmSub(second, 0);
    expect(feed.getStatus().live).toBe(true);
    expect(feed.getStatus().attempts).toBe(0);

    off();
  });

  it("reports unavailable (graceful fallback) when no WS transport exists", () => {
    const feed = new LiveFeed("ws://node/ws", null);
    const off = feed.subscribe("newCommit", () => undefined);
    expect(feed.getStatus().state).toBe("unavailable");
    expect(feed.getStatus().live).toBe(false);
    off();
  });
});
