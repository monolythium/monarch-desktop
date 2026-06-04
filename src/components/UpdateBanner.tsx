// Floating banner that appears when an update is available.
//
// Sits at the bottom of the shell, full width, dismissible. Mirrors the
// desktop-wallet pattern; the matching frontend module is sdk/updater.ts.

import { useState } from "react";
import {
  dismissPendingUpdate,
  downloadAndInstallUpdate,
  type UpdateAvailable,
} from "../sdk/updater";

interface UpdateBannerProps {
  update: UpdateAvailable;
  onDismiss: () => void;
}

type State =
  | { kind: "idle" }
  | { kind: "installing"; downloaded: number; total: number | undefined }
  | { kind: "error"; message: string };

export function UpdateBanner({ update, onDismiss }: UpdateBannerProps) {
  const [state, setState] = useState<State>({ kind: "idle" });

  const install = async () => {
    setState({ kind: "installing", downloaded: 0, total: undefined });
    try {
      await downloadAndInstallUpdate((downloaded, total) => {
        setState({ kind: "installing", downloaded, total });
      });
    } catch (cause) {
      const message = (cause as Error)?.message ?? String(cause);
      setState({ kind: "error", message });
    }
  };

  const handleDismiss = () => {
    dismissPendingUpdate();
    onDismiss();
  };

  const percent =
    state.kind === "installing" && state.total
      ? Math.min(100, Math.round((state.downloaded / state.total) * 100))
      : null;

  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 40,
        padding: "12px 18px",
        background: "rgba(20, 20, 28, 0.95)",
        backdropFilter: "blur(12px)",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        display: "flex",
        alignItems: "center",
        gap: 16,
        fontSize: 13,
        color: "var(--monarch-fg-1, #e5e5ea)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>
          Update available — Monarch Desktop {update.version}
        </div>
        {update.notes ? (
          <div
            style={{
              marginTop: 2,
              fontSize: 12,
              color: "var(--monarch-fg-2, #a8a8b0)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={update.notes}
          >
            {update.notes}
          </div>
        ) : null}
        {state.kind === "installing" && (
          <div
            style={{
              marginTop: 8,
              height: 4,
              borderRadius: 2,
              background: "rgba(255,255,255,0.08)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: percent !== null ? `${percent}%` : "30%",
                height: "100%",
                background: "var(--monarch-gold, #F2B441)",
                transition: "width 200ms ease-out",
              }}
            />
          </div>
        )}
        {state.kind === "error" && (
          <div style={{ marginTop: 4, fontSize: 12, color: "var(--monarch-err, #ff6b6b)" }}>
            {state.message}
          </div>
        )}
      </div>
      {state.kind !== "installing" && (
        <>
          <button
            type="button"
            onClick={handleDismiss}
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "transparent",
              color: "var(--monarch-fg-1, #e5e5ea)",
              fontSize: 12.5,
              cursor: "pointer",
            }}
          >
            Later
          </button>
          <button
            type="button"
            onClick={() => void install()}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: "none",
              background: "var(--monarch-gold, #F2B441)",
              color: "#0d0d12",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Install &amp; relaunch
          </button>
        </>
      )}
      {state.kind === "installing" && (
        <div
          style={{
            fontSize: 12,
            color: "var(--monarch-fg-2, #a8a8b0)",
            fontFamily: "var(--monarch-mono, monospace)",
          }}
        >
          {percent !== null ? `${percent}%` : "Downloading…"}
        </div>
      )}
    </div>
  );
}
