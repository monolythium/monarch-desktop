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
    version: "0.0.48",
    date: "2026-06-17",
    highlights: [
      "Hardware: the view now shows your node's live disk, CPU, and memory — per-mount usage bars, CPU busy %, and RAM used — pulled read-only straight from the node. It also tracks how fast the data disk is growing (24h / 48h / 72h) and estimates when it will fill up. On first open, before any local history has built up, it estimates the pace from the node's own log/data-dir size over its uptime, then refines it as Monarch records samples (which persist across restarts). When the disk is projected to fill soon you get a clear warning with a one-click \"Clean up logs\" button — the warning is also the fix. As always, it only reads; it never changes anything on the node.",
      "Logs: fixed the live log stream failing with \"namespace can't be empty\". Monarch now reads ext-protocore from the Talos `system` namespace (matching `talosctl logs`), so the stream actually opens on current Monarch OS / Talos builds.",
    ],
  },
  {
    version: "0.0.47",
    date: "2026-06-17",
    highlights: [
      "Logs: a node-status header now sits at the top of the page and shows your node's live Stage, health, hostname, Talos version, uptime, address, and the ext-protocore / kubelet service states — pulled read-only straight from the node, so you no longer need to open the VNC console just to check status. It reads only; it never changes anything on the node, and any field the node can't report shows a quiet \"—\" rather than an error.",
    ],
  },
  {
    version: "0.0.46",
    date: "2026-06-17",
    highlights: [
      "OS upgrade: after you apply an upgrade, Monarch now confirms the node came back on the NEW version — not just that it's reachable. It watches the node's running build and shows clear progress (\"upgrading…\") through the reboot and catch-up window (a full controlplane reconverge can take up to ~20 minutes) instead of looking stuck or like it failed. If the node truly does not move onto the new build, you get a plain \"not confirmed\" with a one-click Retry — never a red error.",
      "Node version: the node now shows its release tag (e.g. v0.1.60-testnet) instead of a bare commit. During an upgrade it shows the tag you just applied, so you don't briefly see the old build's \"dev <commit>\" while the node catches up.",
      "Logs: when the log stream can't be read, the panel now shows the real reason instead of a generic \"check the connection\" — and notes the node may still be healthy, since other operations use the same API.",
    ],
  },
  {
    version: "0.0.45",
    date: "2026-06-17",
    highlights: [
      "Recover a node without losing its operator seat: a new \"Re-provision with existing keys\" flow re-installs a node from your operator mnemonic, re-deriving the same ML-DSA signing key so the bonded seat carries over. Use this — not a wipe — when a node needs a clean re-provision.",
      "Clearer, safer copy on \"Wipe node data & re-provision\": wiping does NOT preserve keys — it destroys the operator key and the bonded seat. The warning now says so plainly.",
    ],
  },
  {
    version: "0.0.43",
    date: "2026-06-16",
    highlights: [
      "Operations and Settings no longer open to a blank page. A background layer was painting over views whose content didn't sit in a card, so those pages showed nothing — both views now render correctly.",
    ],
  },
  {
    version: "0.0.42",
    date: "2026-06-15",
    highlights: [
      "Logs: \"Set log retention\" and \"Clean up logs\" no longer fail with a Talos error (\"...doesn't contain v1alpha1 config, did you mean to patch the machine config instead?\"). Monarch now merges the size/file caps into your node's complete machine config and re-applies it, so the bound actually takes.",
      "Logs: a healthy node that simply has not logged much yet no longer shows the red \"Log stream failed. Check the Monarch OS connection.\" It now reads \"Stream open · quiet\" and fills in as the node writes lines; the hard error only appears when the node truly can't be reached.",
    ],
  },
  {
    version: "0.0.41",
    date: "2026-06-15",
    highlights: [
      "OS upgrade: \"Apply OS upgrade\" no longer false-fails with \"Could not reach the node\" when your RPC profile disables the eth_* methods — a node that answers anything (even \"method disabled\") now counts as reachable, so the upgrade is allowed.",
      "OS upgrade: the node reboot after an image upgrade is no longer reported as a failure. The \"transport error\" you saw was the node rebooting into the new image — the upgrade was already accepted. Monarch now says \"Upgrade dispatched — node is rebooting\" and reconnects automatically once it is back.",
      "Provisioning: new nodes are now installed with the v0.1.59-testnet protocore / Monarch OS image (was v0.1.56).",
    ],
  },
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
