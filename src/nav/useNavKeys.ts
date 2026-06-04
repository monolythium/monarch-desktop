// `g+letter` keyboard navigation. Press `g`, then the chord letter
// within 1 second to jump. State machine:
//   idle  ─ g ─▶  pending(timeout=1s)  ─ chord ─▶  navigate ─▶  idle
//                                       ─ esc/other ─▶  idle
//
// Listener attaches once at app shell mount. Skipped when the active
// element is an editable target (input / textarea / contenteditable) so
// typing in the AskBar doesn't trigger nav.

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { routeForChord } from "./routes";

const PENDING_MS = 1000;

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return false;
}

/**
 * Wire global `g+letter` nav keys.
 *
 * @param disabled — set true while a modal/palette is open to suspend nav.
 */
export function useNavKeys(disabled = false): void {
  const navigate = useNavigate();
  const pendingRef = useRef<number | null>(null);

  useEffect(() => {
    if (disabled) return;

    const clearPending = () => {
      if (pendingRef.current !== null) {
        window.clearTimeout(pendingRef.current);
        pendingRef.current = null;
      }
    };

    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;

      const key = e.key.toLowerCase();

      // Bootstrap: a `g` press arms the chord state.
      if (pendingRef.current === null) {
        if (key === "g") {
          e.preventDefault();
          pendingRef.current = window.setTimeout(() => {
            pendingRef.current = null;
          }, PENDING_MS);
        }
        return;
      }

      // Armed: next non-modifier key picks the route.
      clearPending();
      if (key === "escape" || key === " ") return;
      const path = routeForChord(key);
      if (path) {
        e.preventDefault();
        navigate(path);
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      clearPending();
    };
  }, [disabled, navigate]);
}
