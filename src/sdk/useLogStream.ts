// `useLogStream(filter, target?)` — bridges the Logs view to either
// the native Talos API path for Monarch OS or the russh development
// bridge for plain Linux hosts.
//
//   * `target` of `LOCAL_TARGET` is an explicit no-stream state. It
//     renders no fake log lines.
//
//   * `MONARCH_OS_TARGET` streams logs through the native Talos API
//     bridge (`talos_log_stream`) using the operator's stored
//     `talosconfig`.
//
//   * Any `ssh` target triggers a Tauri-side `ssh_exec_stream`
//     for `journalctl -fu monod --output=json`. We listen for
//     `monarch://ssh-log/<sessionId>` events, parse each journald
//     entry, and push it into a FIFO buffer of size `BUFFER_LIMIT`.
//     The Logs view applies its own regex / vim-key UX over the
//     returned `lines` array.
//
// `monod` is the systemd unit name on the development operator hosts
// (see `the internal testnet-infra runbook`).
//
// Tear-down on target switch / view unmount calls `ssh_exec_cancel`
// so the Rust task drops the channel and stops emitting.

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

/// SSH target descriptor. `id` is the dropdown key + Rust session
/// label; `(local)` is the sentinel that disables streaming.
export type SshTarget = {
  id: string;
  transport: "local" | "talos" | "ssh";
  /// Display label shown in the dropdown.
  label: string;
  /// Hostname / IPv4. Empty for the local sentinel.
  host: string;
  /// SSH user. Defaults to `root` on Hetzner testnet.
  user: string;
  /// Path to the private key file. The Rust side resolves it via
  /// `russh_keys::load_secret_key` — passphrases come from the
  /// keychain account `ssh:passphrase` if needed.
  keyPath: string;
};

/// Sentinel for "do not stream". Lifted into a constant so component
/// code can compare without re-deriving the id.
export const LOCAL_TARGET: SshTarget = {
  id: "(local)",
  transport: "local",
  label: "(no stream)",
  host: "",
  user: "",
  keyPath: "",
};

export const MONARCH_OS_TARGET: SshTarget = {
  id: "monarch-os",
  transport: "talos",
  label: "Monarch OS · Talos",
  host: "",
  user: "",
  keyPath: "",
};

/// SSH operator targets. Empty in the published source — operators
/// populate this from a local config file that is NOT committed.
///
/// To configure local targets, copy `examples/operators.json.example` to
/// `examples/operators.json` (gitignored) and edit. An in-app loader that
/// reads from `app_local_data_dir/operators.json` will replace this
/// constant in a later milestone (see
/// [`docs/final-product-readiness.md`](../../docs/final-product-readiness.md)).
///
/// Until then, `TESTNET_TARGETS` resolves to `[]` and the Logs dropdown
/// shows only the Monarch OS Talos target plus the explicit no-stream
/// option.
export const TESTNET_TARGETS: SshTarget[] = [];

export const ALL_TARGETS: SshTarget[] = [
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
  | { kind: "talos-streaming"; target: SshTarget; sessionId: number }
  | { kind: "connecting"; target: SshTarget }
  | { kind: "streaming"; target: SshTarget; sessionId: number }
  | { kind: "error"; target: SshTarget; error: string }
  | { kind: "ended"; target: SshTarget };

/// Module-level cache of the currently-connected target. The Rust side
/// only holds one session at a time today; we mirror that here so the
/// hook avoids redundant `ssh_connect` round-trips on rapid target
/// flips.
let activeTargetId: string | null = null;

async function ensureConnected(target: SshTarget): Promise<void> {
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

/// Parse one stream line into a `LogEntry`. journald's `-o json`
/// emits one JSON object per line (no array, no commas). Bad lines
/// degrade gracefully — we still surface them as a raw INFO entry so
/// the operator can see *something*.
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
  const src =
    entry.SYSLOG_IDENTIFIER ??
    entry._SYSTEMD_UNIT?.replace(/\.service$/, "") ??
    entry._COMM ??
    "monod";
  return {
    ts: formatTimestamp(entry.__REALTIME_TIMESTAMP),
    lvl: priorityToLevel(entry.PRIORITY),
    src,
    msg: message,
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
export function useLogStream(filter: string, target: SshTarget): LogStream {
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
          const id = await talosLogStream("ext-protocore", BUFFER_LIMIT, requestedId);
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
