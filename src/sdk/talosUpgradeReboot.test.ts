import { describe, expect, it, vi } from "vitest";
import {
  awaitNodeReconnect,
  isUpgradeRebooting,
  UPGRADE_REBOOTING_MARKER,
} from "./talosUpgradeReboot";
import type { NodeProbeResult } from "./setupProbe";

function probe(
  outcome: NodeProbeResult["outcome"],
  chainId: number | null = null,
): NodeProbeResult {
  return {
    outcome,
    endpoint: "http://10.0.0.20:8545",
    chainId,
    blockNumber: null,
    synced: null,
    clientVersion: null,
    error: outcome === "unreachable" ? "down" : null,
  };
}

describe("isUpgradeRebooting", () => {
  it("recognises the native reboot marker as 'dispatched, rebooting'", () => {
    expect(isUpgradeRebooting(UPGRADE_REBOOTING_MARKER)).toBe(true);
    expect(
      isUpgradeRebooting(`${UPGRADE_REBOOTING_MARKER}\n(control connection dropped: transport error)`),
    ).toBe(true);
  });

  it("recognises the reboot phrasing even if relayed verbatim", () => {
    expect(isUpgradeRebooting("node is REBOOTING into the new image now")).toBe(true);
  });

  it("does not treat a normal accepted-upgrade response as rebooting", () => {
    expect(isUpgradeRebooting("node-1: upgrade accepted (actor 42)")).toBe(false);
    expect(isUpgradeRebooting("upgrade accepted")).toBe(false);
    expect(isUpgradeRebooting("")).toBe(false);
    expect(isUpgradeRebooting(null)).toBe(false);
  });
});

describe("awaitNodeReconnect", () => {
  const noSleep = async () => {};

  it("resolves reconnected once a rebooting node answers RPC again", async () => {
    // First few probes fail (still rebooting) then the node comes back. A node
    // that answers (even on a restricted eth_* profile -> outcome 'ok') is back.
    const results: NodeProbeResult[] = [
      probe("unreachable"),
      probe("unreachable"),
      probe("ok", 69420),
    ];
    let i = 0;
    const probeFn = vi.fn(async (): Promise<NodeProbeResult> => {
      const next = results[Math.min(i, results.length - 1)] ?? probe("ok", 69420);
      i += 1;
      return next;
    });

    const outcome = await awaitNodeReconnect("http://10.0.0.20:8545", {
      probe: probeFn,
      sleep: noSleep,
      initialDelayMs: 0,
      intervalMs: 1,
    });

    expect(outcome.reconnected).toBe(true);
    if (outcome.reconnected) {
      expect(outcome.probe.outcome).toBe("ok");
    }
    expect(probeFn).toHaveBeenCalledTimes(3);
  });

  it("treats a reachable-but-restricted node (no readable chain id) as back", async () => {
    const probeFn = vi.fn(async () => probe("ok", null));
    const outcome = await awaitNodeReconnect("http://10.0.0.20:8545", {
      probe: probeFn,
      sleep: noSleep,
      initialDelayMs: 0,
    });
    expect(outcome.reconnected).toBe(true);
  });

  it("gives up (reconnected:false) when the node never returns before the ceiling", async () => {
    const probeFn = vi.fn(async () => probe("unreachable"));
    const outcome = await awaitNodeReconnect("http://10.0.0.20:8545", {
      probe: probeFn,
      sleep: noSleep,
      initialDelayMs: 0,
      intervalMs: 10,
      ceilingMs: 25,
    });
    expect(outcome.reconnected).toBe(false);
    if (!outcome.reconnected) {
      expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("stops early when shouldContinue() flips to false (operator cancelled)", async () => {
    const probeFn = vi.fn(async () => probe("unreachable"));
    let allow = true;
    const outcome = await awaitNodeReconnect("http://10.0.0.20:8545", {
      probe: probeFn,
      sleep: noSleep,
      initialDelayMs: 0,
      shouldContinue: () => {
        const v = allow;
        allow = false; // allow exactly one attempt, then cancel
        return v;
      },
    });
    expect(outcome.reconnected).toBe(false);
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  it("never throws even if the probe itself rejects (transport during reboot)", async () => {
    let calls = 0;
    const probeFn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw new Error("transport error");
      return probe("ok", 69420);
    });
    const outcome = await awaitNodeReconnect("http://10.0.0.20:8545", {
      probe: probeFn,
      sleep: noSleep,
      initialDelayMs: 0,
      intervalMs: 1,
    });
    expect(outcome.reconnected).toBe(true);
  });
});
