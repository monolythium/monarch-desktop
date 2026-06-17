// Confirm-by-landed-commit tracking for the "Apply OS upgrade" flow.
//
// `awaitNodeReconnect` (talosUpgradeReboot.ts) only answers "is the node
// reachable again?" — NOT "did it land the NEW build?". After a Talos A/B image
// upgrade the node legitimately reboots, reconverges its controlplane, and
// catches up; during that ~20-min window it answers RPC while STILL reporting
// the OLD git commit. Confirming on reachability alone makes the operator think
// the upgrade failed.
//
// This module owns the confirm step: after reconnect, poll the node's running
// git commit (lyth_runtimeProvenance → `runtime.gitCommit`) and compare it to
// the target release's `monoCoreCommit`. It is deliberately split into:
//   * `resolveOtaConfirmState` — a PURE state machine (commit reading + elapsed
//     time → one of confirmed / keep-polling / stuck / reachable-unconfirmed),
//     unit-tested with no timers or RPC,
//   * `awaitOtaCommitConfirm` — the thin runner that drives the poll loop using
//     an injectable provenance reader + sleeper.
//
// HONESTY: we never claim success on an unconfirmed/indeterminate state. A node
// that is reachable but whose commit we can't read past the deadline is a SOFT
// success ("reachable, commit unconfirmed"), never a red error; a node that
// stays on the OLD commit past the deadline is a NON-terminal "not confirmed"
// with a Retry, never a failure.

import { commitMatches, shortCommit } from "./protocoreRelease";

/** A single provenance read result for the confirm poll: the node's running git
 *  commit when readable, or a flag that the read itself failed (transport down
 *  mid-reboot, or `lyth_runtimeProvenance` gated / -32601 on a restricted
 *  profile). The two are genuinely different — only the former lets us compare. */
export type ProvenanceReadResult =
  | { readable: true; gitCommit: string | null }
  | { readable: false };

/** Discriminated outcome of one confirm-state evaluation. */
export type OtaConfirmState =
  /** The node's running commit matches the target — the upgrade landed. */
  | { kind: "confirmed"; nodeCommit: string; targetCommit: string }
  /** Not yet conclusive — keep polling (still rebooting / catching up, or the
   *  commit is readable but still the old one and the deadline isn't reached).
   *  `hint` carries the "taking longer than usual" nudge once past `slowAtMs`. */
  | { kind: "keep-polling"; hint: "none" | "slow"; lastCommit: string | null }
  /** Past the deadline with the commit READABLE and still != target. The node
   *  is up but did not move onto the new build — NON-terminal, offer a retry. */
  | { kind: "stuck"; nodeCommit: string; targetCommit: string }
  /** Past the deadline, node answers, but provenance was never readable
   *  (method gated / -32601 / restricted profile). SOFT/indeterminate — never
   *  red; the operator just can't see the commit to confirm. */
  | { kind: "reachable-unconfirmed"; targetCommit: string };

export type ResolveOtaConfirmInput = {
  /** The latest provenance read. */
  read: ProvenanceReadResult;
  /** The release's target commit (any length/case — normalized internally). */
  targetCommit: string | null | undefined;
  /** Elapsed ms since the upgrade dispatched (NOT since reconnect) — the
   *  deadline is measured against the whole upgrade window. */
  elapsedMs: number;
  /** Whether the commit has been readable at least once this run. Lets the
   *  deadline branch tell "stuck on old commit" from "never readable". */
  everReadable: boolean;
  /** Deadline after which an unmatched commit is `stuck` /
   *  `reachable-unconfirmed`. Default 30 min (dispatch → confirm). */
  deadlineMs?: number;
  /** When to start surfacing the "taking longer than usual" hint. Default 10 min. */
  slowAtMs?: number;
};

export const DEFAULT_CONFIRM_DEADLINE_MS = 30 * 60_000;
export const DEFAULT_CONFIRM_SLOW_HINT_MS = 10 * 60_000;

/**
 * Pure confirm-state resolver. Given one provenance read, the target commit, and
 * how long the upgrade has been running, decide what the UI should show. Never
 * false-fails: a missing target or an unreadable commit before the deadline is
 * `keep-polling`, not an error.
 */
export function resolveOtaConfirmState(input: ResolveOtaConfirmInput): OtaConfirmState {
  const deadlineMs = input.deadlineMs ?? DEFAULT_CONFIRM_DEADLINE_MS;
  const slowAtMs = input.slowAtMs ?? DEFAULT_CONFIRM_SLOW_HINT_MS;
  const target = shortCommit(input.targetCommit);

  // No target commit to compare against — we can never confirm, so don't pretend
  // to. Treat the same as "commit unconfirmed": keep polling until the deadline,
  // then a soft reachable-unconfirmed (the node is up; we just can't verify).
  const nodeCommit = input.read.readable ? shortCommit(input.read.gitCommit) : null;

  if (target && nodeCommit && commitMatches(nodeCommit, target)) {
    return { kind: "confirmed", nodeCommit, targetCommit: target };
  }

  const pastDeadline = input.elapsedMs >= deadlineMs;
  if (pastDeadline) {
    // Readable + still on the old (or a different) commit → stuck, offer retry.
    // The CURRENT read being readable is authoritative; otherwise fall back to
    // "was it ever readable on a known commit?" so a transient unreadable read
    // at the exact deadline doesn't downgrade a genuinely-stuck node.
    if (target && nodeCommit) {
      return { kind: "stuck", nodeCommit, targetCommit: target };
    }
    if (target && input.everReadable) {
      // We could read it on a different build earlier but not right now — still
      // a "did not land the new build" situation; offer retry with the target.
      return { kind: "stuck", nodeCommit: "", targetCommit: target };
    }
    // Provenance never became readable though the node answers (or we have no
    // target to compare) → soft, indeterminate success. Never red.
    return { kind: "reachable-unconfirmed", targetCommit: target ?? "" };
  }

  // Before the deadline: keep waiting. Surface the "taking longer" nudge once we
  // cross the slow threshold so the operator knows it's still working.
  return {
    kind: "keep-polling",
    hint: input.elapsedMs >= slowAtMs ? "slow" : "none",
    lastCommit: nodeCommit,
  };
}

export type AwaitOtaConfirmOptions = {
  /** Reads the node's provenance. Resolve with the git commit (or `null`) when
   *  the call succeeds; REJECT (or resolve `{ readable: false }`) when it fails
   *  — both are treated as "not readable, keep polling". Injectable for tests. */
  readProvenance: () => Promise<ProvenanceReadResult>;
  /** Don't read before this — the node is mid-reboot. Default 0 (the caller
   *  already waited out the reboot via `awaitNodeReconnect`). */
  initialDelayMs?: number;
  /** Poll interval. Default 12s. */
  intervalMs?: number;
  /** Deadline (dispatch → confirm). Default 30 min. */
  deadlineMs?: number;
  /** "Taking longer than usual" threshold. Default 10 min. */
  slowAtMs?: number;
  /** Ms already elapsed before this run started (the reconnect window). Counts
   *  toward the deadline so a slow reconnect doesn't get a fresh 30 min. */
  startElapsedMs?: number;
  /** Cooperative cancel — return `false` to stop early (drawer closed / cancelled). */
  shouldContinue?: () => boolean;
  /** Per-evaluation progress hook for a live confirming UI. */
  onState?: (state: OtaConfirmState, elapsedMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Drive the confirm-by-commit poll after the node has reconnected. Reads
 * provenance every `intervalMs`, runs {@link resolveOtaConfirmState}, and
 * resolves the first time the state is terminal (`confirmed`, `stuck`, or
 * `reachable-unconfirmed`) or when cancelled. Never throws — a failed read is a
 * non-readable poll, not an error. The whole window is bounded by `deadlineMs`.
 */
export async function awaitOtaCommitConfirm(
  targetCommit: string | null | undefined,
  opts: AwaitOtaConfirmOptions,
): Promise<OtaConfirmState> {
  const initialDelayMs = opts.initialDelayMs ?? 0;
  const intervalMs = opts.intervalMs ?? 12_000;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_CONFIRM_DEADLINE_MS;
  const slowAtMs = opts.slowAtMs ?? DEFAULT_CONFIRM_SLOW_HINT_MS;
  const shouldContinue = opts.shouldContinue ?? (() => true);
  const sleep = opts.sleep ?? realSleep;

  let elapsed = opts.startElapsedMs ?? 0;
  let everReadable = false;
  let lastState: OtaConfirmState = { kind: "keep-polling", hint: "none", lastCommit: null };

  if (initialDelayMs > 0) {
    await sleep(initialDelayMs);
    elapsed += initialDelayMs;
  }

  while (shouldContinue()) {
    let read: ProvenanceReadResult;
    try {
      read = await opts.readProvenance();
    } catch {
      read = { readable: false };
    }
    if (read.readable) everReadable = true;

    const state = resolveOtaConfirmState({
      read,
      targetCommit,
      elapsedMs: elapsed,
      everReadable,
      deadlineMs,
      slowAtMs,
    });
    lastState = state;
    opts.onState?.(state, elapsed);

    if (state.kind !== "keep-polling") return state;
    if (!shouldContinue()) break;

    await sleep(intervalMs);
    elapsed += intervalMs;
  }

  return lastState;
}
