// 56px topbar — breadcrumb, live round halo (driven by useNodeStatus,
// which itself prefers the node WS push feed), and the ⌘K palette
// trigger. Clicking the trigger opens the palette, which is also bound
// to Cmd+K (Ctrl+K on non-mac) globally. The round counter flashes for
// 300ms whenever the round advances (reduced-motion users get no flash).

import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getVersion } from "@tauri-apps/api/app";
import { NAV_ROUTES } from "../nav/routes";
import { useChainStatus, useNodeStatus } from "../sdk";
import { EndpointChip } from "./EndpointChip";
import { ThemeSwitcher } from "./ThemeSwitcher";
import "../styles/livedata.css";

export function TopBar({
  onOpenPalette,
  onOpenTweaks,
}: {
  onOpenPalette: () => void;
  onOpenTweaks: () => void;
}) {
  const status = useNodeStatus();
  const chain = useChainStatus();
  const location = useLocation();
  const navigate = useNavigate();
  const reachable = status.reachable;
  const round = status.currentRound;
  const block = status.blockNumber;

  // Real app version from the Tauri runtime (package.json / tauri.conf.json).
  // Resolves to "" outside Tauri (`pnpm dev`) or while the IPC call is in
  // flight, so the chip simply hides rather than showing a fake build tag.
  const [version, setVersion] = useState("");
  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // 300ms flash keyed by round change — driven by the WS feed, so the
  // chrome visibly ticks the moment a round seals.
  const [roundFlash, setRoundFlash] = useState(false);
  const prevRoundRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevRoundRef.current;
    prevRoundRef.current = round;
    if (round === null || prev === null || round === prev) return;
    setRoundFlash(true);
    const id = window.setTimeout(() => setRoundFlash(false), 300);
    return () => window.clearTimeout(id);
  }, [round]);
  const current =
    NAV_ROUTES.find((r) => location.pathname === r.path)?.label ??
    (location.pathname === "/operator" ? "Operator" : "Home");
  const operatorCount = chain.data?.operatorCount ?? 0;
  const chainId = chain.data?.chainId ?? status.chainId;

  // Render the platform-correct chord hint.
  const isMac =
    typeof navigator !== "undefined" &&
    /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");

  return (
    <header className="monarch-topbar" role="banner">
      <div className="monarch-topbar__breadcrumb">
        <span>chain {chainId ?? "—"}</span>
        <span className="monarch-topbar__sep">/</span>
        <b>{current}</b>
      </div>

      <div className="monarch-topbar__spacer" />

      <button
        type="button"
        className="monarch-topbar__cmdk"
        aria-label="Open command palette"
        onClick={onOpenPalette}
      >
        <span>Search, jump, run…</span>
        <span className="monarch-topbar__cmdk-spacer" />
        <kbd>{isMac ? "⌘" : "Ctrl"}</kbd>
        <kbd>K</kbd>
      </button>

      <div
        className={roundFlash ? "monarch-topbar__round lv-round-flash" : "monarch-topbar__round"}
        aria-live="polite"
      >
        {reachable ? (
          <>
            <span className="dot" />
            <span>round</span>
            <b>{round?.toLocaleString() ?? "—"}</b>
            <span style={{ color: "var(--fg-500)" }}>·</span>
            <span>block</span>
            <b>{block?.toLocaleString() ?? "—"}</b>
          </>
        ) : (
          <>
            <span
              className="dot"
              style={{ background: "var(--err)", boxShadow: "0 0 6px var(--err)" }}
            />
            <span>node unreachable</span>
          </>
        )}
      </div>

      <div className="monarch-topbar__round">
        <span>operators</span>
        <b>{operatorCount || "—"}</b>
      </div>

      <EndpointChip />

      {version ? <div className="monarch-topbar__version">v{version}</div> : null}

      <ThemeSwitcher />

      <button
        type="button"
        className="btn btn--icon btn--ghost monarch-topbar__tool"
        aria-label="Open tweaks"
        title="Tweaks — tune the chrome"
        onClick={onOpenTweaks}
      >
        {/* sliders glyph — clearer affordance than the old "TK" text */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <line x1="4" y1="6" x2="20" y2="6" />
          <circle cx="9" cy="6" r="2.2" fill="var(--ink-100)" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <circle cx="15" cy="12" r="2.2" fill="var(--ink-100)" />
          <line x1="4" y1="18" x2="20" y2="18" />
          <circle cx="8" cy="18" r="2.2" fill="var(--ink-100)" />
        </svg>
      </button>

      <button
        type="button"
        className="monarch-topbar__avatar"
        aria-label="Operator profile"
        title="Operator profile"
        onClick={() => navigate("/operator")}
      >
        M
      </button>
    </header>
  );
}
