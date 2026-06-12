import "./sdk/e2eRecorder";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
// IBM Plex, self-hosted via @fontsource (offline-capable — the design bible's
// type system; weights per design_handoff_monarch README).
import "@fontsource/ibm-plex-sans/300.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/300.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./styles/global.css";
// Theme palettes — imported AFTER global.css so [data-theme] wins over :root.
import "./styles/themes.css";
import { applyTheme, readStoredTheme } from "./components/ThemeSwitcher";

// Apply the saved theme before first paint so there's no default→saved flash.
applyTheme(readStoredTheme());

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root mount point missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
