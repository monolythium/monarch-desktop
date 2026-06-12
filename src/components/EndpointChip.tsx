// Topbar "connected: <endpoint>" chip + quick endpoint editor.
//
// The owner's #1 complaint was that changing the node URL is buried at the
// bottom of Operations. This makes it permanently reachable from the chrome:
// the chip shows the live endpoint and its reachability dot, and clicking it
// opens a small popover to retest + switch the node. The editor reuses the
// exact `getStoredRpcEndpoint` / `setStoredRpcEndpoint` plumbing (same as
// Operations' RpcEndpointSettings) and the wizard's `normalizeNodeEndpoint`
// lenient parser, so a bare IP works here too. Saving reloads so every view
// reconnects to the new endpoint.

import { useEffect, useRef, useState } from "react";
import {
  getStoredRpcEndpoint,
  normalizeNodeEndpoint,
  probeNodeEndpoint,
  setStoredRpcEndpoint,
  useNodeStatus,
  type NodeProbeResult,
} from "../sdk";

export function EndpointChip() {
  const status = useNodeStatus();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => getStoredRpcEndpoint() ?? "");
  const [probe, setProbe] = useState<NodeProbeResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const test = async () => {
    setError(null);
    setProbe(null);
    let normalized: string;
    try {
      normalized = normalizeNodeEndpoint(draft);
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
      return;
    }
    setDraft(normalized);
    setTesting(true);
    try {
      setProbe(await probeNodeEndpoint(normalized));
    } finally {
      setTesting(false);
    }
  };

  const save = () => {
    try {
      const normalized = normalizeNodeEndpoint(draft);
      setStoredRpcEndpoint(normalized);
      window.setTimeout(() => window.location.reload(), 250);
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    }
  };

  const ok = probe?.outcome === "ok";

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="monarch-topbar__round"
        style={{ cursor: "pointer", gap: 6 }}
        onClick={() => setOpen((v) => !v)}
        aria-label="Node endpoint"
        title="Change the node Monarch connects to"
      >
        <span
          className="dot"
          style={
            status.reachable
              ? undefined
              : { background: "var(--err)", boxShadow: "0 0 6px var(--err)" }
          }
        />
        <span>node</span>
        <b style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {status.endpoint.replace(/^https?:\/\//, "")}
        </b>
      </button>

      {open ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 360,
            zIndex: 60,
            background: "var(--glass-fill-strong)",
            backdropFilter: "blur(var(--glass-blur))",
            border: "1px solid var(--glass-stroke-hi)",
            borderRadius: "var(--r-md)",
            boxShadow: "var(--shadow-3)",
            padding: 16,
          }}
        >
          <div className="cap" style={{ marginBottom: 8 }}>node endpoint</div>
          <input
            type="text"
            className="mono"
            placeholder="178.105.12.9   ·   http://node:8545"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !testing) void test();
            }}
            spellCheck={false}
            autoComplete="off"
            style={{
              width: "100%",
              padding: "10px 12px",
              background: "rgba(0,0,0,0.3)",
              border: error ? "1px solid var(--err)" : "1px solid var(--glass-stroke)",
              borderRadius: 8,
              color: "var(--fg-100)",
              fontSize: 13,
              outline: "none",
            }}
          />
          {error ? (
            <div className="halo halo--err" style={{ marginTop: 8, alignSelf: "flex-start" }}>
              <span className="dot" /> {error}
            </div>
          ) : null}
          {probe ? (
            <div
              className={`halo halo--${ok ? "ok" : "err"}`}
              style={{ marginTop: 8, alignSelf: "flex-start", whiteSpace: "normal" }}
            >
              <span className="dot" />
              {ok
                ? `reachable · chain ${probe.chainId} · block ${probe.blockNumber?.toLocaleString() ?? "—"}`
                : (probe.error ?? "unreachable")}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void test()}
              disabled={testing || !draft.trim()}
            >
              {testing ? "Testing…" : "Test"}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={save}
              disabled={!draft.trim()}
            >
              Save &amp; reconnect
            </button>
          </div>
          <p style={{ fontSize: 10.5, color: "var(--fg-400)", margin: "10px 0 0", lineHeight: 1.5 }}>
            http:// or https:// only — a bare IP defaults to http on port 8545. Saving reloads the
            console so every view reconnects.
          </p>
        </div>
      ) : null}
    </div>
  );
}
