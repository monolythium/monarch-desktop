// Shared polling query cache — replaces the per-hook `setInterval`
// pattern. One entry per `method+args` key:
//
//   - DEDUPE: any number of components share one fetch loop per key.
//   - PAUSE: all loops stop while `document.hidden`; the moment the
//     window is visible again every watched key refreshes immediately.
//   - BACKOFF: transport errors double the retry delay (capped at 60s)
//     instead of hammering an unreachable endpoint forever.
//   - HONESTY: `notExposedWhen(err)` keeps the existing `notExposed`
//     semantics — gated/missing methods report a named blocker, never a
//     production-looking value — and `lastUpdatedAt` is always carried.

import { useCallback, useRef, useSyncExternalStore } from "react";

export type QuerySlice<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  notExposed: boolean;
  lastUpdatedAt: number | null;
};

export type QueryOptions = {
  /** Poll interval while healthy. Defaults to 5000ms. */
  intervalMs?: number;
  /** Map an error to the `notExposed` state instead of `error`. */
  notExposedWhen?: (err: unknown) => boolean;
};

export const DEFAULT_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_IDLE_ENTRIES = 256;

const EMPTY_SLICE: QuerySlice<unknown> = Object.freeze({
  data: null,
  loading: true,
  error: null,
  notExposed: false,
  lastUpdatedAt: null,
});

type Entry = {
  key: string;
  fetcher: () => Promise<unknown>;
  notExposedWhen: (err: unknown) => boolean;
  intervalMs: number;
  slice: QuerySlice<unknown>;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  failures: number;
};

export class QueryCache {
  private entries = new Map<string, Entry>();
  private hidden = false;

  /** Pause/resume every loop (wired to `visibilitychange` below). */
  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    for (const entry of this.entries.values()) {
      if (hidden) {
        this.clearTimer(entry);
      } else if (entry.listeners.size > 0) {
        this.run(entry);
      }
    }
  }

  isHidden(): boolean {
    return this.hidden;
  }

  getSlice<T>(key: string | null): QuerySlice<T> {
    if (key === null) return EMPTY_SLICE as QuerySlice<T>;
    return (this.entries.get(key)?.slice ?? EMPTY_SLICE) as QuerySlice<T>;
  }

  subscribe(
    key: string,
    fetcher: () => Promise<unknown>,
    options: QueryOptions | undefined,
    listener: () => void,
  ): () => void {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        fetcher,
        notExposedWhen: options?.notExposedWhen ?? (() => false),
        intervalMs: options?.intervalMs ?? DEFAULT_INTERVAL_MS,
        slice: EMPTY_SLICE,
        listeners: new Set(),
        timer: null,
        inFlight: false,
        failures: 0,
      };
      this.entries.set(key, entry);
      this.evictIdle();
    }
    // Always adopt the latest closures so args captured by the fetcher
    // stay current for the shared loop.
    entry.fetcher = fetcher;
    if (options?.notExposedWhen) entry.notExposedWhen = options.notExposedWhen;
    if (options?.intervalMs !== undefined) entry.intervalMs = options.intervalMs;

    entry.listeners.add(listener);
    if (entry.listeners.size === 1 && !entry.inFlight && entry.timer === null) {
      this.run(entry);
    }
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) this.clearTimer(entry);
    };
  }

  /** Force an immediate refetch of one key (no-op when unwatched). */
  invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.listeners.size === 0) return;
    this.clearTimer(entry);
    this.run(entry);
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  private evictIdle(): void {
    if (this.entries.size <= MAX_IDLE_ENTRIES) return;
    for (const [key, entry] of this.entries) {
      if (entry.listeners.size === 0 && entry.timer === null && !entry.inFlight) {
        this.entries.delete(key);
        if (this.entries.size <= MAX_IDLE_ENTRIES) return;
      }
    }
  }

  private setSlice(entry: Entry, slice: QuerySlice<unknown>): void {
    entry.slice = slice;
    for (const fn of entry.listeners) fn();
  }

  private schedule(entry: Entry): void {
    if (this.hidden || entry.listeners.size === 0 || entry.timer !== null) return;
    const delay =
      entry.failures > 0
        ? Math.min(entry.intervalMs * 2 ** Math.min(entry.failures, 4), MAX_BACKOFF_MS)
        : entry.intervalMs;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.run(entry);
    }, delay);
  }

  private run(entry: Entry): void {
    if (entry.inFlight || this.hidden) return;
    entry.inFlight = true;
    entry
      .fetcher()
      .then(
        (data) => {
          entry.failures = 0;
          this.setSlice(entry, {
            data,
            loading: false,
            error: null,
            notExposed: false,
            lastUpdatedAt: Date.now(),
          });
        },
        (err: unknown) => {
          if (entry.notExposedWhen(err)) {
            // Gated surface or absent target: a named blocker, not an
            // error, and not a reason to back off.
            entry.failures = 0;
            this.setSlice(entry, {
              data: null,
              loading: false,
              error: null,
              notExposed: true,
              lastUpdatedAt: Date.now(),
            });
            return;
          }
          entry.failures += 1;
          this.setSlice(entry, {
            ...entry.slice,
            loading: false,
            error: (err as Error)?.message ?? String(err),
            lastUpdatedAt: Date.now(),
          });
        },
      )
      .finally(() => {
        entry.inFlight = false;
        this.schedule(entry);
      });
  }
}

export const queryCache = new QueryCache();

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    queryCache.setHidden(document.hidden);
  });
  queryCache.setHidden(document.hidden);
}

/**
 * Subscribe a component to one cached query. `key` must encode the
 * method + args; pass `null` to disable (returns the empty slice).
 */
export function useQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options?: QueryOptions,
): QuerySlice<T> {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;

  const subscribe = useCallback(
    (cb: () => void) => {
      if (key === null) return () => undefined;
      return queryCache.subscribe(
        key,
        () => fetcherRef.current(),
        {
          intervalMs,
          notExposedWhen: (err) => optionsRef.current?.notExposedWhen?.(err) ?? false,
        },
        cb,
      );
    },
    [key, intervalMs],
  );

  return useSyncExternalStore(
    subscribe,
    () => queryCache.getSlice<T>(key),
    () => queryCache.getSlice<T>(key),
  );
}
