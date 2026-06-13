// Logs — regex filter, level pills, monospace stream. Header hosts the
// target picker. Monarch OS streams through the Talos API; development
// SSH targets use `journalctl -fu monod -o json` through the russh bridge.
//
// The streaming itself lives in `useLogStream(filter, target)` over in
// `src/sdk/useLogStream.ts` — this view stays presentational. The
// indexer halo continues to read from `lyth_indexerStatus` so operators
// see at a glance whether the indexer that backs log search is current.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ALL_TARGETS,
  LOCAL_TARGET,
  MONARCH_OS_TARGET,
  type SshTarget,
  type StreamStatus,
  useIndexerStatus,
  useLogStream,
} from "../sdk";

const LEVELS = ["all", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];
const PIN_STORE_KEY = "monarch:log-pins";

function streamHalo(status: StreamStatus): { cls: string; text: string; title: string } {
  switch (status.kind) {
    case "local":
      return {
        cls: "halo halo--warn",
        text: "stream · none",
        title: "no log stream selected",
      };
    case "connecting":
      return {
        cls: "halo halo--info",
        text: `stream · connecting ${status.target.id}`,
        title:
          status.target.transport === "talos"
            ? "fetching ext-protocore logs through Talos API"
            : `opening russh session to ${status.target.host}`,
      };
    case "talos-streaming":
      return {
        cls: "halo halo--ok",
        text: "stream · Monarch OS · Talos",
        title: `ext-protocore logs streaming through Talos API session ${status.sessionId}`,
      };
    case "streaming":
      return {
        cls: "halo halo--ok",
        text: `stream · ${status.target.id} · live`,
        title: `journalctl -fu monod via russh (session ${status.sessionId})`,
      };
    case "ended":
      return {
        cls: "halo halo--warn",
        text: `stream · ${status.target.id} · closed`,
        title: "journalctl exited or channel closed by remote",
      };
    case "error":
      return {
        cls: "halo halo--err",
        text: `stream · ${status.target.id} · ${status.error.slice(0, 28)}`,
        title: status.error,
      };
  }
}

export function Logs() {
  const [query, setQuery] = useState("");
  const [activeLevel, setActiveLevel] = useState<Level>("all");
  const [cursor, setCursor] = useState(0);
  const [target, setTarget] = useState<SshTarget>(MONARCH_OS_TARGET);
  const [pinned, setPinned] = useState<string[]>(() => readPins());
  const indexer = useIndexerStatus();
  const { lines, status } = useLogStream(query, target);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter((l) => {
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
  }, [query, activeLevel, lines]);

  // Vim keys j/k for navigation, / for focus
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "/") {
        e.preventDefault();
        inputRef.current?.focus();
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
  }, [cursor, filtered]);

  // SDK types: currentHeight = bigint, latestHeight = bigint | undefined.
  const indexerHalo = (() => {
    if (indexer.loading)
      return { cls: "halo halo--info", text: "indexer · loading" };
    if (indexer.error)
      return {
        cls: "halo halo--err",
        text: `indexer · ${indexer.error.slice(0, 32)}`,
      };
    if (indexer.data === null)
      return { cls: "halo halo--warn", text: "indexer · disabled" };
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
      // disabledReason is a snake_case machine code (e.g. "indexer_disabled");
      // the "indexer ·" prefix already names the subsystem, so show a clean
      // "disabled" unless the node gives a more specific reason.
      const reason =
        runtime.disabledReason && runtime.disabledReason !== "indexer_disabled"
          ? runtime.disabledReason.replace(/_/g, " ")
          : "disabled";
      return { cls: "halo halo--warn", text: `indexer · ${reason}` };
    }
    const { currentHeight, latestHeight } = indexer.data;
    const current = Number(currentHeight);
    if (latestHeight !== undefined) {
      const latest = Number(latestHeight);
      if (current < latest - 5) {
        return {
          cls: "halo halo--warn",
          text: `indexer · ${current.toLocaleString()} / ${latest.toLocaleString()}`,
        };
      }
    }
    return {
      cls: "halo halo--ok",
      text: `indexer · ${current.toLocaleString()} caught up`,
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
        <p className="view__subtitle">
          native Talos stream · dev SSH tail · regex filters · pinned lines audit-bound
        </p>
      </header>

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
          placeholder="regex filter · try: slashing|double-sign|error"
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
          <span aria-hidden>host</span>
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
        <span
          className="mono"
          style={{ fontSize: 10.5, color: "var(--fg-400)", letterSpacing: "0.06em" }}
        >
          j/k navigate · / search · p pin
        </span>
      </div>

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
                  P
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
                ? "Opening log stream…"
                : status.kind === "error"
                  ? "Stream error — see halo for detail."
                  : status.kind === "local"
                    ? "No log stream selected."
                  : "No lines match your filter."}
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
