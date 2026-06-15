// Post-upgrade reboot handling for the "Apply OS upgrade" flow.
//
// A Talos image upgrade ALWAYS reboots the node into the new image, so the
// `talosconfig`/gRPC control connection legitimately drops mid-call. The Rust
// `talos_upgrade` command (`src-tauri/src/talos.rs`) detects a post-dispatch
// transport drop and stamps `UPGRADE_REBOOTING_MARKER` into its output rather
// than surfacing a hard "transport error". The upgrade request was already
// dispatched to a node that was reachable when we connected — reporting a scary
// failure is wrong.
//
// This module owns:
//   * the marker constant (kept byte-identical to the Rust side),
//   * `isUpgradeRebooting` — does an upgrade result mean "dispatched, rebooting"?
//   * `awaitNodeReconnect` — poll the node back via the robust reachability
//     probe until it answers again, so the UI can confirm the upgrade landed.
//
// The Rust marker is the single source of truth; the regex below also matches
// the same idea in case a future transport relays the message verbatim.

import { probeNodeEndpoint, type NodeProbeResult } from "./setupProbe";

/** Must stay byte-identical to `UPGRADE_REBOOTING_MARKER` in `talos.rs`. */
export const UPGRADE_REBOOTING_MARKER =
  "upgrade dispatched: node is rebooting into the new image";

/**
 * True when the upgrade command's output signals the node accepted the upgrade
 * and is rebooting into the new image (the control connection dropped, which is
 * the expected, successful outcome of an image upgrade — not a failure).
 */
export function isUpgradeRebooting(output: string | null | undefined): boolean {
  if (!output) return false;
  const text = output.toLowerCase();
  return (
    text.includes(UPGRADE_REBOOTING_MARKER.toLowerCase()) ||
    text.includes("rebooting into the new image")
  );
}

export type ReconnectOutcome =
  | { reconnected: true; probe: NodeProbeResult }
  | { reconnected: false; elapsedMs: number };

export type AwaitReconnectOptions = {
  /** Don't probe before this — the node is mid-reboot. Default 8s. */
  initialDelayMs?: number;
  /** Stop polling after this. Default 6 minutes (a Talos upgrade + reboot). */
  ceilingMs?: number;
  /** Per-probe timeout. Default 5s. */
  probeTimeoutMs?: number;
  /** Starting poll interval, backed off up to `maxIntervalMs`. Default 5s. */
  intervalMs?: number;
  maxIntervalMs?: number;
  /** Cooperative cancel — return `false` to stop early. */
  shouldContinue?: () => boolean;
  /** Progress hook (attempt count, elapsed ms) for a live "reconnecting" UI. */
  onAttempt?: (attempt: number, elapsedMs: number) => void;
  /** Injectable for tests — defaults to the real reachability probe + timers. */
  probe?: (endpoint: string, timeoutMs: number) => Promise<NodeProbeResult>;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll a node that is rebooting into a new image until it answers RPC again.
 *
 * Uses the SAME robust reachability signal as the pre-check: any node that
 * answers (`outcome` of `ok` / `wrong-chain`, i.e. a reachable node — including
 * one with the `eth_*` namespace restricted) counts as back. Only a transport
 * failure keeps us waiting. Resolves `{ reconnected: false }` on cancel/timeout
 * rather than throwing — the caller decides how to render that.
 */
export async function awaitNodeReconnect(
  endpoint: string,
  opts: AwaitReconnectOptions = {},
): Promise<ReconnectOutcome> {
  const initialDelayMs = opts.initialDelayMs ?? 8_000;
  const ceilingMs = opts.ceilingMs ?? 360_000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 5_000;
  const maxIntervalMs = opts.maxIntervalMs ?? 15_000;
  let interval = opts.intervalMs ?? 5_000;
  const shouldContinue = opts.shouldContinue ?? (() => true);
  const sleep = opts.sleep ?? realSleep;
  const probe =
    opts.probe ?? ((ep, t) => probeNodeEndpoint(ep, { timeoutMs: t }));

  let elapsed = 0;
  let attempt = 0;

  // The node is mid-reboot — don't hammer it the instant the upgrade dispatched.
  await sleep(initialDelayMs);
  elapsed += initialDelayMs;

  while (shouldContinue() && elapsed < ceilingMs) {
    attempt += 1;
    opts.onAttempt?.(attempt, elapsed);
    try {
      const result = await probe(endpoint, probeTimeoutMs);
      // A reachable node — answered RPC, even if on a restricted profile or a
      // (transiently) unexpected chain — means it is back up on the new image.
      if (result.outcome === "ok" || result.outcome === "wrong-chain") {
        return { reconnected: true, probe: result };
      }
    } catch {
      // Still down / still rebooting — keep waiting.
    }
    if (!shouldContinue()) break;
    await sleep(interval);
    elapsed += interval;
    interval = Math.min(Math.round(interval * 1.3), maxIntervalMs);
  }

  return { reconnected: false, elapsedMs: elapsed };
}
