// 220px sidebar — Monarch Desktop nav. Routes are sourced from
// `nav/routes.ts` so SideNav, the ⌘K palette, and the `g+letter`
// nav-keys hook share one registry. Active item gets a gold halo
// accent (gold-discipline rule: primary action only).

import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { getVersion } from "@tauri-apps/api/app";
import { NAV_ROUTES } from "../nav/routes";
import { useKeychainPresence } from "../hooks/useSelfOperator";
import { rpcEndpoint, useChainStatus, useNodeStatus } from "../sdk";

const GROUP_ORDER = ["Operator", "Cluster", "Node service", "Chain", "Setup"] as const;
const SETUP_FIRST_GROUP_ORDER = ["Setup", "Operator", "Cluster", "Node service", "Chain"] as const;

// Preview routes are design placeholders, not shipping features. They keep
// their registry entry (palette + chords + e2e parity still reach them) but
// the sidebar pulls them out of the real groups into one clearly-labelled
// "Preview" section so a brand-new operator isn't fooled.
const PREVIEW_GROUP_LABEL = "Preview";

export function SideNav() {
  const status = useNodeStatus();
  const chain = useChainStatus();
  // Real app version (Tauri runtime); "" outside Tauri / while the IPC resolves,
  // so the brand never shows a fake build tag.
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
  // Surface the Setup group FIRST while no operator key is stored — a
  // brand-new operator should see the wizard / Install / Keys before dashboards.
  const presence = useKeychainPresence();
  const order =
    !presence.checking && !presence.hasOperatorKey ? SETUP_FIRST_GROUP_ORDER : GROUP_ORDER;
  const liveRoutes = NAV_ROUTES.filter((r) => !r.preview);
  const previewRoutes = NAV_ROUTES.filter((r) => r.preview);
  const grouped: { label: string; items: typeof liveRoutes }[] = order
    .map((label) => ({
      label: label as string,
      items: liveRoutes.filter((r) => r.group === label),
    }))
    .filter((group) => group.items.length > 0);
  if (previewRoutes.length > 0) {
    grouped.push({ label: PREVIEW_GROUP_LABEL, items: previewRoutes });
  }
  const chainId = chain.data?.chainId ?? status.chainId;

  return (
    <nav className="monarch-sidenav" aria-label="Primary">
      <div className="monarch-sidenav__brand">
        <div className="monarch-sidenav__mark">
          <img src="/favicon.svg" alt="Monolythium" width={28} height={28} />
        </div>
        <div className="monarch-sidenav__name">
          Monarch
          <small>
            Operator console{version ? <span>v{version}</span> : null}
          </small>
        </div>
      </div>

      {grouped.map((group) => {
        const isPreview = group.label === PREVIEW_GROUP_LABEL;
        return (
        <div className="monarch-sidenav__group" key={group.label}>
          <div className="monarch-sidenav__group-label">
            {group.label}
            {isPreview ? (
              <span
                title="Design previews — these screens show prototype data and are not live features yet."
                style={{ marginLeft: 6, color: "var(--fg-500)", fontSize: 9, letterSpacing: "0.04em" }}
              >
                · prototype
              </span>
            ) : null}
          </div>
          <ul className="monarch-sidenav__list">
            {group.items.map((item) => (
              <li key={item.path}>
                <NavLink
                  to={item.path}
                  className={({ isActive }) =>
                    isActive
                      ? "monarch-sidenav__item monarch-sidenav__item--active"
                      : "monarch-sidenav__item"
                  }
                  style={isPreview ? { opacity: 0.62 } : undefined}
                >
                  <span className="monarch-sidenav__item-main">
                    <span className="monarch-sidenav__icon" aria-hidden>{item.icon}</span>
                    <span>{item.label}</span>
                  </span>
                  <span className="monarch-sidenav__hint">{item.hint}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
        );
      })}

      <div className="monarch-sidenav__footer">
        <b>
          <span className={status.reachable ? "dot dot--pulse" : "dot"} />{" "}
          {status.reachable ? "connected node" : "node not connected"}
        </b>
        <span className="monarch-sidenav__pair">{rpcEndpoint}</span>
        <span style={{ fontSize: 10, color: "var(--fg-500)" }}>
          chain_id {chainId ?? "—"}
        </span>
      </div>
    </nav>
  );
}
