// Logs — regex filter, level pills, monospace stream. Monarch OS streams
// through the Talos API; the explicit no-stream target keeps the view usable
// when a node control channel has not been configured.
//
// The streaming itself lives in `useLogStream(filter, target)` over in
// `src/sdk/useLogStream.ts` — this view stays presentational. The
// indexer halo continues to read from `lyth_indexerStatus` so operators
// see at a glance whether the indexer that backs log search is current.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ALL_TARGETS,
  LOCAL_TARGET,
  MONARCH_OS_TARGET,
  inTauri,
  talosLogDiskUsage,
  type LogEntry,
  type LogTarget,
  type StreamStatus,
  type TalosLogDiskUsage,
  useIndexerStatus,
  useLogStream,
} from "../sdk";
import { freezeView, newSinceFreeze } from "../sdk/freezeView";
import { NodeStatusHeader } from "../components/NodeStatusHeader";
import { useOps } from "../ops/OpsContext";
import { OP_CATALOG } from "../ops/catalog";
import { DEFAULT_LOG_RETENTION, type OpKind, type OpRequest } from "../ops/types";

const LEVELS = ["all", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];
const PIN_STORE_KEY = "monarch:log-pins";

/** Human-readable byte size for the log disk-usage stat. Binary units. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** Build an OpRequest from a catalog entry, mirroring the Operations view. */
function logCatalogRequest(kind: OpKind, overrides: Partial<OpRequest> = {}): OpRequest | null {
  const entry = OP_CATALOG.find((candidate) => candidate.kind === kind);
  if (!entry) return null;
  return {
    kind: entry.kind,
    title: entry.title,
    sub: entry.sub,
    intro: entry.intro,
    technical: entry.technical,
    fields: entry.fields,
    effects: entry.effects,
    diff: entry.diff,
    icon: entry.icon,
    risk: entry.risk,
    destructive: entry.destructive,
    needsPasskey: entry.needsPasskey,
    confirmLabel: entry.confirmLabel,
    ...overrides,
  };
}

function streamHalo(status: StreamStatus): { cls: string; text: string; title: string } {
  switch (status.kind) {
    case "local":
      return {
        cls: "halo halo--warn",
        text: "No log stream",
        title: "no log stream selected",
      };
    case "connecting":
      return {
        cls: "halo halo--info",
        text: "Connecting to node",
        title:
          status.target.transport === "talos"
            ? "fetching ext-protocore logs through Talos API"
            : `opening remote log session to ${status.target.host}`,
      };
    case "talos-streaming":
      return {
        cls: "halo halo--ok",
        text: "Live logs",
        title: `ext-protocore logs streaming through Talos API session ${status.sessionId}`,
      };
    case "talos-quiet":
      return {
        cls: "halo halo--info",
        text: "Stream open · quiet",
        title:
          "Node reachable; ext-protocore has logged little since its last start. New lines appear as the node writes them.",
      };
    case "streaming":
      return {
        cls: "halo halo--ok",
        text: "Live logs",
        title: `remote log session ${status.sessionId}`,
      };
    case "ended":
      return {
        cls: "halo halo--warn",
        text: "Log stream closed",
        title: "journalctl exited or channel closed by remote",
      };
    case "error":
      return {
        cls: "halo halo--err",
        text: "Log stream error",
        title: status.error,
      };
  }
}

export function Logs() {
  const [query, setQuery] = useState("");
  const [activeLevel, setActiveLevel] = useState<Level>("all");
  const [cursor, setCursor] = useState(0);
  const [target, setTarget] = useState<LogTarget>(MONARCH_OS_TARGET);
  const [pinned, setPinned] = useState<string[]>(() => readPins());
  // Freeze (pause) the live tail: when non-null we snapshot the `lines` array
  // and render that snapshot so the operator can read fast-scrolling logs. The
  // stream keeps running in the background (useLogStream is NOT torn down).
  const [frozen, setFrozen] = useState<LogEntry[] | null>(null);
  const indexer = useIndexerStatus();
  const { lines, status } = useLogStream(query, target);
  const ops = useOps();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Real protocore log disk usage (read over Talos DiskUsage/List). Never
  // fabricated: outside Tauri or on error it stays null and the stat hides.
  const [diskUsage, setDiskUsage] = useState<TalosLogDiskUsage | null>(null);
  const [diskUsageError, setDiskUsageError] = useState<string | null>(null);
  const [diskUsageLoading, setDiskUsageLoading] = useState(false);

  const refreshDiskUsage = useCallback(async () => {
    if (!inTauri() || target.transport !== "talos") {
      setDiskUsage(null);
      setDiskUsageError(null);
      return;
    }
    setDiskUsageLoading(true);
    try {
      const usage = await talosLogDiskUsage();
      setDiskUsage(usage);
      setDiskUsageError(null);
    } catch (err) {
      setDiskUsage(null);
      setDiskUsageError((err as Error)?.message ?? String(err));
    } finally {
      setDiskUsageLoading(false);
    }
  }, [target.transport]);

  // Fetch on mount / when the Talos target is selected. Not polled — the file
  // grows slowly and the operator can re-check from the panel.
  useEffect(() => {
    void refreshDiskUsage();
  }, [refreshDiskUsage]);

  const openLogOp = useCallback(
    (kind: OpKind) => {
      const request = logCatalogRequest(kind, {
        logRetentionInput: { ...DEFAULT_LOG_RETENTION },
      });
      if (request) ops.requestOp(request);
    },
    [ops],
  );

  // The biggest log file (the files list is already largest-first from Rust;
  // `.at(0)` keeps `noUncheckedIndexedAccess` happy).
  const largestLogFile = diskUsage?.files.at(0) ?? null;

  // While frozen the view renders the snapshot; the filter (regex + pills)
  // still applies to it. `newSinceFreeze` counts how many live lines have
  // arrived since freezing so the banner can show the backlog.
  const source = freezeView(lines, frozen);
  const bufferedSinceFreeze = newSinceFreeze(lines, frozen);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return source.filter((l) => {
      if (activeLevel !== "all" && l.lvl.toLowerCase() !== activeLevel)
        return false;
      if (!q) return true;
      // Try regex; if invalid, fall back to substring
      try {
        const re = new RegExp(q, "i");
        return re.test(l.msg) || re.test(l.src) || re.test(l.lvl);
      } catch {
        return (
          l.msg.toLowerCase().includes(q) ||
          l.src.toLowerCase().includes(q) ||
          l.lvl.toLowerCase().includes(q)
        );
      }
    });
  }, [query, activeLevel, source]);

  // Freeze: snapshot the current live `lines` (the stream keeps running).
  // Resume: drop the snapshot and re-attach to the live tail (the auto-scroll
  // effect below jumps back to the latest once `frozen` clears).
  const toggleFreeze = useCallback(() => {
    setFrozen((prev) => (prev === null ? lines.slice() : null));
  }, [lines]);

  // Vim keys j/k for navigation, / for focus, f to freeze/resume the tail
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "/") {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === "f") {
        e.preventDefault();
        toggleFreeze();
      } else if (e.key === "j") {
        setCursor((c) => Math.min(c + 1, Math.max(0, filtered.length - 1)));
      } else if (e.key === "k") {
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "p") {
        const line = filtered[cursor];
        if (!line) return;
        const key = `${line.ts}-${cursor}-${line.src}`;
        setPinned((prev) =>
          prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursor, filtered, toggleFreeze]);

  // SDK types: currentHeight = bigint, latestHeight = bigint | undefined.
  const indexerHalo = (() => {
    if (indexer.loading)
      return { cls: "halo halo--info", text: "Search loading" };
    if (indexer.error)
      return {
        cls: "halo halo--err",
        text: "Search unavailable",
      };
    if (indexer.data === null)
      return { cls: "halo halo--warn", text: "Search history off" };
    // A disabled indexer still returns a body ({enabled:false,
    // status:"disabled", disabledReason}) — the narrow SDK type omits these
    // runtime fields, so read them via a cast. Without this guard a disabled
    // indexer would be painted green "caught up".
    const runtime = indexer.data as {
      enabled?: boolean;
      status?: string;
      disabledReason?: string;
    };
    if (runtime.enabled === false || runtime.status === "disabled") {
      return { cls: "halo halo--warn", text: "Search history off" };
    }
    const { currentHeight, latestHeight } = indexer.data;
    const current = Number(currentHeight);
    if (latestHeight !== undefined) {
      const latest = Number(latestHeight);
      if (current < latest - 5) {
        return {
          cls: "halo halo--warn",
          text: "Search syncing",
        };
      }
    }
    return {
      cls: "halo halo--ok",
      text: "Search ready",
    };
  })();

  const halo = streamHalo(status);
  const pinnedLines = filtered.filter((l, i) => pinned.includes(`${l.ts}-${i}-${l.src}`));
  const togglePin = (key: string) => {
    setPinned((prev) =>
      prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
    );
  };

  useEffect(() => {
    localStorage.setItem(PIN_STORE_KEY, JSON.stringify(pinned));
  }, [pinned]);

  // Auto-scroll to the latest line as the live tail grows. No-op while frozen
  // so the operator's read position holds; on Resume (`frozen` clears) the
  // dependency change fires this once more and jumps back to the bottom.
  useEffect(() => {
    if (frozen !== null) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered, frozen]);

  useEffect(() => {
    const onFilter = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail !== "string") return;
      setQuery(detail);
      setCursor(0);
      inputRef.current?.focus();
    };
    window.addEventListener("monarch:logs-filter", onFilter as EventListener);
    return () =>
      window.removeEventListener("monarch:logs-filter", onFilter as EventListener);
  }, []);

  const exportPinned = () => {
    const body = pinnedLines
      .map((line) => `${line.ts} ${line.lvl} ${line.src} ${line.msg}`)
      .join("\n");
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `monarch-log-pins-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      className="view fade-in"
      style={{ display: "flex", flexDirection: "column", height: "100%", gap: 14 }}
    >
      <header>
        <h1 className="view__title">Logs</h1>
        <p className="view__subtitle">Live node logs.</p>
      </header>

      {/* Read-only node-status header: the Talos console/VNC dashboard fields
          (Stage / health / host / version / uptime / key service states) in-app,
          so the operator doesn't have to open the VNC console. Active only when
          a Monarch OS (Talos) node is in scope. */}
      <NodeStatusHeader active={target.transport === "talos"} />

      <div
        className="card"
        style={{
          padding: "12px 18px",
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <span
          aria-hidden
          style={{
            fontFamily: "var(--f-mono)",
            color: "var(--fg-300)",
            fontSize: 14,
          }}
        >
          ›_
        </span>
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter logs"
          style={{
            flex: 1,
            minWidth: 240,
            background: "transparent",
            border: 0,
            outline: "none",
            fontFamily: "var(--f-mono)",
            fontSize: 13,
            color: "var(--fg-100)",
          }}
        />
        <div style={{ display: "flex", gap: 4 }}>
          {LEVELS.map((lvl) => {
            const active = activeLevel === lvl;
            return (
              <button
                key={lvl}
                type="button"
                onClick={() => setActiveLevel(lvl)}
                style={{
                  padding: "4px 10px",
                  borderRadius: 999,
                  fontFamily: "var(--f-mono)",
                  fontSize: 10.5,
                  background: active ? "rgba(255,255,255,0.08)" : "transparent",
                  color: active ? "var(--fg-100)" : "var(--fg-400)",
                  border: `1px solid ${active ? "var(--fg-500)" : "transparent"}`,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  cursor: "pointer",
                }}
              >
                {lvl}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={toggleFreeze}
          aria-pressed={frozen !== null}
          title={
            frozen !== null
              ? "Resume the live tail (f) — jumps back to the latest line"
              : "Freeze the live tail (f) so you can read — the stream keeps running in the background"
          }
          style={{
            padding: "4px 12px",
            borderRadius: 999,
            fontFamily: "var(--f-mono)",
            fontSize: 10.5,
            background: frozen !== null ? "rgba(242,180,65,0.14)" : "transparent",
            color: frozen !== null ? "var(--gold)" : "var(--fg-400)",
            border: `1px solid ${frozen !== null ? "var(--gold)" : "var(--fg-500)"}`,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {frozen !== null ? "Resume" : "Freeze"}
        </button>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "var(--f-mono)",
            fontSize: 10.5,
            color: "var(--fg-400)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          <select
            aria-label="log target"
            value={target.id}
            onChange={(e) => {
              const next =
                ALL_TARGETS.find((t) => t.id === e.target.value) ?? LOCAL_TARGET;
              setTarget(next);
              setCursor(0);
            }}
            style={{
              background: "rgba(255,255,255,0.04)",
              color: "var(--fg-100)",
              border: "1px solid var(--glass-stroke)",
              borderRadius: 6,
              padding: "4px 8px",
              fontFamily: "var(--f-mono)",
              fontSize: 11,
              letterSpacing: "0.04em",
              textTransform: "none",
              cursor: "pointer",
            }}
          >
            {ALL_TARGETS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <span className={halo.cls} title={halo.title}>
          <span className="dot" /> {halo.text}
        </span>
        <span className={indexerHalo.cls} title={indexer.error ?? indexerHalo.text}>
          <span className="dot" /> {indexerHalo.text}
        </span>
        {target.transport === "talos" && inTauri() ? (
          <span
            className="halo halo--info"
            title={
              diskUsageError
                ? `could not read log size: ${diskUsageError}`
                : diskUsage
                  ? `protocore logs at ${diskUsage.path}`
                  : "protocore log directory size"
            }
          >
            <span className="dot" />{" "}
            {diskUsageLoading && !diskUsage
              ? "Logs …"
              : diskUsageError
                ? "Logs size n/a"
                : diskUsage
                  ? `Logs ${formatBytes(diskUsage.totalBytes)}`
                  : "Logs —"}
          </span>
        ) : null}
      </div>

      {target.transport === "talos" && inTauri() ? (
        <div
          className="card"
          style={{
            padding: "12px 18px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 220 }}>
            <span className="cap">log disk usage · {diskUsage?.path ?? "/var/lib/protocore/logs"}</span>
            <span className="mono" style={{ fontSize: 13 }}>
              {diskUsageError
                ? "unavailable"
                : diskUsage
                  ? `${formatBytes(diskUsage.totalBytes)}${
                      diskUsage.files.length > 0 ? ` · ${diskUsage.files.length} file(s)` : ""
                    }`
                  : diskUsageLoading
                    ? "reading…"
                    : "—"}
            </span>
            {largestLogFile ? (
              <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
                largest: {largestLogFile.name} ({formatBytes(largestLogFile.size)})
              </span>
            ) : null}
            {diskUsageError ? (
              <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>{diskUsageError}</span>
            ) : null}
          </div>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void refreshDiskUsage()}
            disabled={diskUsageLoading}
          >
            {diskUsageLoading ? "Reading…" : "Refresh size"}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => openLogOp("set-log-retention")}
            title="Bound how large the protocore log can grow (merges the cap into the node's machine config and re-applies it)."
          >
            Set log retention
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => openLogOp("clean-protocore-logs")}
            title="Apply retention and restart ext-protocore so the bound takes effect."
          >
            Clean up logs
          </button>
        </div>
      ) : null}

      {pinnedLines.length > 0 ? (
        <div className="card logs-pinned">
          <div className="logs-pinned__head">
            <div className="cap">pinned lines · audit-bound</div>
            <button type="button" className="btn btn--ghost btn--sm" onClick={exportPinned}>
              Export pins
            </button>
          </div>
          {pinnedLines.slice(0, 3).map((l, i) => (
            <div className="logs-pinned__line mono" key={`${l.ts}-${i}`}>
              <span>{l.ts}</span>
              <b>{l.lvl}</b>
              <span>{l.msg}</span>
            </div>
          ))}
        </div>
      ) : null}

      {frozen !== null ? (
        <div
          className="card"
          style={{
            padding: "8px 18px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            borderColor: "var(--gold)",
          }}
        >
          <span className="halo halo--warn" title="The live tail is paused; the stream keeps running in the background.">
            <span className="dot" /> Frozen
          </span>
          <span
            className="mono"
            style={{ fontSize: 11.5, color: "var(--fg-300)" }}
            aria-live="polite"
          >
            {bufferedSinceFreeze === 1
              ? "1 new line buffered"
              : `${bufferedSinceFreeze} new lines buffered`}
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn--ghost btn--sm" onClick={toggleFreeze}>
            Resume
          </button>
        </div>
      ) : null}

      <div
        className="card card--flush"
        style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}
      >
        <div
          ref={listRef}
          style={{
            overflowY: "auto",
            flex: 1,
            fontFamily: "var(--f-mono)",
          }}
        >
          {filtered.map((l, i) => {
            const lvlColor =
              l.lvl === "ERROR"
                ? "var(--err)"
                : l.lvl === "WARN"
                  ? "var(--warn)"
                  : "var(--fg-300)";
            const isCursor = i === cursor;
            const rowKey = `${l.ts}-${i}-${l.src}`;
            const isPinned = pinned.includes(rowKey);
            return (
              <div
                key={rowKey}
                style={{
                  display: "grid",
                  gridTemplateColumns: "26px auto 60px 120px 1fr",
                  gap: 14,
                  padding: "6px 18px",
                  fontSize: 12,
                  alignItems: "center",
                  borderTop: i > 0 ? "1px solid var(--glass-stroke)" : "none",
                  background: isCursor
                    ? "rgba(255,255,255,0.04)"
                    : "transparent",
                  borderLeft: isCursor
                    ? "2px solid var(--gold)"
                    : "2px solid transparent",
                }}
              >
                <button
                  type="button"
                  className={isPinned ? "pin-btn is-pinned" : "pin-btn"}
                  onClick={() => togglePin(rowKey)}
                  aria-label={isPinned ? "Unpin line" : "Pin line"}
                  title={isPinned ? "Unpin line" : "Pin line"}
                >
                  *
                </button>
                <span style={{ color: "var(--fg-400)", fontSize: 11 }}>{l.ts}</span>
                <span
                  style={{
                    color: lvlColor,
                    fontWeight: 500,
                    letterSpacing: "0.08em",
                  }}
                >
                  {l.lvl}
                </span>
                <span style={{ color: "var(--fg-300)" }}>{l.src}</span>
                <span style={{ color: "var(--fg-100)" }}>{l.msg}</span>
              </div>
            );
          })}
          {filtered.length === 0 ? (
            <div
              style={{
                padding: 20,
                color: "var(--fg-500)",
                fontSize: 12,
                textAlign: "center",
              }}
            >
              {status.kind === "connecting"
                ? "Connecting to the node..."
                : status.kind === "error"
                  ? `Log stream failed: ${status.error}${/[.!?]$/.test(status.error.trim()) ? "" : "."} The node may still be healthy (other Talos calls like upgrades use the same API) — if this persists, check the Monarch OS connection in Settings.`
                  : status.kind === "local"
                    ? "No log stream selected."
                    : query.trim()
                      ? "No log lines match this filter."
                      : status.kind === "talos-quiet"
                        ? "Connected. The node has logged little since it last started — new lines will appear as it writes them."
                        : status.kind === "ended"
                          ? "Log stream closed. The node is reachable; reopen the Logs view to resume the live tail."
                          : "Connected. Waiting for logs from the node."}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function readPins(): string[] {
  try {
    const raw = localStorage.getItem(PIN_STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}
