// `useLogStream(filter, target?)` bridges the Logs view to the native Talos API
// path for Monarch OS. Remote host streaming remains supported for internal
// diagnostics, but it is not part of the standard operator setup flow.
//
//   * `target` of `LOCAL_TARGET` is an explicit no-stream state. It
//     renders no fake log lines.
//
//   * `MONARCH_OS_TARGET` streams logs through the native Talos API
//     bridge (`talos_log_stream`) using the operator's stored
//     `talosconfig`.
//
// The Logs view applies its own filter and keyboard navigation over the
// returned `lines` array. Tear-down on target switch/view unmount cancels the
// active native stream so it stops emitting.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  inTauri,
  listenTalosLog,
  listenSshLog,
  sshConnect,
  sshExecCancel,
  sshExecStream,
  sshStatus,
  talosLogCancel,
  talosLogs,
  talosLogStream,
} from "./bridge";

/// One entry as the Logs view renders it. Remote streams are normalised
/// into this before they hit the buffer.
export type LogEntry = {
  ts: string;
  lvl: LogLevel;
  src: string;
  msg: string;
};

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

/// Log target descriptor. `(local)` is the sentinel that disables streaming.
export type LogTarget = {
  id: string;
  transport: "local" | "talos" | "ssh";
  /// Display label shown in the dropdown.
  label: string;
  /// Hostname / IPv4. Empty for the local sentinel.
  host: string;
  /// Remote user, used only for optional host targets.
  user: string;
  /// Path to the private key file for optional host targets.
  keyPath: string;
};

/// Sentinel for "do not stream". Lifted into a constant so component
/// code can compare without re-deriving the id.
export const LOCAL_TARGET: LogTarget = {
  id: "(local)",
  transport: "local",
  label: "(no stream)",
  host: "",
  user: "",
  keyPath: "",
};

export const MONARCH_OS_TARGET: LogTarget = {
  id: "monarch-os",
  transport: "talos",
  label: "Monarch OS · Talos",
  host: "",
  user: "",
  keyPath: "",
};

/// Optional remote host targets. Empty for standard operator installs.
export const TESTNET_TARGETS: LogTarget[] = [];

export const ALL_TARGETS: LogTarget[] = [
  MONARCH_OS_TARGET,
  ...TESTNET_TARGETS,
  LOCAL_TARGET,
];

const BUFFER_LIMIT = 1024;

/// Connection / streaming state surfaced to the view. The Logs header
/// renders a halo from this so operators can tell whether they're
/// looking at a live tail.
export type StreamStatus =
  | { kind: "local" }
  | { kind: "talos-streaming"; target: LogTarget; sessionId: number }
  | { kind: "connecting"; target: LogTarget }
  | { kind: "streaming"; target: LogTarget; sessionId: number }
  | { kind: "error"; target: LogTarget; error: string }
  | { kind: "ended"; target: LogTarget };

/// Module-level cache of the currently-connected target. The Rust side
/// only holds one session at a time today; we mirror that here so the
/// hook avoids redundant `ssh_connect` round-trips on rapid target
/// flips.
let activeTargetId: string | null = null;

async function ensureConnected(target: LogTarget): Promise<void> {
  if (!inTauri()) {
    // Browser preview — pretend we connected so the rest of the hook
    // stays linear.
    activeTargetId = target.id;
    return;
  }
  if (activeTargetId === target.id) {
    // Even if we believe we're connected, double-check Rust side
    // didn't drop the session (e.g. operator host rebooted).
    const status = await sshStatus();
    if (status.connected && status.host === target.host) {
      return;
    }
  }
  await sshConnect({
    host: target.host,
    user: target.user,
    keyPath: target.keyPath,
  });
  activeTargetId = target.id;
}

/// Map journald PRIORITY (RFC-5424 syslog levels) to the four pill
/// classes the Logs view recognises. Levels 0-3 are bad enough to
/// surface as ERROR; 4 is WARN; 6 is INFO; 7 is DEBUG; everything else
/// degrades to INFO so we don't drop lines silently.
function priorityToLevel(priority: string | number | undefined): LogLevel {
  const n =
    typeof priority === "number"
      ? priority
      : typeof priority === "string"
        ? Number.parseInt(priority, 10)
        : Number.NaN;
  if (Number.isNaN(n)) return "INFO";
  if (n <= 3) return "ERROR";
  if (n === 4) return "WARN";
  if (n === 7) return "DEBUG";
  return "INFO";
}

/// Format a journald `__REALTIME_TIMESTAMP` (microseconds since epoch
/// as a string) into the UI's `HH:MM:SS.mmm` shape.
function formatTimestamp(realtimeUs: string | undefined): string {
  if (!realtimeUs) return "--:--:--.---";
  const us = Number.parseInt(realtimeUs, 10);
  if (!Number.isFinite(us)) return "--:--:--.---";
  const ms = Math.floor(us / 1000);
  const date = new Date(ms);
  const hh = date.getUTCHours().toString().padStart(2, "0");
  const mm = date.getUTCMinutes().toString().padStart(2, "0");
  const ss = date.getUTCSeconds().toString().padStart(2, "0");
  const mss = date.getUTCMilliseconds().toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${mss}`;
}

type JournaldEntry = {
  __REALTIME_TIMESTAMP?: string;
  MESSAGE?: string | string[];
  PRIORITY?: string | number;
  SYSLOG_IDENTIFIER?: string;
  _SYSTEMD_UNIT?: string;
  _COMM?: string;
};

/// Parse one stream line into a `LogEntry`. Empty journald payloads are
/// ignored so the UI does not fill with placeholder rows.
export function parseJournaldLine(raw: string): LogEntry | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let entry: JournaldEntry;
  try {
    entry = JSON.parse(trimmed) as JournaldEntry;
  } catch {
    return {
      ts: "--:--:--.---",
      lvl: "INFO",
      src: "raw",
      msg: trimmed.slice(0, 512),
    };
  }
  const message = Array.isArray(entry.MESSAGE)
    ? entry.MESSAGE.join("\n")
    : (entry.MESSAGE ?? "");
  if (!message.trim()) return null;
  const src =
    entry.SYSLOG_IDENTIFIER ??
    entry._SYSTEMD_UNIT?.replace(/\.service$/, "") ??
    entry._COMM ??
    "node";
  return {
    ts: formatTimestamp(entry.__REALTIME_TIMESTAMP),
    lvl: priorityToLevel(entry.PRIORITY),
    src,
    msg: message.trim(),
  };
}

/// Hook return shape. Keeping it small; the view applies its own regex
/// + vim navigation on `lines`.
export type LogStream = {
  lines: LogEntry[];
  status: StreamStatus;
};

/**
 * `filter` is a hint, not a constraint — the view still applies its
 * own regex / level pills over the returned `lines`. The hook accepts
 * it so future server-side filtering (e.g. journalctl `--grep=`) can
 * land without changing every call site.
 */
export function useLogStream(filter: string, target: LogTarget): LogStream {
  // `filter` is currently view-local; reading it ensures React tracks
  // it for stable hook semantics if we ever push filtering down to
  // journalctl `--grep=`.
  void filter;

  const [lines, setLines] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<StreamStatus>(
    target.id === LOCAL_TARGET.id
      ? { kind: "local" }
      : { kind: "connecting", target },
  );

  // Keep a ref alive to avoid stale-closure pushes after unmount. The
  // ref also lets `pushLine` enforce the 1024-line FIFO without
  // dragging the whole list through `setLines` every tick.
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (target.id === LOCAL_TARGET.id) {
      setStatus({ kind: "local" });
      setLines([]);
      return;
    }

    if (target.transport === "talos") {
      setStatus({ kind: "connecting", target });
      setLines([]);
      let unlisten: (() => void) | null = null;
      let sessionId: number | null = null;
      let cancelled = false;

      (async () => {
        try {
          // Prime the panel with a one-shot tail BEFORE following. The follow
          // stream only emits lines the node writes after the session opens, so
          // a healthy-but-quiet node would otherwise leave the panel stuck on
          // "Connected. Waiting for logs". The synchronous `talos_logs` tail
          // (same Talos Logs API, non-follow) fills in the recent history
          // immediately; the follow session below then appends new lines.
          try {
            const snapshot = await talosLogs("ext-protocore", BUFFER_LIMIT);
            if (!cancelled && aliveRef.current && snapshot.output) {
              const seeded = snapshot.output
                .split("\n")
                .map((raw) => parseJournaldLine(raw))
                .filter((entry): entry is LogEntry => entry !== null);
              if (seeded.length > 0) {
                setLines(seeded.slice(-BUFFER_LIMIT));
              }
            }
          } catch {
            // Non-fatal: priming is best-effort. If the one-shot tail is
            // unavailable the follow stream below still drives the panel.
          }
          if (cancelled) return;

          const requestedId = Date.now() + Math.floor(Math.random() * 10_000);
          unlisten = await listenTalosLog(
            requestedId,
            (raw) => {
              if (!aliveRef.current || cancelled) return;
              const parsed = parseJournaldLine(raw);
              if (!parsed) return;
              setLines((prev) => {
                const next =
                  prev.length >= BUFFER_LIMIT
                    ? prev.slice(prev.length - BUFFER_LIMIT + 1)
                    : prev.slice();
                next.push(parsed);
                return next;
              });
            },
            () => {
              if (!aliveRef.current || cancelled) return;
              setStatus({ kind: "ended", target });
            },
            (message) => {
              if (!aliveRef.current || cancelled) return;
              setStatus({ kind: "error", target, error: message });
            },
          );
          // Small follow tail: the one-shot prime already showed recent
          // history, so the follow session only needs to pick up new lines (a
          // couple of overlap lines at the seam is harmless).
          const id = await talosLogStream("ext-protocore", 2, requestedId);
          if (cancelled) {
            await talosLogCancel(id).catch(() => undefined);
            return;
          }
          sessionId = id;
          setStatus({ kind: "talos-streaming", target, sessionId: id });
        } catch (err) {
          if (cancelled || !aliveRef.current) return;
          unlisten?.();
          const msg = (err as Error)?.message ?? String(err);
          setStatus({ kind: "error", target, error: msg });
        }
      })();

      return () => {
        cancelled = true;
        unlisten?.();
        if (sessionId !== null) {
          talosLogCancel(sessionId).catch(() => undefined);
        }
      };
    }

    setStatus({ kind: "connecting", target });
    setLines([]);

    let unlisten: (() => void) | null = null;
    let sessionId: number | null = null;
    let cancelled = false;

    (async () => {
      try {
        await ensureConnected(target);
        if (cancelled) return;
        const id = await sshExecStream(
          "journalctl -fu monod --output=json --no-pager",
        );
        if (cancelled) {
          await sshExecCancel(id).catch(() => undefined);
          return;
        }
        sessionId = id;
        setStatus({ kind: "streaming", target, sessionId: id });
        unlisten = await listenSshLog(
          id,
          (raw) => {
            if (!aliveRef.current || cancelled) return;
            const parsed = parseJournaldLine(raw);
            if (!parsed) return;
            setLines((prev) => {
              const next =
                prev.length >= BUFFER_LIMIT
                  ? prev.slice(prev.length - BUFFER_LIMIT + 1)
                  : prev.slice();
              next.push(parsed);
              return next;
            });
          },
          () => {
            if (!aliveRef.current || cancelled) return;
            setStatus({ kind: "ended", target });
          },
        );
      } catch (err) {
        if (cancelled || !aliveRef.current) return;
        const msg = (err as Error)?.message ?? String(err);
        setStatus({ kind: "error", target, error: msg });
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      if (sessionId !== null) {
        sshExecCancel(sessionId).catch(() => undefined);
      }
    };
    // We re-run when the target id flips. Re-running on host/user
    // edits to the *same* id would be surprising — the dropdown today
    // doesn't allow such edits — and the lint suppression keeps the
    // hook from churning the buffer on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id]);

  return useMemo(() => ({ lines, status }), [lines, status]);
}
