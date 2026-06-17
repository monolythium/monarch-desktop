import { describe, expect, it, vi } from "vitest";
import {
  awaitOtaCommitConfirm,
  DEFAULT_CONFIRM_DEADLINE_MS,
  resolveOtaConfirmState,
  type ProvenanceReadResult,
} from "./otaConfirm";

const TARGET_FULL = "45743855AAAA1111deadbeefcafef00d12345678"; // 40-hex, mixed case
const TARGET_12 = "45743855aaaa"; // normalized first-12
const OLD_FULL = "a40ea06ebbbb2222ffffffffffffffffffffffff"; // a different build

function readable(gitCommit: string | null): ProvenanceReadResult {
  return { readable: true, gitCommit };
}
const unreadable: ProvenanceReadResult = { readable: false };

describe("resolveOtaConfirmState", () => {
  it("confirms when the running commit matches the target (40-hex vs 12-hex, case-insensitive)", () => {
    const state = resolveOtaConfirmState({
      read: readable(TARGET_FULL),
      targetCommit: TARGET_12,
      elapsedMs: 30_000,
      everReadable: true,
    });
    expect(state.kind).toBe("confirmed");
    if (state.kind === "confirmed") {
      expect(state.nodeCommit).toBe(TARGET_12);
      expect(state.targetCommit).toBe(TARGET_12);
    }
  });

  it("keeps polling while the commit is readable but still the OLD build, before the deadline", () => {
    const state = resolveOtaConfirmState({
      read: readable(OLD_FULL),
      targetCommit: TARGET_FULL,
      elapsedMs: 60_000,
      everReadable: true,
    });
    expect(state.kind).toBe("keep-polling");
    if (state.kind === "keep-polling") {
      expect(state.hint).toBe("none");
      expect(state.lastCommit).toBe(OLD_FULL.slice(0, 12));
    }
  });

  it("keeps polling while the node is unreachable (still rebooting), before the deadline", () => {
    const state = resolveOtaConfirmState({
      read: unreadable,
      targetCommit: TARGET_FULL,
      elapsedMs: 5_000,
      everReadable: false,
    });
    expect(state).toMatchObject({ kind: "keep-polling", hint: "none", lastCommit: null });
  });

  it("surfaces the 'slow' hint once past the slow threshold (still keep-polling)", () => {
    const state = resolveOtaConfirmState({
      read: readable(OLD_FULL),
      targetCommit: TARGET_FULL,
      elapsedMs: 11 * 60_000, // > default 10-min slow threshold
      everReadable: true,
    });
    expect(state).toMatchObject({ kind: "keep-polling", hint: "slow" });
  });

  it("reports STUCK past the deadline when the commit is readable and still != target", () => {
    const state = resolveOtaConfirmState({
      read: readable(OLD_FULL),
      targetCommit: TARGET_FULL,
      elapsedMs: DEFAULT_CONFIRM_DEADLINE_MS,
      everReadable: true,
    });
    expect(state.kind).toBe("stuck");
    if (state.kind === "stuck") {
      expect(state.nodeCommit).toBe(OLD_FULL.slice(0, 12));
      expect(state.targetCommit).toBe(TARGET_12);
    }
  });

  it("reports REACHABLE-UNCONFIRMED past the deadline when provenance was never readable", () => {
    const state = resolveOtaConfirmState({
      read: unreadable,
      targetCommit: TARGET_FULL,
      elapsedMs: DEFAULT_CONFIRM_DEADLINE_MS + 1,
      everReadable: false,
    });
    expect(state.kind).toBe("reachable-unconfirmed");
    if (state.kind === "reachable-unconfirmed") {
      expect(state.targetCommit).toBe(TARGET_12);
    }
  });

  it("never CONFIRMS without a target — soft reachable-unconfirmed past the deadline", () => {
    // No target to compare → can't ever confirm; a readable commit past the
    // deadline is still indeterminate, never a false success and never red.
    const state = resolveOtaConfirmState({
      read: readable(OLD_FULL),
      targetCommit: null,
      elapsedMs: DEFAULT_CONFIRM_DEADLINE_MS,
      everReadable: true,
    });
    // Readable + a target present would be `stuck`; without a target it is the
    // soft branch (we have nothing to call "stuck on the old build" against).
    expect(state.kind).toBe("reachable-unconfirmed");
  });
});

describe("awaitOtaCommitConfirm", () => {
  const noSleep = async () => {};

  it("resolves CONFIRMED the first poll the running commit matches the target", async () => {
    // First two reads are the old build, then the node flips to the target.
    const reads: ProvenanceReadResult[] = [
      readable(OLD_FULL),
      unreadable,
      readable(TARGET_FULL),
    ];
    let i = 0;
    const readProvenance = vi.fn(async () => reads[Math.min(i++, reads.length - 1)]!);

    const final = await awaitOtaCommitConfirm(TARGET_12, {
      readProvenance,
      sleep: noSleep,
      intervalMs: 1,
    });
    expect(final.kind).toBe("confirmed");
    expect(readProvenance).toHaveBeenCalledTimes(3);
  });

  it("does NOT false-fail on a read that rejects — it keeps polling", async () => {
    let calls = 0;
    const readProvenance = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("transport error during reboot");
      return readable(TARGET_FULL);
    });
    const final = await awaitOtaCommitConfirm(TARGET_FULL, {
      readProvenance,
      sleep: noSleep,
      intervalMs: 1,
    });
    expect(final.kind).toBe("confirmed");
    expect(calls).toBe(3);
  });

  it("resolves STUCK once the deadline passes with the node still on the old build", async () => {
    const readProvenance = vi.fn(async () => readable(OLD_FULL));
    const final = await awaitOtaCommitConfirm(TARGET_FULL, {
      readProvenance,
      sleep: noSleep,
      intervalMs: 10,
      deadlineMs: 25,
    });
    expect(final.kind).toBe("stuck");
  });

  it("resolves REACHABLE-UNCONFIRMED when provenance is never readable past the deadline", async () => {
    const readProvenance = vi.fn(async () => unreadable);
    const final = await awaitOtaCommitConfirm(TARGET_FULL, {
      readProvenance,
      sleep: noSleep,
      intervalMs: 10,
      deadlineMs: 25,
    });
    expect(final.kind).toBe("reachable-unconfirmed");
  });

  it("stops early (last keep-polling state) when shouldContinue flips to false", async () => {
    const readProvenance = vi.fn(async () => readable(OLD_FULL));
    let allow = true;
    const final = await awaitOtaCommitConfirm(TARGET_FULL, {
      readProvenance,
      sleep: noSleep,
      intervalMs: 1,
      shouldContinue: () => {
        const v = allow;
        allow = false;
        return v;
      },
    });
    expect(final.kind).toBe("keep-polling");
    expect(readProvenance).toHaveBeenCalledTimes(1);
  });
});
