// 220px sidebar — Monarch Desktop nav. Routes are sourced from
// `nav/routes.ts` so SideNav, the ⌘K palette, and the `g+letter`
// nav-keys hook share one registry. Active item gets a gold halo
// accent (gold-discipline rule: primary action only).

import { NavLink } from "react-router-dom";
import { NAV_ROUTES } from "../nav/routes";
import { useKeychainPresence } from "../hooks/useSelfOperator";
import { rpcEndpoint, useChainStatus, useNodeStatus } from "../sdk";

const GROUP_ORDER = ["Operator", "Cluster", "Node service", "Chain", "Setup"] as const;
const SETUP_FIRST_GROUP_ORDER = ["Setup", "Operator", "Cluster", "Node service", "Chain"] as const;

export function SideNav() {
  const status = useNodeStatus();
  const chain = useChainStatus();
  // Surface the Setup group FIRST while no operator key is stored — a
  // brand-new operator should see Welcome/Install/Keys before dashboards.
  const presence = useKeychainPresence();
  const order =
    !presence.checking && !presence.hasOperatorKey ? SETUP_FIRST_GROUP_ORDER : GROUP_ORDER;
  const grouped = order.map((label) => ({
    label,
    items: NAV_ROUTES.filter((r) => r.group === label),
  }));
  const chainId = chain.data?.chainId ?? status.chainId;

  return (
    <nav className="monarch-sidenav" aria-label="Primary">
      <div className="monarch-sidenav__brand">
        <div className="monarch-sidenav__mark" aria-hidden />
        <div className="monarch-sidenav__name">
          Monarch
          <small>Operator console <span>v0.9β</span></small>
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
                    <span>{item.label}</span>
                  </span>
                  <span className="monarch-sidenav__hint">{item.hint}</span>
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
        <span style={{ fontSize: 10, color: "var(--fg-500)" }}>
          chain_id {chainId ?? "—"}
        </span>
      </div>
    </nav>
  );
}
