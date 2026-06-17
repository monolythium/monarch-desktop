// 220px sidebar — Monarch Desktop nav. Routes are sourced from
// `nav/routes.ts` so SideNav, the ⌘K palette, and the `g+letter`
// nav-keys hook share one registry. Active item gets a gold halo
// accent (gold-discipline rule: primary action only).
//
// Every top-level surface is shown, grouped by the route's own `group`
// field. Pure sub-flows / one-shot utilities (`/welcome`, `/setup-operator`,
// `/setup-cluster`) are hidden — they are reached from within a flow, not the
// rail. Each item renders its real lucide icon (see components/icons).

import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { getVersion } from "@tauri-apps/api/app";
import { NAV_ROUTES, type NavRoute } from "../nav/routes";
import { useKeychainPresence } from "../hooks/useSelfOperator";
import { rpcEndpoint, useChainStatus, useNodeStatus } from "../sdk";
import { RouteIcon } from "./icons";

type SidebarGroup = NavRoute["group"];

// Group display order. Home stays first under Operator (NAV_ROUTES order).
const GROUP_ORDER: readonly SidebarGroup[] = [
  "Operator",
  "Cluster",
  "Node service",
  "Chain",
  "Setup",
];

// When no operator key is stored yet, surface Setup FIRST — a brand-new
// operator should see the wizard / Install / Keys before the dashboards.
const SETUP_FIRST_GROUP_ORDER: readonly SidebarGroup[] = [
  "Setup",
  "Operator",
  "Cluster",
  "Node service",
  "Chain",
];

// Pure sub-flows and one-shot utilities that are entered from inside another
// flow, not the rail. The root redirect (`/`) and the headless Ask backing
// route (`/ask`, if registered) are excluded the same way.
const HIDDEN_PATHS = new Set([
  "/",
  "/ask",
  "/welcome",
  "/setup-operator",
  "/setup-cluster",
]);

function sidebarLabel(path: string, label: string): string {
  if (path === "/setup") return "Setup";
  return label;
}

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
  // Surface the Setup group FIRST while no operator key is stored.
  const presence = useKeychainPresence();
  const order =
    !presence.checking && !presence.hasOperatorKey ? SETUP_FIRST_GROUP_ORDER : GROUP_ORDER;
  // Every registered surface except sub-flows / utilities. Preview routes
  // (mock-data design screens) stay reachable via ⌘K / URL but off the rail.
  const sidebarRoutes = NAV_ROUTES.filter((r) => !HIDDEN_PATHS.has(r.path) && !r.preview);
  const grouped: { label: SidebarGroup; items: NavRoute[] }[] = order
    .map((label) => ({
      label,
      items: sidebarRoutes.filter((r) => r.group === label),
    }))
    .filter((group) => group.items.length > 0);
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

      {grouped.map((group) => (
        <div className="monarch-sidenav__group" key={group.label}>
          <div className="monarch-sidenav__group-label">{group.label}</div>
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
                >
                  <span className="monarch-sidenav__item-main">
                    <span className="monarch-sidenav__icon" aria-hidden>
                      <RouteIcon path={item.path} size={14} />
                    </span>
                    <span>{sidebarLabel(item.path, item.label)}</span>
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="monarch-sidenav__footer">
        <b>
          <span className={status.reachable ? "dot dot--pulse" : "dot"} />{" "}
          {status.reachable ? "connected node" : "node not connected"}
        </b>
        <span className="monarch-sidenav__pair">{rpcEndpoint}</span>
        {chainId !== null ? (
          <span style={{ fontSize: 10, color: "var(--fg-500)" }}>
            network {chainId}
          </span>
        ) : null}
      </div>
    </nav>
  );
}
