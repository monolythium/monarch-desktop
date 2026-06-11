import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INTERVAL_MS, QueryCache } from "./queryCache";

async function flushMicrotasks(): Promise<void> {
  // Settle promise chains queued by the cache's fetch pipeline.
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("QueryCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dedupes concurrent subscribers onto one fetch loop", async () => {
    const cache = new QueryCache();
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return Promise.resolve(calls);
    };
    const unsubA = cache.subscribe("k", fetcher, undefined, () => undefined);
    const unsubB = cache.subscribe("k", fetcher, undefined, () => undefined);
    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(cache.getSlice<number>("k").data).toBe(1);

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
    await flushMicrotasks();
    expect(calls).toBe(2);

    unsubA();
    unsubB();
  });

  it("stops polling when the last subscriber leaves", async () => {
    const cache = new QueryCache();
    let calls = 0;
    const unsub = cache.subscribe(
      "k",
      () => {
        calls += 1;
        return Promise.resolve(calls);
      },
      undefined,
      () => undefined,
    );
    await flushMicrotasks();
    unsub();
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS * 4);
    await flushMicrotasks();
    expect(calls).toBe(1);
  });

  it("maps notExposedWhen errors onto the notExposed slice without backoff", async () => {
    const cache = new QueryCache();
    const unsub = cache.subscribe(
      "k",
      () => Promise.reject({ code: -32601, message: "method not found" }),
      { notExposedWhen: (err) => (err as { code?: number }).code === -32601 },
      () => undefined,
    );
    await flushMicrotasks();
    const slice = cache.getSlice("k");
    expect(slice.notExposed).toBe(true);
    expect(slice.error).toBeNull();
    expect(slice.data).toBeNull();
    expect(slice.lastUpdatedAt).not.toBeNull();
    unsub();
  });

  it("backs off exponentially while the endpoint is unreachable", async () => {
    const cache = new QueryCache();
    let calls = 0;
    const unsub = cache.subscribe(
      "k",
      () => {
        calls += 1;
        return Promise.reject(new Error("connection refused"));
      },
      { intervalMs: 1000 },
      () => undefined,
    );
    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(cache.getSlice("k").error).toContain("connection refused");

    // First retry doubles to 2000ms — nothing fires at 1000ms.
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(calls).toBe(2);

    // Second retry doubles again to 4000ms.
    await vi.advanceTimersByTimeAsync(3999);
    await flushMicrotasks();
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(calls).toBe(3);
    unsub();
  });

  it("recovers the normal cadence after a success", async () => {
    const cache = new QueryCache();
    let failures = 1;
    let calls = 0;
    const unsub = cache.subscribe(
      "k",
      () => {
        calls += 1;
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error("offline"));
        }
        return Promise.resolve("ok");
      },
      { intervalMs: 1000 },
      () => undefined,
    );
    await flushMicrotasks();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2000); // backoff retry → success
    await flushMicrotasks();
    expect(calls).toBe(2);
    expect(cache.getSlice("k").data).toBe("ok");
    expect(cache.getSlice("k").error).toBeNull();
    await vi.advanceTimersByTimeAsync(1000); // back to base cadence
    await flushMicrotasks();
    expect(calls).toBe(3);
    unsub();
  });

  it("pauses while hidden and refreshes immediately on return", async () => {
    const cache = new QueryCache();
    let calls = 0;
    const unsub = cache.subscribe(
      "k",
      () => {
        calls += 1;
        return Promise.resolve(calls);
      },
      { intervalMs: 1000 },
      () => undefined,
    );
    await flushMicrotasks();
    expect(calls).toBe(1);

    cache.setHidden(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();
    expect(calls).toBe(1);

    cache.setHidden(false);
    await flushMicrotasks();
    expect(calls).toBe(2);
    unsub();
  });

  it("notifies subscribers on every slice change", async () => {
    const cache = new QueryCache();
    let notified = 0;
    const unsub = cache.subscribe(
      "k",
      () => Promise.resolve("v"),
      undefined,
      () => {
        notified += 1;
      },
    );
    await flushMicrotasks();
    expect(notified).toBe(1);
    unsub();
  });

  it("returns a stable empty slice for unknown keys", () => {
    const cache = new QueryCache();
    expect(cache.getSlice("missing")).toBe(cache.getSlice("missing"));
    expect(cache.getSlice(null).loading).toBe(true);
  });
});
