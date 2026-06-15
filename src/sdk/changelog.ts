// Bundled, in-app changelog for Monarch Desktop itself (distinct from the
// protocore NODE release feed in the topbar). Shipped with the app so it always
// renders offline. Add a new entry at the TOP when you bump the version — keep
// the highlights short and operator-facing (what changed for the user), not
// commit-speak. Newest first.

export type ChangelogEntry = {
  version: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  highlights: string[];
};

export const APP_CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.0.40",
    date: "2026-06-15",
    highlights: [
      "Health: a healthy, synced node no longer shows as \"Booting / Ready: false\" or a red ext-protocore card when your RPC profile disables the eth_* methods — any JSON-RPC answer (even \"method disabled\") now counts as serving, with a lyth_chainStatus / lyth_syncStatus fallback.",
      "Operations: restarting a relay / non-consensus node no longer shows cluster-0 quorum math or a \"seat not matched\" note — it now says plainly that the node has no committee/quorum impact.",
      "Logs: the panel now actually streams your node's protocore logs instead of sitting on \"Waiting for logs\" — it reads ext-protocore as a Talos service log and renders protocore's JSON and plain-text lines.",
      "Logs: a log management strip shows the real size of /var/lib/protocore/logs, with \"Set log retention\" to cap its growth and \"Clean up logs\" to apply the cap and restart the node service.",
      "Node version: an unreleased/dev build now shows honestly as \"node: dev <commit>\" (it still offers the latest signed release to apply) instead of the alarming \"could not match\" error.",
    ],
  },
  {
    version: "0.0.39",
    date: "2026-06-14",
    highlights: [
      "Changelog: this view — see what changed in each Monarch Desktop release, right in the app (Settings → Changelog).",
    ],
  },
  {
    version: "0.0.38",
    date: "2026-06-14",
    highlights: [
      "Consensus activity: the round-detail popover now opens above the cards instead of hiding behind the ones below it.",
    ],
  },
  {
    version: "0.0.37",
    date: "2026-06-14",
    highlights: [
      "Home: a clear node-status hero up top — Ready / Syncing / Unreachable, with how far behind the committee you are, plus chain id, round, block and RPC endpoint.",
    ],
  },
  {
    version: "0.0.36",
    date: "2026-06-14",
    highlights: [
      "Node updates: opening the version dropdown now re-checks for a node update on the spot (button: \"Check for node updates\") — no need to restart the app.",
      "Protocore release notes now render in the dropdown.",
    ],
  },
  {
    version: "0.0.35",
    date: "2026-06-14",
    highlights: [
      "Recovery: a one-click \"Bootstrap node (etcd)\" action for a node stuck at \"booting\", and Wipe & re-provision now bootstraps automatically so a wiped node comes back \"ready\".",
    ],
  },
  {
    version: "0.0.34",
    date: "2026-06-14",
    highlights: [
      "Topbar: round and block are no longer conflated (round was showing the block height).",
      "Update and consensus dropdowns are now solid instead of see-through.",
    ],
  },
  {
    version: "0.0.33",
    date: "2026-06-14",
    highlights: [
      "Operator profile: the funding address is shown in the bech32m mono1… form (the raw 0x hex is rejected by send paths).",
    ],
  },
  {
    version: "0.0.32",
    date: "2026-06-14",
    highlights: [
      "Operator registration no longer gets stuck — the wizard advances when the transaction completes, and a guard stops the duplicate/underpriced resubmit.",
      "Fund the bond: clear path to request the 5,000 LYTH from the team in the testnet Discord.",
      "ext-protocore no longer shows \"degraded\" while it is actually serving chain data.",
    ],
  },
  {
    version: "0.0.31",
    date: "2026-06-14",
    highlights: [
      "Operations → Wipe node data & re-provision: recover a node wedged off the chain head (it re-fast-syncs from a checkpoint).",
      "Logs: the panel primes with a recent tail so it is not blank.",
      "Setup sync step no longer reports \"synced\" at height 0.",
    ],
  },
  {
    version: "0.0.30",
    date: "2026-06-14",
    highlights: [
      "Topbar: always-visible node version with a protocore release dropdown to review and apply node updates.",
    ],
  },
  {
    version: "0.0.29",
    date: "2026-06-14",
    highlights: [
      "Node update notifications — see when a new signed protocore release is available and apply it through the guarded drawer.",
    ],
  },
  {
    version: "0.0.23",
    date: "2026-06-13",
    highlights: [
      "Live RPC transport with honest surfaces and an Operations redesign.",
    ],
  },
  {
    version: "0.0.22",
    date: "2026-06-12",
    highlights: ["Working in-app node provisioning, end to end."],
  },
  {
    version: "0.0.20",
    date: "2026-06-11",
    highlights: [
      "Full Talos cluster PKI generated node-side, with a bring-up progress bar.",
    ],
  },
];
