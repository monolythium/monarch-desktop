// Single route registry consumed by SideNav, the ⌘K palette, and the
// `g+letter` nav-keys hook. Mirror of design_handoff_monarch's "Screens"
// list — adding a new top-level surface means appending one entry here.

export type NavRoute = {
  path: string;
  label: string;
  /** `g+letter` chord that jumps to this route (e.g. "h" for `g h`). */
  chord: string;
  hint: string;
  group: "Operations" | "Observability" | "Setup";
  icon: string;
  /** Extra search keywords for the fuzzy palette. */
  keywords: string[];
};

export const NAV_ROUTES: ReadonlyArray<NavRoute> = [
  {
    path: "/home",
    label: "Home",
    chord: "h",
    hint: "g h",
    group: "Operations",
    icon: "HM",
    keywords: ["cockpit", "dashboard", "round", "block"],
  },
  {
    path: "/operator",
    label: "Operator",
    chord: "v",
    hint: "g v",
    group: "Operations",
    icon: "OP",
    keywords: ["operator", "moniker", "keys", "jail", "signing"],
  },
  {
    path: "/cluster",
    label: "Cluster",
    chord: "c",
    hint: "g c",
    group: "Operations",
    icon: "CL",
    keywords: ["cluster", "dvt", "ring", "members", "threshold"],
  },
  {
    path: "/operations",
    label: "Operations",
    chord: "o",
    hint: "g o",
    group: "Operations",
    icon: "OA",
    keywords: ["operations", "ops", "verbs", "drawer"],
  },
  {
    path: "/metrics",
    label: "Metrics",
    chord: "m",
    hint: "g m",
    group: "Observability",
    icon: "MT",
    keywords: ["metrics", "telemetry", "prom", "grafana"],
  },
  {
    path: "/hardware",
    label: "Hardware",
    chord: "d",
    hint: "g d",
    group: "Observability",
    icon: "HW",
    keywords: ["hardware", "host", "cpu", "nvme", "memory", "network"],
  },
  {
    path: "/logs",
    label: "Logs",
    chord: "l",
    hint: "g l",
    group: "Observability",
    icon: "LG",
    keywords: ["logs", "journal", "tail", "filter"],
  },
  {
    path: "/chat",
    label: "Chat",
    chord: "t",
    hint: "g t",
    group: "Operations",
    icon: "CH",
    keywords: ["chat", "message", "cluster", "operators", "signed", "gossip"],
  },
  {
    path: "/install",
    label: "Install",
    chord: "i",
    hint: "g i",
    group: "Setup",
    icon: "IN",
    keywords: ["install", "wizard", "setup", "onboard", "ssh"],
  },
];

/** Lookup by `g+letter` chord. Returns the route path, or null. */
export function routeForChord(chord: string): string | null {
  const c = chord.toLowerCase();
  return NAV_ROUTES.find((r) => r.chord === c)?.path ?? null;
}
