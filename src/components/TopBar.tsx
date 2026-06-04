// 56px topbar — breadcrumb, live round halo (driven by useNodeStatus),
// and the ⌘K palette trigger. Clicking the trigger opens the palette,
// which is also bound to Cmd+K (Ctrl+K on non-mac) globally.

import { useLocation } from "react-router-dom";
import { NAV_ROUTES } from "../nav/routes";
import { useChainStatus, useNodeStatus } from "../sdk";

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
        <span>{status.endpoint}</span>
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

      <div className="monarch-topbar__round" aria-live="polite">
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
