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

type SidebarGroup = "Start" | "Operate" | "Node" | "System";

const GROUP_ORDER: readonly SidebarGroup[] = ["Start", "Operate", "Node", "System"];
const SETUP_FIRST_GROUP_ORDER: readonly SidebarGroup[] = ["Start", "Operate", "Node", "System"];

// Keep the primary rail calm. All routes remain searchable through Cmd+K and
// reachable by URL; the sidebar only shows the surfaces a new operator needs
// every day.
const SIDEBAR_PATHS = new Set([
  "/setup",
  "/home",
  "/operator",
  "/cluster",
  "/operations",
  "/services",
  "/hardware",
  "/metrics",
  "/logs",
  "/settings",
]);

function sidebarGroup(path: string): SidebarGroup {
  if (path === "/setup" || path === "/home") return "Start";
  if (
    path === "/services" ||
    path === "/hardware" ||
    path === "/metrics" ||
    path === "/logs"
  )
    return "Node";
  if (path === "/settings") return "System";
  return "Operate";
}

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
  // Surface the Setup group FIRST while no operator key is stored — a
  // brand-new operator should see the wizard / Install / Keys before dashboards.
  const presence = useKeychainPresence();
  const order =
    !presence.checking && !presence.hasOperatorKey ? SETUP_FIRST_GROUP_ORDER : GROUP_ORDER;
  const sidebarRoutes = NAV_ROUTES.filter((r) => SIDEBAR_PATHS.has(r.path) && !r.preview);
  const grouped: { label: SidebarGroup; items: typeof sidebarRoutes }[] = order
    .map((label) => ({
      label,
      items: sidebarRoutes.filter((r) => sidebarGroup(r.path) === label),
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
                    <span className="monarch-sidenav__icon" aria-hidden>{item.icon}</span>
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
