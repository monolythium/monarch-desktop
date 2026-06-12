// 56px topbar — breadcrumb, live round halo (driven by useNodeStatus,
// which itself prefers the node WS push feed), and the ⌘K palette
// trigger. Clicking the trigger opens the palette, which is also bound
// to Cmd+K (Ctrl+K on non-mac) globally. The round counter flashes for
// 300ms whenever the round advances (reduced-motion users get no flash).

import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { NAV_ROUTES } from "../nav/routes";
import { useChainStatus, useNodeStatus } from "../sdk";
import { EndpointChip } from "./EndpointChip";
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
  const reachable = status.reachable;
  const round = status.currentRound;
  const block = status.blockNumber;

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

      <div className="monarch-topbar__version">v0.9β</div>

      <button
        type="button"
        className="btn btn--icon btn--ghost monarch-topbar__tool"
        aria-label="Open tweaks"
        title="Tweaks"
        onClick={onOpenTweaks}
      >
        TK
      </button>
      <div className="monarch-topbar__avatar" aria-label="Operator profile">M</div>
    </header>
  );
}
