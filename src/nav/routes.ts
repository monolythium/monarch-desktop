// Single route registry consumed by SideNav, the ⌘K palette, and the
// `g+letter` nav-keys hook. Mirrors the current Monarch design route
// set; adding a new top-level surface means appending one entry here.

export type NavRoute = {
  path: string;
  label: string;
  /** `g+letter` chord that jumps to this route (e.g. "h" for `g h`). */
  chord: string;
  hint: string;
  group: "Operator" | "Cluster" | "Node service" | "Chain" | "Setup";
  icon: string;
  /** Extra search keywords for the fuzzy palette. */
  keywords: string[];
  /**
   * Mock-data design preview, not a shipping feature. These routes stay
   * registered (the ⌘K palette, `g+letter` chords, and design-parity / e2e
   * coverage still reach them) but the sidebar groups them under a clearly
   * labelled "Preview" section so a brand-new operator isn't fooled into
   * thinking the placeholder screens are live. See SideNav.
   */
  preview?: boolean;
};

export const NAV_ROUTES: ReadonlyArray<NavRoute> = [
  {
    path: "/home",
    label: "Home",
    chord: "h",
    hint: "g h",
    group: "Operator",
    icon: "HM",
    keywords: ["cockpit", "dashboard", "round", "block"],
  },
  {
    path: "/operator",
    label: "Operator",
    chord: "v",
    hint: "g v",
    group: "Operator",
    icon: "OP",
    keywords: ["operator", "moniker", "keys", "removal", "signing"],
  },
  {
    path: "/hardware",
    label: "Hardware",
    chord: "d",
    hint: "g d",
    group: "Operator",
    icon: "HW",
    keywords: ["hardware", "host", "cpu", "nvme", "memory", "network"],
  },
  {
    path: "/operations",
    label: "Operations",
    chord: "o",
    hint: "g o",
    group: "Operator",
    icon: "OA",
    keywords: ["operations", "ops", "verbs", "drawer"],
  },
  {
    path: "/wallets",
    label: "Treasury",
    chord: "w",
    hint: "g w",
    group: "Operator",
    icon: "TR",
    keywords: ["wallet", "treasury", "bond", "fee", "stake", "redelegate"],
    preview: true,
  },
  {
    path: "/audit",
    label: "Audit",
    chord: "a",
    hint: "g a",
    group: "Operator",
    icon: "AU",
    keywords: ["audit", "receipts", "hash", "trail"],
    preview: true,
  },
  {
    path: "/cluster",
    label: "Cluster",
    chord: "c",
    hint: "g c",
    group: "Cluster",
    icon: "CL",
    keywords: ["cluster", "dvt", "ring", "members", "threshold"],
  },
  {
    path: "/ceremony",
    label: "Ceremony",
    chord: "f",
    hint: "g f",
    group: "Cluster",
    icon: "CY",
    keywords: ["ceremony", "form", "cluster", "lobby", "roster", "consent", "dkg"],
  },
  {
    path: "/chat",
    label: "Chat",
    chord: "t",
    hint: "g t",
    group: "Cluster",
    icon: "CH",
    keywords: ["chat", "message", "cluster", "operators", "signed", "gossip"],
  },
  {
    path: "/marketplace",
    label: "Marketplace",
    chord: "p",
    hint: "g p",
    group: "Cluster",
    icon: "MP",
    keywords: ["marketplace", "providers", "clusters", "seat", "join"],
    preview: true,
  },
  {
    path: "/services",
    label: "Services",
    chord: "s",
    hint: "g s",
    group: "Node service",
    icon: "SV",
    keywords: ["services", "roles", "router", "prover", "oracle", "bridge"],
    preview: true,
  },
  {
    path: "/metrics",
    label: "Metrics",
    chord: "m",
    hint: "g m",
    group: "Node service",
    icon: "MT",
    keywords: ["metrics", "telemetry", "prom", "grafana"],
  },
  {
    path: "/logs",
    label: "Logs",
    chord: "l",
    hint: "g l",
    group: "Node service",
    icon: "LG",
    keywords: ["logs", "journal", "tail", "filter"],
  },
  {
    path: "/governance",
    label: "Governance",
    chord: "g",
    hint: "g g",
    group: "Chain",
    icon: "GV",
    keywords: ["governance", "proposal", "memo", "vote", "signal"],
    preview: true,
  },
  {
    path: "/alerts",
    label: "Alerts",
    chord: "e",
    hint: "g e",
    group: "Chain",
    icon: "AL",
    keywords: ["alerts", "rules", "notifications", "incident"],
    preview: true,
  },
  {
    path: "/setup",
    label: "Setup wizard",
    chord: "n",
    hint: "g n",
    group: "Setup",
    icon: "SW",
    keywords: ["setup", "wizard", "first run", "connect", "node", "url", "onboard", "start", "begin", "get started"],
  },
  {
    path: "/welcome",
    label: "Setup status",
    chord: "b",
    hint: "g b",
    group: "Setup",
    icon: "WL",
    keywords: ["welcome", "onboarding", "first run", "checklist", "status", "progress", "detected", "begin"],
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
  {
    path: "/setup-operator",
    label: "Set up operator",
    chord: "u",
    hint: "g u",
    group: "Setup",
    icon: "SO",
    keywords: ["setup", "operator", "register", "pqm1", "key"],
  },
  {
    path: "/setup-cluster",
    label: "Set up cluster",
    chord: "r",
    hint: "g r",
    group: "Setup",
    icon: "SC",
    keywords: ["setup", "cluster", "join", "form", "dkg"],
  },
  {
    path: "/attestation",
    label: "Attestation",
    chord: "q",
    hint: "g q",
    group: "Setup",
    icon: "AT",
    keywords: ["attestation", "ota", "upgrade", "release", "digest"],
    preview: true,
  },
  {
    path: "/keys",
    label: "Keys",
    chord: "k",
    hint: "g k",
    group: "Setup",
    icon: "KY",
    keywords: ["keys", "pqm1", "mnemonic", "dkg", "backup"],
  },
  {
    path: "/recovery",
    label: "Recovery",
    chord: "y",
    hint: "g y",
    group: "Setup",
    icon: "RC",
    keywords: ["recovery", "restore", "incident", "backup", "emergency"],
    preview: true,
  },
];

/** Lookup by `g+letter` chord. Returns the route path, or null. */
export function routeForChord(chord: string): string | null {
  const c = chord.toLowerCase();
  return NAV_ROUTES.find((r) => r.chord === c)?.path ?? null;
}
