// READ-ONLY node-status feed for the in-app header.
//
// Surfaces the at-a-glance fields the Talos console/VNC dashboard shows — Stage,
// health/ready, hostname, Talos version, uptime, node addresses, and the key
// service states (`ext-protocore`, `kubelet`) — pulled over Talos *read* RPCs
// only (`talos_node_status`, src-tauri/src/talos.rs). Nothing here controls the
// node: no service action, no config patch, no upgrade/reboot/wipe.
//
// Distinct from `useNodeStatus` (chain-RPC: height/round/sync). This is the OS
// side: "is the box up, on which Talos build, with which services running".
//
// The hook is self-contained (its own poll, gated on `inTauri()` + a Talos log
// target) rather than going through the shared queryCache, so the `pnpm dev`
// browser preview renders the unavailable state without a per-poll error and
// without fabricating node data. Every field degrades to null/empty — the
// header then shows a subtle "—", never a red error for a missing field.

import { useCallback, useEffect, useRef, useState } from "react";
import { inTauri, talosNodeStatus, type TalosNodeStatus } from "./bridge";

/** Default header poll cadence. The dashboard fields move slowly (stage, version,
 *  uptime), so a ~12s poll keeps it live without hammering the node. */
export const NODE_STATUS_POLL_MS = 12_000;

/** Coarse tone for a value, matching the app's halo severity vocabulary. */
export type NodeStatusTone = "ok" | "warn" | "err" | "info" | "muted";

/**
 * Format an uptime in seconds as a compact, human-readable string
 * (e.g. `3d 4h`, `12m`, `45s`). Pure. Returns "—" for null/negative/non-finite
 * so the header never shows a bogus duration.
 */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;

  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);

  // Two most-significant non-zero units, largest first.
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  // All-zero above 60s can't happen, but guard anyway.
  return parts.slice(0, 2).join(" ") || `${total}s`;
}

/**
 * Tone for a machine stage label. "Running" is healthy; transient stages
 * (Booting/Installing/Upgrading/Rebooting) are info; teardown stages
 * (Shutting down/Resetting) and Unknown/Maintenance warn. Pure; case-insensitive
 * and resilient to an unmapped label (→ "muted").
 */
export function stageTone(stage: string | null | undefined): NodeStatusTone {
  if (!stage) return "muted";
  const s = stage.trim().toLowerCase();
  if (s === "running") return "ok";
  if (
    s === "booting" ||
    s === "installing" ||
    s === "upgrading" ||
    s === "rebooting"
  ) {
    return "info";
  }
  if (
    s === "shutting down" ||
    s === "resetting" ||
    s === "maintenance" ||
    s === "unknown"
  ) {
    return "warn";
  }
  return "muted";
}

/**
 * Coarse health verdict from `ready` + the unmet-condition count. Pure.
 *   * ready === true            → ok / "Healthy"
 *   * ready === false           → warn / "Not ready (n)" (n = unmet conditions)
 *   * ready === null (no event) → muted / "—"
 */
export function readyView(
  ready: boolean | null | undefined,
  unmetConditions: readonly string[] = [],
): { tone: NodeStatusTone; label: string } {
  if (ready === true) return { tone: "ok", label: "Healthy" };
  if (ready === false) {
    const n = unmetConditions.length;
    return { tone: "warn", label: n > 0 ? `Not ready (${n})` : "Not ready" };
  }
  return { tone: "muted", label: "—" };
}

/**
 * Map a key-service severity to a header tone. Mirrors the Rust summariser's
 * severity vocabulary ("ok"/"warn"/"err"/"info"); anything else → muted.
 */
export function serviceTone(severity: string | null | undefined): NodeStatusTone {
  switch (severity) {
    case "ok":
      return "ok";
    case "warn":
      return "warn";
    case "err":
      return "err";
    case "info":
      return "info";
    default:
      return "muted";
  }
}

/** Live, read-only view of the node-status header feed. */
export type TalosNodeStatusSlice = {
  data: TalosNodeStatus | null;
  loading: boolean;
  /** A real read failure (only set when inside Tauri and the RPC failed). */
  error: string | null;
  /** True outside Tauri / when no Talos target is active — the header then
   *  renders an "unavailable" placeholder rather than an error. */
  unavailable: boolean;
  lastUpdatedAt: number | null;
  /** Force an immediate re-read (e.g. a manual "Refresh" affordance). */
  refresh: () => void;
};

/**
 * Poll the READ-ONLY Talos node-status snapshot. Self-contained: gates on
 * `inTauri()` and (optionally) on a `talos`-transport target being active, so
 * the browser preview and the local-only log target both render the unavailable
 * placeholder without erroring.
 *
 * @param options.active  When false, the hook idles in the unavailable state
 *   (e.g. the Logs view isn't pointed at a Monarch OS node). Defaults to true.
 * @param options.intervalMs  Poll cadence; defaults to {@link NODE_STATUS_POLL_MS}.
 */
export function useTalosNodeStatus(options?: {
  active?: boolean;
  intervalMs?: number;
}): TalosNodeStatusSlice {
  const active = options?.active ?? true;
  const intervalMs = options?.intervalMs ?? NODE_STATUS_POLL_MS;
  const enabled = active && inTauri();

  const [data, setData] = useState<TalosNodeStatus | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  // Bumped by `refresh()` to re-arm the effect immediately.
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) {
      setData(null);
      setError(null);
      setLoading(false);
      return () => {
        mounted.current = false;
      };
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      setLoading((prev) => prev && data === null);
      try {
        const next = await talosNodeStatus();
        if (cancelled || !mounted.current) return;
        setData(next);
        setError(null);
        setLastUpdatedAt(Date.now());
      } catch (err) {
        if (cancelled || !mounted.current) return;
        // Keep the last good snapshot on a transient failure; the header dims
        // rather than blanking. The error is surfaced for the small status dot.
        setError((err as Error)?.message ?? String(err));
      } finally {
        if (!cancelled && mounted.current) {
          setLoading(false);
          timer = setTimeout(() => void tick(), intervalMs);
        }
      }
    };

    void tick();

    return () => {
      cancelled = true;
      mounted.current = false;
      if (timer) clearTimeout(timer);
    };
    // Intentionally NOT depending on `data`: it's read inside `tick` only for
    // the loading heuristic and re-arming the effect on every snapshot would
    // restart the poll loop. `nonce` re-arms an immediate poll on manual
    // refresh; `enabled`/`intervalMs` are the real inputs.
  }, [enabled, intervalMs, nonce]);

  return {
    data,
    loading,
    error,
    unavailable: !enabled,
    lastUpdatedAt,
    refresh,
  };
}
