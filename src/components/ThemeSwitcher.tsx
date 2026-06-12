// Topbar appearance switcher — ported from monoscan's MsThemeSwitcher.
//
// The 12 palettes live in src/styles/themes.css as [data-theme="…"] blocks.
// This component is just the control: a swatch button + dropdown grid that
// writes the chosen theme id to localStorage["monarch.theme"] and sets
// `data-theme` on <html>. The key + selector are shared verbatim with
// monoscan, the wallets, and the website so a theme picked in one surface
// carries to the others (and across tabs via the storage event).

import { useEffect, useRef, useState } from "react";

export const THEMES = [
  { id: "monolythium", label: "Monolythium", swatch: "#F2B441", desc: "Gold cockpit" },
  { id: "default", label: "Default", swatch: "#e8a942", desc: "Warm amber" },
  { id: "monolabs", label: "Monolabs", swatch: "#3bd0c4", desc: "Teal" },
  { id: "monoplay", label: "Monoplay", swatch: "#d22d3d", desc: "Crimson" },
  { id: "glass", label: "Liquid Glass", swatch: "#7fb2ff", desc: "Frosted" },
  { id: "aurora", label: "Aurora", swatch: "#d36bff", desc: "Purple" },
  { id: "crimson", label: "Crimson", swatch: "#ff5a5a", desc: "Burgundy" },
  { id: "neon", label: "Neon", swatch: "#00ffc8", desc: "Terminal" },
  { id: "midnight", label: "Midnight", swatch: "#9d7cff", desc: "Violet" },
  { id: "retro", label: "Retro CRT", swatch: "#ffb347", desc: "Amber" },
  { id: "mono", label: "Mono", swatch: "#f5f5f5", desc: "Black and white" },
  { id: "light", label: "Light", swatch: "#f7f3ea", desc: "Paper" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const THEME_STORAGE_KEY = "monarch.theme";
export const DEFAULT_THEME: ThemeId = "monolythium";

export function readStoredTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return THEMES.some((t) => t.id === saved) ? (saved as ThemeId) : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(id: ThemeId): void {
  document.documentElement.setAttribute("data-theme", id);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // Storage can be blocked in hardened webviews; the visual state still applies.
  }
}

export function ThemeSwitcher() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(readStoredTheme);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Close on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    const click = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", click);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", click);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  // Cross-tab / cross-surface sync.
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY && THEMES.some((t) => t.id === event.newValue)) {
        setTheme(event.newValue as ThemeId);
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0];

  return (
    <div className="ms-theme" ref={ref}>
      <button
        className={`ms-theme__btn ${open ? "is-open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-label={`Theme: ${current.label}`}
        title={`Theme: ${current.label}`}
        type="button"
      >
        <span className="ms-theme__swatch" style={{ background: current.swatch }} />
      </button>
      {open && (
        <div className="ms-theme__pop" role="menu">
          <div className="ms-theme__pop-head">
            <div className="ms-theme__pop-title">Appearance</div>
            <div className="ms-theme__pop-sub">Syncs with Monoscan and Wallet</div>
          </div>
          <div className="ms-theme__grid">
            {THEMES.map((option) => (
              <button
                key={option.id}
                className={`ms-theme__opt ${option.id === theme ? "is-active" : ""}`}
                onClick={() => {
                  setTheme(option.id);
                  setOpen(false);
                }}
                role="menuitem"
                type="button"
              >
                <span className="ms-theme__opt-swatch" style={{ background: option.swatch }} />
                <span className="ms-theme__opt-text">
                  <b>{option.label}</b>
                  <small>{option.desc}</small>
                </span>
                {option.id === theme && (
                  <svg className="ms-theme__opt-check" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="m2 6 3 3 5-7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
