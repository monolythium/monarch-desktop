// Canonical Operations catalog. Single source of truth for operator and
// recovery actions shown in Operations, the command palette, and guided flows.

import type { OpRequest } from "./types";

export type OpCategory =
  | "system"
  | "keys"
  | "cluster"
  | "treasury"
  | "emergency";

export type OpCatalogEntry = OpRequest & {
  category: OpCategory;
  /** Short keywords surfaced to the fuzzy matcher. */
  keywords?: string[];
};

export const OP_CATALOG: ReadonlyArray<OpCatalogEntry> = [
  {
    kind: "operator-register",
    category: "cluster",
    icon: "RG",
    risk: "high",
    title: "Register operator",
    sub: "Submit register tx with bond",
    intro:
      "Locks your bond (5,000 LYTH minimum on testnet) and lists your node on-chain so clusters can admit you. The bond is paid from your operator wallet and is refundable after you resign and the delay passes.",
    technical:
      "Posts a signed register tx to precompile 0x1005 from the operator's PQM-1 mnemonic. Locks the bond (sourced from the same wallet's native balance), publishes the endpoint + capabilities, and binds the derived ML-DSA-65 consensus pubkey plus possession proof into the node-registry. Operator self-signed; no foundation multisig required.",
    destructive: false,
    needsPasskey: true,
    confirmLabel: "Sign register tx",
    keywords: ["register", "onboard", "node", "registry", "bond", "operator"],
    effects: [
      "Bond locked from the operator's wallet for the registration epoch.",
      "Endpoint + capabilities published to the on-chain registry.",
      "ML-DSA-65 consensus pubkey + possession proof committed; the cluster can attest to this operator from the next round.",
    ],
    diff: [
      { key: "status", label: "Status", value: "+ registered" },
      { key: "bond", label: "Bond", value: "+ locked" },
    ],
    fields: [
      { key: "endpoint",      label: "Endpoint",      value: "https://node.example" },
      { key: "capabilities",  label: "Capabilities",  value: "rpc | indexer | broadcaster" },
      { key: "bond",          label: "Bond",          value: "operator-supplied" },
    ],
  },
  {
    kind: "operator-restore",
    category: "cluster",
    icon: "UJ",
    risk: "medium",
    title: "Restore operator",
    sub: "Submit recovery transaction",
    intro:
      "Brings a removed operator back into rotation after an incident. Run this only when you have been asked to perform recovery.",
    technical:
      "Posts recoverOperatorNode(bytes32) to node-registry 0x1005 using the recovery authorization stored for this install.",
    destructive: false,
    needsPasskey: true,
    confirmLabel: "Sign recovery tx",
    keywords: ["restore", "removal", "resume", "rejoin", "missed", "rounds"],
    effects: [
      "Builds recoverOperatorNode(peerId) calldata against node-registry 0x1005.",
      "Reads recovery authorization from the OS keychain only during signing.",
      "Records the submitted recovery transaction hash in the local audit trail.",
    ],
    diff: [
      { key: "status", label: "Status", value: "+ recovery tx" },
      { key: "rotation", label: "Rotation", value: "unchanged" },
    ],
    fields: [
      { key: "peer-id", label: "Peer id", value: "32-byte node-registry peer id" },
      { key: "executor", label: "Executor", value: "recoverOperatorNode(bytes32)" },
      { key: "authorization", label: "Authorization", value: "recovery keychain entry" },
    ],
  },
  {
    kind: "operator-display",
    category: "cluster",
    icon: "ID",
    risk: "medium",
    title: "Set operator name",
    sub: "Update your public operator profile",
    intro:
      "Publishes the public, human-readable name other operators and explorers see for your node. Empty fields clear the stored values.",
    technical:
      "Updates the public name and short alias attached to your operator. Monarch signs once with your stored operator key and publishes the change on-chain.",
    destructive: false,
    needsPasskey: true,
    confirmLabel: "Approve name update",
    keywords: ["name", "moniker", "alias", "display", "metadata", "operator"],
    effects: [
      "Updates the public name and alias shown in Monoscan and Monarch Desktop.",
      "Uses your stored operator key only for the approval step.",
      "Empty fields clear the existing public text.",
    ],
    diff: [
      { key: "display", label: "Operator profile", value: "+ public name/alias" },
      { key: "visible", label: "Visible in", value: "Monoscan and Monarch Desktop" },
    ],
    fields: [
      { key: "peer-id", label: "Operator ID", value: "your registered operator" },
      { key: "moniker", label: "Public name", value: "shown in operator lists" },
      { key: "alias", label: "Short alias", value: "optional" },
    ],
  },
  {
    kind: "operator-seal-key",
    category: "cluster",
    icon: "SK",
    risk: "medium",
    title: "Publish seal key",
    sub: "Publish your public seal key",
    intro:
      "Publishes your public seal key so a cluster can include you in sealed-mempool duty. It is safe to publish — only your node holds the private half. Required before you can request a cluster seat.",
    technical:
      "Publishes the public seal key read from your Monarch OS node. The private key never leaves the node.",
    destructive: false,
    needsPasskey: true,
    confirmLabel: "Approve seal key",
    keywords: ["seal", "lythiumseal", "ek", "ml-kem", "operator", "join"],
    effects: [
      "Makes your public seal key available for cluster admission and sealed-mempool duty.",
      "Reads the public key from the connected Monarch OS node when available.",
      "Uses your stored operator key only for the approval step.",
    ],
    diff: [
      { key: "seal", label: "Seal key", value: "+ public key" },
      { key: "used-for", label: "Used for", value: "cluster admission and sealed mempool" },
    ],
    fields: [
      { key: "peer-id", label: "Operator ID", value: "your registered operator" },
      { key: "seal-key", label: "Seal key", value: "public key from your node" },
      { key: "private-key", label: "Private key", value: "stays on your node" },
    ],
  },
  {
    kind: "chat-bootstrap-peers",
    category: "cluster",
    icon: "CP",
    risk: "medium",
    title: "Publish chat peers",
    sub: "Submit operator chat metadata",
    intro:
      "Publishes the network addresses other operators use to reach you in operator chat. Also a precondition for taking part in a cluster-formation ceremony.",
    technical:
      "Posts a signed setChatBootstrapPeers(bytes32,bytes) tx to node-registry 0x1005 from the operator's PQM-1 mnemonic. The stored libp2p multiaddrs feed lyth_getOperatorNetworkMetadata(...).chat.bootstrapPeers so Desktop release e2e and live operator chat can discover bootstrap peers without private local config.",
    destructive: false,
    needsPasskey: true,
    confirmLabel: "Sign chat metadata tx",
    keywords: ["chat", "bootstrap", "peers", "libp2p", "metadata", "operator"],
    effects: [
      "Builds setChatBootstrapPeers(peerId, peers) calldata against node-registry 0x1005.",
      "Signs the zero-value native tx from the operator keychain mnemonic.",
      "Publishes the bounded libp2p multiaddr list for cluster chat discovery.",
    ],
    diff: [
      { key: "chat", label: "Chat metadata", value: "+ bootstrap peers" },
      { key: "source", label: "Discovery", value: "lyth_getOperatorNetworkMetadata.chat" },
    ],
    fields: [
      { key: "peer-id", label: "Peer id", value: "32-byte node-registry peer id" },
      { key: "peers", label: "Peers", value: "libp2p multiaddrs, max 256 bytes" },
      { key: "executor", label: "Executor", value: "setChatBootstrapPeers(bytes32,bytes)" },
    ],
  },
  {
    kind: "cluster-name-register",
    category: "cluster",
    icon: "CN",
    risk: "medium",
    title: "Set cluster name",
    sub: "Register public cluster name",
    intro:
      "Gives your cluster a public, human-readable name that explorers and other operators see. Costs the on-chain annual registration fee.",
    technical:
      "Posts a signed register(string,uint64) tx to cluster-name registry 0x1104 from the cluster primary anchor key. Monoscan and Desktop read the resulting canonical name through lyth_getClusterName.",
    destructive: false,
    needsPasskey: true,
    confirmLabel: "Sign cluster name tx",
    keywords: ["cluster", "name", "moniker", "registry", "display"],
    effects: [
      "Builds register(name, clusterId) calldata against cluster-name registry 0x1104.",
      "Signs the plaintext native tx from the cluster primary anchor mnemonic.",
      "Pays the exact annual registration fee required by the on-chain name curve.",
    ],
    diff: [
      { key: "name", label: "Cluster name", value: "+ canonical name" },
      { key: "source", label: "Discovery", value: "lyth_getClusterName" },
    ],
    fields: [
      { key: "cluster", label: "Cluster id", value: "uint64 cluster id" },
      { key: "name", label: "Name", value: "3-32 lowercase letters" },
      { key: "executor", label: "Executor", value: "register(string,uint64)" },
    ],
  },
  {
    kind: "rotate-keys",
    category: "keys",
    icon: "KY",
    risk: "high",
    title: "Rotate signing share",
    sub: "Submit DKG re-share attestation",
    intro:
      "Records the result of a completed cluster key-share ceremony on-chain so the new signing shares can take effect. Run this only after the ceremony has finished and produced its output files.",
    technical:
      "After the key-share ceremony produces participant ML-DSA-65 consensus pubkeys and per-signer attestation signatures, Desktop submits the operator-signed attestDkgReshare(uint64,bytes,bytes) transaction that marks the Rotate intent as DKG-attested on node-registry 0x1005.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign DKG attestation",
    keywords: ["dkg", "rotate", "rotation", "share", "key", "rekey"],
    effects: [
      "Builds attestDkgReshare(intentId, consensusPublicKeys, attestationSigs) calldata against node-registry 0x1005.",
      "Signs the zero-value native tx from the operator keychain mnemonic.",
      "Records the submitted DKG attestation transaction hash in the local audit trail.",
    ],
    diff: [
      { key: "share", label: "Signing share", value: "ceremony output required" },
      { key: "attestation", label: "Attestation", value: "+ on-chain DKG flag" },
    ],
    fields: [
      { key: "intent", label: "Intent", value: "Rotate intent id" },
      { key: "pubkeys", label: "Consensus pubkeys", value: "5..7 unique ML-DSA-65 keys" },
      { key: "signature", label: "Attestation sigs", value: "one ML-DSA-65 sig per signer" },
    ],
  },
  {
    kind: "operator-restart",
    category: "system",
    icon: "RS",
    risk: "low",
    title: "Graceful restart",
    sub: "Cycle the operator-node service",
    intro:
      "Stops the service, lets the cluster maintain quorum without this operator, then rejoins after the service is healthy.",
    destructive: false,
    needsPasskey: true,
    keywords: ["restart", "reboot", "cycle", "systemd", "monod"],
    effects: [
      "Service drains before restart.",
      "Cluster remains above quorum while this node is away.",
      "Logs are tailed until healthy state returns.",
    ],
    diff: [
      { key: "service", label: "Service", value: "+ restart ext-protocore" },
      { key: "watch", label: "Health watch", value: "+ enabled" },
    ],
    fields: [
      { key: "node",     label: "Node",     value: "configured Talos node" },
      { key: "downtime", label: "Downtime", value: "operator-controlled" },
    ],
  },
  {
    kind: "set-log-retention",
    category: "system",
    icon: "LR",
    risk: "low",
    title: "Set log retention",
    sub: "Bound protocore log growth",
    intro:
      "Caps how large the node's protocore log can grow. The protocore log file appends without rotating, so it grows unbounded — this installs a size and rotated-file limit so it can no longer fill the disk.",
    technical:
      "Reads the node's current machine config, sets PROTOCORE_LOG_MAX_BYTES / PROTOCORE_LOG_MAX_FILES inside its existing protocore ExtensionServiceConfig document, and re-applies the COMPLETE merged config via the Talos ApplyConfiguration RPC in NoReboot mode — the immutable-node-correct way to change extension config. (A bare ExtensionServiceConfig full-apply is rejected by Talos because it carries no v1alpha1 config, so the whole config is merged and re-applied.) The node's own apply warnings/messages are returned verbatim. Restart ext-protocore (or use Clean up logs) for the new bound to take effect on the running process.",
    destructive: false,
    needsPasskey: true,
    keywords: ["log", "logs", "retention", "rotate", "rotation", "size", "disk", "cap", "limit"],
    effects: [
      "Merges the size/file caps into the node's complete machine config and re-applies it.",
      "Applied in NoReboot mode — the node is not cycled.",
      "Takes effect on the running process after the next ext-protocore restart.",
    ],
    diff: [
      { key: "maxBytes", label: "PROTOCORE_LOG_MAX_BYTES", value: "+ operator-supplied cap" },
      { key: "maxFiles", label: "PROTOCORE_LOG_MAX_FILES", value: "+ operator-supplied count" },
    ],
    fields: [
      { key: "maxSize", label: "Max size", value: "operator-supplied MB" },
      { key: "maxFiles", label: "Rotated files", value: "1..64" },
    ],
  },
  {
    kind: "clean-protocore-logs",
    category: "system",
    icon: "CL",
    risk: "high",
    title: "Clean up logs",
    sub: "Apply retention + restart",
    intro:
      "Bounds the protocore log and restarts the node service so the new limit takes effect. Note: Talos exposes no file-truncate, so this does not instantly zero the file — the bytes already on disk are reclaimed by the extension's rotation under the limit you set.",
    technical:
      "Merges the retention bound (PROTOCORE_LOG_MAX_BYTES / PROTOCORE_LOG_MAX_FILES) into the node's complete machine config and re-applies it via ApplyConfiguration, then issues a Talos ServiceRestart on ext-protocore so the append target re-opens under the new policy. The append: redirect re-opens the same file, so a restart alone does not shrink it; reclamation happens through the extension's rotation. The EPHEMERAL reset that would force-reclaim the bytes also nukes the chain DB, so it is deliberately NOT used here.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Apply retention & restart",
    keywords: ["log", "logs", "clean", "cleanup", "truncate", "rotate", "disk", "space", "restart"],
    effects: [
      "Re-applies the node's complete machine config with the protocore log size/file caps set.",
      "ext-protocore is restarted so the appender re-opens under the new bound.",
      "Existing bytes are reclaimed by the extension's rotation, not by a file truncate.",
    ],
    diff: [
      { key: "retention", label: "Log retention", value: "+ applied" },
      { key: "service", label: "Service", value: "+ restart ext-protocore" },
    ],
    fields: [
      { key: "maxSize", label: "Max size", value: "operator-supplied MB" },
      { key: "maxFiles", label: "Rotated files", value: "1..64" },
    ],
  },
  {
    kind: "operator-stop",
    category: "system",
    icon: "ST",
    risk: "high",
    title: "Stop operator node",
    sub: "Gracefully halt signing",
    intro:
      "Stops the operator node. Cluster continues to sign if quorum remains. Use only before maintenance windows.",
    destructive: true,
    needsPasskey: true,
    keywords: ["stop", "halt", "maintenance", "pause"],
    fields: [
      { key: "node",     label: "Node",     value: "configured Talos node" },
      { key: "duration", label: "Expected", value: "operator-controlled" },
    ],
  },
  {
    kind: "operator-start",
    category: "system",
    icon: "GO",
    risk: "low",
    title: "Start operator node",
    sub: "Bring the node online",
    intro:
      "Boots the operator-node service and rejoins the cluster at the next epoch boundary.",
    destructive: false,
    needsPasskey: true,
    keywords: ["start", "boot", "rejoin", "online"],
    fields: [
      { key: "node",   label: "Node",   value: "configured Talos node" },
      { key: "epoch",  label: "Rejoin", value: "next epoch boundary" },
    ],
  },
  {
    kind: "redelegate",
    category: "treasury",
    icon: "RD",
    risk: "high",
    title: "Redelegate stake",
    sub: "Submit delegation tx",
    intro:
      "Moves your delegated LYTH weight from one cluster to another. Your funds never leave your control — only which cluster's rewards you share in changes.",
    technical:
      "Posts a signed redelegate tx to the delegation precompile from the operator's PQM-1 mnemonic. Moves the caller's delegation weight from the source cluster to the destination cluster after chain confirmation.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign redelegate tx",
    keywords: ["bond", "redelegate", "stake", "move"],
    effects: [
      "Delegation precompile receives redelegate(fromCluster, toCluster, weightBps).",
      "Native value remains zero; only the existing delegation row is updated.",
      "Operation receipt records the transaction hash for audit.",
    ],
    diff: [
      { key: "from", label: "From", value: "- source cluster weight" },
      { key: "to", label: "To", value: "+ destination cluster weight" },
    ],
    fields: [
      { key: "from", label: "From cluster", value: "operator-supplied uint32" },
      { key: "to", label: "To cluster", value: "operator-supplied uint32" },
      { key: "weight", label: "Weight", value: "1..10000 bps" },
    ],
  },
  {
    kind: "export-backup",
    category: "keys",
    icon: "BK",
    risk: "medium",
    title: "Export backup",
    sub: "Export stopped Protocore data",
    intro:
      "Saves an offline copy of your node's chain data to this computer. The node service must already be stopped — hot backups are not supported.",
    technical:
      "Exports /var/lib/protocore through the Talos Copy API as a local .tar.gz plus a manifest. This is an offline backup path only: Desktop refuses to run unless ext-protocore is already stopped or offline.",
    destructive: false,
    needsPasskey: true,
    confirmLabel: "Export offline backup",
    keywords: ["backup", "export", "tarball", "keystore", "snapshot"],
    effects: [
      "Talos streams /var/lib/protocore to the local backup directory.",
      "The archive and manifest SHA-256 digests are recorded in the receipt.",
      "The operation fails closed if ext-protocore is running; hot backups are not supported.",
    ],
    diff: [
      { key: "archive", label: "Archive", value: "+ local protocore-*.tar.gz" },
      { key: "manifest", label: "Manifest", value: "+ local protocore-*.backup.json" },
    ],
    fields: [
      { key: "scope", label: "Scope", value: "/var/lib/protocore" },
      { key: "transport", label: "Transport", value: "Talos Copy API" },
      { key: "requirement", label: "Requirement", value: "ext-protocore stopped/offline" },
    ],
  },
  {
    kind: "ota-apply",
    category: "system",
    icon: "UP",
    risk: "high",
    title: "Apply OS upgrade",
    sub: "Talos image upgrade",
    intro:
      "Upgrades your node's operating system to a new signed release image. Your chain data survives the upgrade; the node reboots into the new image unless you stage it.",
    technical:
      "Calls the Talos Upgrade RPC against the trusted node context. Desktop enforces preserve=true so /var/lib/protocore survives the OS image replacement; use the image reference produced by the upgrade-readiness runbook.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Submit Talos upgrade",
    keywords: ["upgrade", "ota", "image", "talos", "release"],
    effects: [
      "Talos downloads the supplied signed image reference.",
      "The OS partitions are replaced while the persistent /var partition is preserved.",
      "Unless staged, the node reboots into the new image after Talos accepts the request.",
    ],
    diff: [
      { key: "image", label: "Image", value: "operator-supplied release image" },
      { key: "preserve", label: "Preserve data", value: "true (/var/lib/protocore)" },
      { key: "reboot", label: "Reboot", value: "Talos default unless staged" },
    ],
    fields: [
      { key: "image", label: "Image", value: "required registry reference" },
      { key: "preserve", label: "Preserve", value: "true" },
      { key: "stage", label: "Stage only", value: "operator-selected" },
    ],
  },
  {
    kind: "ota-rollback",
    category: "system",
    icon: "RB",
    risk: "high",
    title: "Rollback OS image",
    sub: "Talos rollback",
    intro:
      "Reboots your node into the previous operating-system image. Use only when the current image is broken and you have confirmed the older build can still read your node's data.",
    technical:
      "Calls the Talos Rollback RPC against the trusted node context. Use only after confirming the previous Protocore build can read the current /var/lib/protocore state.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Submit Talos rollback",
    keywords: ["rollback", "ota", "image", "talos", "release"],
    effects: [
      "Talos reboots the node into the previous OS image.",
      "The persistent /var partition is not rewound.",
      "Rollback is unsafe for one-way state migrations unless the release runbook explicitly allows it.",
    ],
    diff: [
      { key: "image", label: "Image", value: "previous boot image" },
      { key: "data", label: "Persistent data", value: "preserved" },
    ],
    fields: [
      { key: "transport", label: "Transport", value: "Talos Rollback RPC" },
      { key: "preflight", label: "Preflight", value: "operator-confirmed compatibility" },
    ],
  },
  {
    kind: "operator-reprovision",
    category: "emergency",
    icon: "WP",
    risk: "high",
    title: "Wipe node data & re-provision",
    sub: "Talos reset · EPHEMERAL",
    intro:
      "Erases this node's chain data and reboots it for a clean re-sync. Use only when the node is wedged off the chain head — stuck at block 0 in dag-sync, or pinned behind its own proposer anchor — and a restart did not fix it. Your operator keys and Talos config are preserved; the node fast-syncs from a fresh database on the way back up.",
    technical:
      "Calls the Talos Reset RPC against the trusted node context with system_partitions_to_wipe=[EPHEMERAL] (graceful=false, reboot=true). EPHEMERAL (/var) holds /var/lib/protocore — the chain DB, the resolved genesis.toml, and config.toml. The STATE partition (machine config) is left intact, so the node reboots, re-applies its config, and the protocore entrypoint re-runs its first-boot path: it re-resolves the genesis hash and the [fast_sync] cold-start seed RPCs from the chain-registry, then fast-syncs from a quorum-verified checkpoint instead of replaying the (pruned) DAG from round 0.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Wipe data & reboot node",
    keywords: [
      "wipe",
      "reset",
      "re-provision",
      "reprovision",
      "fast-sync",
      "stuck",
      "block 0",
      "round 0",
      "dag-sync",
      "anchor",
      "recover",
    ],
    effects: [
      "Talos wipes the EPHEMERAL partition (/var/lib/protocore: chain DB, genesis.toml, config.toml) and reboots.",
      "Operator keys and the Talos machine config on the STATE partition are preserved.",
      "On reboot the node re-resolves genesis + cold-start fast-sync seeds and fast-syncs from a quorum-verified checkpoint — climbing off block 0 in minutes instead of dag-syncing a pruned DAG forever.",
    ],
    diff: [
      { key: "data", label: "Chain data (/var/lib/protocore)", value: "wiped" },
      { key: "keys", label: "Operator keys + machine config", value: "preserved" },
      { key: "recovery", label: "On reboot", value: "fresh fast-sync from checkpoint" },
    ],
    fields: [
      { key: "transport", label: "Transport", value: "Talos Reset RPC (EPHEMERAL)" },
      { key: "reboot", label: "Reboot", value: "automatic" },
    ],
  },
  {
    kind: "operator-bootstrap",
    category: "emergency",
    icon: "BS",
    risk: "low",
    title: "Bootstrap node (etcd)",
    sub: "Talos bootstrap · finish boot",
    intro:
      "One-time etcd bootstrap for a node stuck at \"booting\" on its console. A single-node Monarch OS controlplane needs its etcd bootstrapped once before it reports \"ready\" — most often after a wipe (which clears etcd). The chain (ext-protocore) serves RPC regardless, so this is non-destructive: it only finishes the machine's controlplane bring-up.",
    technical:
      "Calls the Talos Bootstrap RPC against the trusted node context (the in-app equivalent of `talosctl bootstrap`). Retries through a reboot until the secured API answers, then bootstraps etcd. Idempotent — a no-op if the node is already bootstrapped. Does not touch chain data.",
    destructive: false,
    needsPasskey: false,
    confirmLabel: "Bootstrap node",
    keywords: ["bootstrap", "etcd", "booting", "ready", "talos", "stuck", "controlplane"],
    effects: [
      "Submits the Talos etcd bootstrap to the connected node (idempotent).",
      "Leaves chain data untouched — ext-protocore keeps serving RPC throughout.",
      "The node should leave \"booting\" and report ready shortly after.",
    ],
    diff: [
      { key: "etcd", label: "etcd", value: "bootstrapped (once)" },
      { key: "chain", label: "Chain data", value: "untouched" },
    ],
    fields: [{ key: "transport", label: "Transport", value: "Talos Bootstrap RPC" }],
  },
  {
    kind: "cluster-form",
    category: "cluster",
    icon: "FC",
    risk: "high",
    title: "Form cluster",
    sub: "Prepare 7 active + 3 standby roster",
    intro:
      "Creates a brand-new cluster from 10 registered operators (7 active + 3 standby, 7 must agree to act). Every proposed member must sign consent to the exact roster before the chain accepts it.",
    technical:
      "Submits a self-service formCluster(bytes,bytes,bytes) transaction using the whitepaper topology: 10 operator seats, 7-of-10 threshold, 7 active operators, and 3 standby operators. Desktop validates the ML-DSA-65 consensus pubkeys, derives operator ids, and requires ten roster consent signatures before signing.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign formation",
    keywords: ["cluster", "form", "create", "roster", "standby", "active", "topology"],
    effects: [
      "Validates exactly 7 active and 3 standby ML-DSA-65 consensus pubkeys.",
      "Rejects malformed or duplicate consensus pubkeys before authorization.",
      "Preflights formCluster through eth_call, then signs with the active operator's PQM-1 mnemonic on compatible runtimes.",
    ],
    diff: [
      { key: "cluster", label: "Cluster", value: "+ roster proposal" },
      { key: "topology", label: "Topology", value: "7 active + 3 standby, 7-of-10" },
    ],
    fields: [
      { key: "active", label: "Active seats", value: "7 ML-DSA-65 consensus pubkeys" },
      { key: "standby", label: "Standby seats", value: "3 ML-DSA-65 consensus pubkeys" },
      { key: "executor", label: "Executor", value: "formCluster(bytes,bytes,bytes)" },
    ],
  },
  {
    kind: "cluster-update-charter",
    category: "cluster",
    icon: "UC",
    risk: "high",
    title: "Amend cluster charter",
    sub: "Change per-operator shares + delegator split",
    intro:
      "Changes how a live cluster splits its rewards: the per-operator seat shares and the operator/delegator split. 7 of the 10 currently-active operators must consent, and a notice period passes before the new terms take effect — the current terms stay in force until then, so delegators can leave first.",
    technical:
      "Submits updateCharter(uint32,bytes,bytes,bytes) to node-registry 0x1005 carrying the new 30-byte charter and the 7-of-10 active-member ML-DSA-65 consents over the PROTOCORE_NODE_REGISTRY_CLUSTER_UPDATE_CHARTER_V1 digest. The chain applies the charter only after the delegator-protective cooldown (2 epochs in production); the old terms apply until the effective epoch.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign charter amendment",
    keywords: ["cluster", "charter", "amend", "shares", "delegator", "split", "cooldown", "economics"],
    effects: [
      "Encodes the new 30-byte charter: per-seat operator shares (sum 10000 bps) and the delegator share (protocol floor 20%).",
      "Carries the active-member consent signatures; every signature verifies over the recomputed updateCharter digest.",
      "Applies the new terms only after the cooldown — the current terms apply until then, so delegators can undelegate first.",
    ],
    diff: [
      { key: "cluster", label: "Cluster", value: "charter amendment" },
      { key: "effective", label: "Effective", value: "after the cooldown (pending)" },
      { key: "executor", label: "Executor", value: "updateCharter(uint32,bytes,bytes,bytes)" },
    ],
    fields: [
      { key: "cluster", label: "Cluster", value: "operator-supplied uint32" },
      { key: "consents", label: "Consents", value: "7-of-10 active-member ML-DSA-65" },
      { key: "executor", label: "Executor", value: "updateCharter(uint32,bytes,bytes,bytes)" },
    ],
  },
  {
    kind: "cluster-request-join",
    category: "cluster",
    icon: "RJ",
    risk: "high",
    title: "Request cluster join",
    sub: "Ask a cluster for a seat",
    intro:
      "Asks an existing cluster for a seat. The current members vote on your request, and the chain admits you once enough votes land. Your seal key must be published first, and the bond travels with the request.",
    technical:
      "Prepares a self-service requestClusterJoin(uint32,bytes) admission request for the selected cluster. Desktop signs this from the operator PQM-1 mnemonic, attaches the bond as native value, and publishes the operator ML-DSA-65 consensus pubkey for cluster-member voting.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Approve join request",
    keywords: ["cluster", "join", "request", "admission", "cj-1", "self-service"],
    effects: [
      "Creates a pending admission request for the selected cluster.",
      "Uses your stored operator key only for the approval step.",
      "Checks that your public seal key is published before signing.",
    ],
    diff: [
      { key: "request", label: "Join request", value: "+ pending cluster vote" },
      { key: "seal-key", label: "Seal key", value: "must be published" },
    ],
    fields: [
      { key: "cluster", label: "Cluster", value: "selected cluster" },
      { key: "operator", label: "Operator", value: "your operator key" },
      { key: "bond", label: "Bond", value: "paid from your operator wallet" },
    ],
  },
  {
    kind: "cluster-vote-admit",
    category: "cluster",
    icon: "VA",
    risk: "high",
    title: "Vote to admit operator",
    sub: "Approve a pending cluster request",
    intro:
      "Casts your vote, as a current cluster member, to admit a candidate operator into your cluster. The chain tallies votes and admits the candidate when the cluster's policy threshold is reached.",
    technical:
      "Approves a pending admission request from a current cluster member. Monarch signs once with your stored operator key and the chain tallies the vote against the cluster policy.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign admit vote",
    keywords: ["cluster", "vote", "admit", "join", "candidate", "cj-1"],
    effects: [
      "Checks that the candidate has an open request before approval.",
      "Uses your stored operator key only for the approval step.",
      "Fails before signing if the candidate request is missing, closed, or already admitted.",
    ],
    diff: [
      { key: "vote", label: "Admission vote", value: "+ one member vote" },
      { key: "threshold", label: "Policy", value: "2f+1 cluster approval" },
    ],
    fields: [
      { key: "cluster", label: "Cluster", value: "selected cluster" },
      { key: "candidate", label: "Candidate", value: "operator requesting a seat" },
      { key: "voter", label: "Approver", value: "your operator" },
    ],
  },
  {
    kind: "cluster-resign",
    category: "cluster",
    icon: "RN",
    risk: "high",
    title: "Resign from cluster",
    sub: "Submit Q120 cluster resignation",
    intro:
      "Steps your operator down from its cluster. This cannot be undone: after a delay (24h on mainnet, shorter on testnet) your seat is freed and your bond becomes refundable.",
    technical:
      "Submits a self-signed Tx::ClusterResignation (kind 0x05) from the operator's PQM-1 mnemonic. The resigning operator's ML-DSA-65 consensus key signs the canonical frame and the chain resolves the cluster from on-chain membership — no cluster id is part of the signed payload. This is the GUI equivalent of the `operator resign` CLI verb.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign resignation",
    keywords: ["resign", "leave", "cluster", "step-down", "step down", "exit", "quit", "operator"],
    effects: [
      "Builds the canonical Tx::ClusterResignation frame (operator || nonce || flags || ML-DSA-65 sig).",
      "Signs the native frame with the operator keychain PQM-1 mnemonic and submits via lyth_submitClusterResignation.",
      "Queues the step-down; the slot frees and the bond-refund window opens after the resignation delay.",
    ],
    diff: [
      { key: "membership", label: "Membership", value: "- queued resignation" },
      { key: "bond", label: "Bond refund", value: "window opens after delay" },
    ],
    fields: [
      { key: "cluster", label: "Cluster id", value: "context only (resolved on-chain)" },
      { key: "nonce", label: "Resignation nonce", value: "operator-local, > last accepted" },
      { key: "expedite", label: "Foundation expedite", value: "off (executor-enforced)" },
    ],
  },
  {
    kind: "cluster-accept-invite",
    category: "cluster",
    icon: "IN",
    risk: "high",
    title: "Accept cluster invite",
    sub: "Queue an Add roster change",
    intro:
      "Queues adding an operator to a cluster roster at a future epoch. Run this only when coordinating an approved roster change.",
    technical:
      "Queues submitPendingChange(Add) against node-registry 0x1005 with recovery authorization and records the transaction hash locally.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign Add pending-change",
    keywords: ["invite", "cluster", "admission", "join", "recovery"],
    effects: [
      "Builds submitPendingChange(kind=Add, targetPubkey, effectiveEpoch, intentId=0).",
      "Reads recovery authorization from the OS keychain only during signing.",
      "Records the submitted pending-change transaction hash in the local audit trail.",
    ],
    diff: [
      { key: "membership", label: "Membership", value: "+ pending Add" },
      { key: "roster", label: "Roster", value: "activates at effective epoch" },
    ],
    fields: [
      { key: "pubkey", label: "Target consensus", value: "1952-byte ML-DSA-65 pubkey" },
      { key: "epoch", label: "Effective", value: "future epoch" },
      { key: "executor", label: "Executor", value: "submitPendingChange(Add)" },
    ],
  },
  {
    kind: "cluster-swap",
    category: "cluster",
    icon: "SW",
    risk: "high",
    title: "Cluster slot change",
    sub: "Queue a Rotate roster change",
    intro:
      "Queues swapping an operator seat in a cluster roster at a future epoch. The matching key-share ceremony attestation must still follow.",
    technical:
      "Queues submitPendingChange(Rotate) against node-registry 0x1005 with recovery authorization. The queued rotate still requires the matching DKG re-share attestation before the epoch boundary.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign Rotate pending-change",
    keywords: ["swap", "cluster", "slot", "rotate", "move", "recovery"],
    effects: [
      "Builds submitPendingChange(kind=Rotate, targetPubkey, effectiveEpoch, intentId).",
      "Reads recovery authorization from the OS keychain only during signing.",
      "Records the submitted pending-change transaction hash in the local audit trail.",
    ],
    diff: [
      { key: "membership", label: "Membership", value: "+ pending Rotate" },
      { key: "dkg", label: "DKG attestation", value: "required before activation" },
    ],
    fields: [
      { key: "pubkey", label: "Target consensus", value: "1952-byte ML-DSA-65 pubkey" },
      { key: "epoch", label: "Effective", value: "future epoch" },
      { key: "intent", label: "Intent", value: "non-zero uint56" },
      { key: "executor", label: "Executor", value: "submitPendingChange(Rotate)" },
    ],
  },
  {
    kind: "freeze-admission",
    category: "emergency",
    icon: "FR",
    risk: "high",
    title: "Freeze admission",
    sub: "Submit incident freeze",
    intro:
      "Emergency brake: blocks new operator registrations and roster changes until the incident is resolved.",
    technical:
      "Submits freezeAdmission(bytes32) to node-registry 0x1005 with recovery authorization. The chain records the reason hash and blocks normal registration and roster-change paths until the incident is resolved.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign freezeAdmission",
    keywords: ["incident", "freeze", "admission", "fork", "cryptographic", "recovery"],
    effects: [
      "Builds freezeAdmission(reasonHash) calldata against node-registry 0x1005.",
      "Reads recovery authorization from the OS keychain only during signing.",
      "Records the submitted incident-response transaction hash in the local audit trail.",
    ],
    diff: [
      { key: "admission", label: "Admission", value: "frozen" },
      { key: "reason", label: "Reason", value: "32-byte incident hash" },
    ],
    fields: [
      { key: "reason", label: "Reason hash", value: "32-byte incident/runbook hash" },
      { key: "executor", label: "Executor", value: "freezeAdmission(bytes32)" },
      { key: "authorization", label: "Authorization", value: "recovery keychain entry" },
    ],
  },
  {
    kind: "emergency-key-rotation",
    category: "emergency",
    icon: "ER",
    risk: "high",
    title: "Emergency key rotation",
    sub: "Submit emergency Rotate executor",
    intro:
      "Forces a cluster key rotation through even while admission is frozen. The key-share ceremony attestation still follows.",
    technical:
      "Submits emergencyKeyRotation(bytes,uint64,uint64) to node-registry 0x1005 with recovery authorization. The executor queues a Rotate pending change even when normal admission is frozen.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign emergencyKeyRotation",
    keywords: ["incident", "emergency", "key", "rotation", "dkg", "recovery"],
    effects: [
      "Builds emergencyKeyRotation(targetPubkey, effectiveEpoch, intentId) calldata.",
      "Reads recovery authorization from the OS keychain only during signing.",
      "Records the submitted emergency key-rotation transaction hash in the local audit trail.",
    ],
    diff: [
      { key: "membership", label: "Membership", value: "+ emergency Rotate" },
      { key: "dkg", label: "DKG attestation", value: "required before activation" },
    ],
    fields: [
      { key: "pubkey", label: "Target consensus", value: "1952-byte ML-DSA-65 pubkey" },
      { key: "epoch", label: "Effective", value: "future epoch" },
      { key: "intent", label: "Intent", value: "non-zero uint56" },
      { key: "executor", label: "Executor", value: "emergencyKeyRotation(bytes,uint64,uint64)" },
    ],
  },
];
