// Canonical Operations catalog. Single source of truth for the verbs
// that show on the Operations route AND in the ⌘K palette. Adding a new
// operator verb means appending one entry here — both surfaces pick it
// up automatically.
//
// The 5 canonical verbs (restore / rotate-keys / restart / redelegate /
// export-backup) line up with `OperationsView` in design_handoff_monarch.
// Additional flow verbs round out what the palette surfaces today.

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
      "Posts a signed register tx to precompile 0x1005 from the operator's PQM-1 mnemonic. Locks the bond (sourced from the same wallet's native balance), publishes the endpoint + capabilities, and binds the BLS pubkey/PoP into the node-registry. Operator self-signed; no foundation multisig required.",
    destructive: false,
    needsPasskey: true,
    confirmLabel: "Sign register tx",
    keywords: ["register", "onboard", "node", "registry", "bond", "operator"],
    effects: [
      "Bond locked from the operator's wallet for the registration epoch.",
      "Endpoint + capabilities published to the on-chain registry.",
      "BLS pubkey + PoP committed; the cluster can attest to this operator from the next round.",
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
    sub: "Submit foundation recovery tx",
    intro:
      "Restore maps to node-registry recoverOperatorNode(bytes32), the disaster-recovery alias for unjail(bytes32). mono-core gates that executor to the foundation multisig; Desktop submits only when a foundation operations signer is present in the OS keychain.",
    destructive: false,
    needsPasskey: true,
    confirmLabel: "Sign recovery tx",
    keywords: ["jail", "resume", "rejoin", "missed", "rounds"],
    effects: [
      "Builds recoverOperatorNode(peerId) calldata against node-registry 0x1005.",
      "Reads the foundation operations mnemonic from the OS keychain only during signing.",
      "Records the submitted recovery transaction hash in the local audit trail.",
    ],
    diff: [
      { key: "status", label: "Status", value: "+ foundation recovery tx" },
      { key: "rotation", label: "Rotation", value: "unchanged" },
    ],
    fields: [
      { key: "peer-id", label: "Peer id", value: "32-byte node-registry peer id" },
      { key: "executor", label: "Executor", value: "recoverOperatorNode(bytes32)" },
      { key: "signer", label: "Signer", value: "foundation operations keychain entry" },
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
    kind: "rotate-keys",
    category: "keys",
    icon: "KY",
    risk: "high",
    title: "Rotate signing share",
    sub: "Submit DKG re-share attestation",
    intro:
      "After the key-share ceremony produces the participant BLS pubkeys and aggregate threshold signature, Desktop submits the operator-signed attestDkgReshare(uint64,bytes,bytes) transaction that marks the Rotate intent as DKG-attested on node-registry 0x1005.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign DKG attestation",
    keywords: ["dkg", "rotate", "rotation", "share", "key", "rekey"],
    effects: [
      "Builds attestDkgReshare(intentId, blsPublicKeys, thresholdSig) calldata against node-registry 0x1005.",
      "Signs the zero-value native tx from the operator keychain mnemonic.",
      "Records the submitted DKG attestation transaction hash in the local audit trail.",
    ],
    diff: [
      { key: "share", label: "Signing share", value: "ceremony output required" },
      { key: "attestation", label: "Attestation", value: "+ on-chain DKG flag" },
    ],
    fields: [
      { key: "intent", label: "Intent", value: "Rotate intent id" },
      { key: "pubkeys", label: "BLS pubkeys", value: "5..7 unique 48-byte keys" },
      { key: "signature", label: "Threshold sig", value: "96-byte aggregate BLS-G2" },
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
    kind: "cluster-accept-invite",
    category: "cluster",
    icon: "IN",
    risk: "high",
    title: "Accept cluster invite",
    sub: "Submit foundation Add pending-change",
    intro:
      "Cluster invite acceptance queues a foundation-signed submitPendingChange(Add) transaction against node-registry 0x1005. Desktop collects the target BLS pubkey and future effective epoch, signs with the foundation operations signer, and records the tx hash locally.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign Add pending-change",
    keywords: ["invite", "cluster", "admission", "join", "foundation"],
    effects: [
      "Builds submitPendingChange(kind=Add, targetPubkey, effectiveEpoch, intentId=0).",
      "Reads the foundation operations signer from the OS keychain only during signing.",
      "Records the submitted pending-change transaction hash in the local audit trail.",
    ],
    diff: [
      { key: "membership", label: "Membership", value: "+ pending Add" },
      { key: "roster", label: "Roster", value: "activates at effective epoch" },
    ],
    fields: [
      { key: "pubkey", label: "Target BLS", value: "48-byte compressed pubkey" },
      { key: "epoch", label: "Effective", value: "future epoch" },
      { key: "executor", label: "Executor", value: "submitPendingChange(Add)" },
    ],
  },
  {
    kind: "cluster-swap",
    category: "cluster",
    icon: "SW",
    risk: "high",
    title: "Cluster slot (foundation-coordinated)",
    sub: "Submit foundation Rotate pending-change",
    intro:
      "Cluster slot swaps queue a foundation-signed submitPendingChange(Rotate) transaction against node-registry 0x1005. The queued rotate still requires the matching DKG re-share attestation before the epoch boundary, and Desktop submits the on-chain roster intent with an auditable transaction receipt.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign Rotate pending-change",
    keywords: ["swap", "cluster", "slot", "rotate", "move", "foundation"],
    effects: [
      "Builds submitPendingChange(kind=Rotate, targetPubkey, effectiveEpoch, intentId).",
      "Reads the foundation operations signer from the OS keychain only during signing.",
      "Records the submitted pending-change transaction hash in the local audit trail.",
    ],
    diff: [
      { key: "membership", label: "Membership", value: "+ pending Rotate" },
      { key: "dkg", label: "DKG attestation", value: "required before activation" },
    ],
    fields: [
      { key: "pubkey", label: "Target BLS", value: "48-byte compressed pubkey" },
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
    sub: "Submit foundation incident freeze",
    intro:
      "Submits freezeAdmission(bytes32) to node-registry 0x1005 with the foundation operations signer. The chain records the reason hash and blocks normal register and submitPendingChange admission paths until a replacement/recovery runbook resolves the incident.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign freezeAdmission",
    keywords: ["incident", "freeze", "admission", "fork", "cryptographic", "foundation"],
    effects: [
      "Builds freezeAdmission(reasonHash) calldata against node-registry 0x1005.",
      "Reads the foundation operations signer from the OS keychain only during signing.",
      "Records the submitted incident-response transaction hash in the local audit trail.",
    ],
    diff: [
      { key: "admission", label: "Admission", value: "frozen" },
      { key: "reason", label: "Reason", value: "32-byte incident hash" },
    ],
    fields: [
      { key: "reason", label: "Reason hash", value: "32-byte incident/runbook hash" },
      { key: "executor", label: "Executor", value: "freezeAdmission(bytes32)" },
      { key: "signer", label: "Signer", value: "foundation operations keychain entry" },
    ],
  },
  {
    kind: "emergency-key-rotation",
    category: "emergency",
    icon: "ER",
    risk: "high",
    title: "Emergency key rotation",
    sub: "Submit foundation Rotate executor",
    intro:
      "Submits emergencyKeyRotation(bytes,uint64,uint64) to node-registry 0x1005 with the foundation operations signer. The executor queues a Rotate pending change even when normal admission is frozen; the matching DKG re-share attestation still follows through the rotate-keys operation.",
    destructive: true,
    needsPasskey: true,
    confirmLabel: "Sign emergencyKeyRotation",
    keywords: ["incident", "emergency", "key", "rotation", "dkg", "foundation"],
    effects: [
      "Builds emergencyKeyRotation(targetPubkey, effectiveEpoch, intentId) calldata.",
      "Reads the foundation operations signer from the OS keychain only during signing.",
      "Records the submitted emergency key-rotation transaction hash in the local audit trail.",
    ],
    diff: [
      { key: "membership", label: "Membership", value: "+ emergency Rotate" },
      { key: "dkg", label: "DKG attestation", value: "required before activation" },
    ],
    fields: [
      { key: "pubkey", label: "Target BLS", value: "48-byte compressed pubkey" },
      { key: "epoch", label: "Effective", value: "future epoch" },
      { key: "intent", label: "Intent", value: "non-zero uint56" },
      { key: "executor", label: "Executor", value: "emergencyKeyRotation(bytes,uint64,uint64)" },
    ],
  },
];
