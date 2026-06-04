// Types shared by the Operations drawer state machine. Every sensitive
// action must be expressed as an OpRequest and routed through the drawer.

export const OP_KINDS = [
  "operator-start",
  "operator-stop",
  "operator-restart",
  "operator-restore",
  "operator-register",
  "chat-bootstrap-peers",
  "rotate-keys",
  "redelegate",
  "export-backup",
  "cluster-swap",
  "cluster-accept-invite",
  "freeze-admission",
  "emergency-key-rotation",
  "ota-apply",
  "ota-rollback",
] as const;

export type OpKind = (typeof OP_KINDS)[number];

// Inputs the register form collects from the operator. Lives on
// OpRequest as `registerInput` so the OpsContext branch can pass them
// to the SDK helper without re-parsing the `fields[]` display rows.
export type RegisterInput = {
  endpoint: string;
  capabilities: number;
  blsPubkeyHex: string;
  blsPopHex: string;
  bondLythoshi: string;
  peerIdHex?: string;
  sppkHashHex?: string;
};

// Inputs the redelegate form collects from the operator. These map
// directly to the delegation precompile's
// `redelegate(uint32,uint32,uint16)` calldata.
export type RedelegateInput = {
  fromCluster: number;
  toCluster: number;
  weightBps: number;
};

// Inputs the restore form collects from the operator/foundation runbook. The
// peer id is the node-registry key passed to recoverOperatorNode(bytes32).
export type RestoreInput = {
  peerIdHex: string;
};

// Inputs for node-registry `setChatBootstrapPeers(bytes32,bytes)`.
// The peer id selects the operator-owned registration row, while `peers`
// is a comma/newline/whitespace separated libp2p multiaddr list.
export type ChatBootstrapPeersInput = {
  peerIdHex: string;
  peers: string;
};

// Inputs for node-registry `submitPendingChange(uint8,bytes,uint64,uint64)`.
// Desktop currently surfaces Add for cluster invites and Rotate for cluster
// swaps; Remove is kept in the type because the ABI discriminant is stable.
export type PendingChangeInput = {
  kind: "add" | "remove" | "rotate";
  targetPubkeyHex: string;
  effectiveEpoch: string;
  intentId: string;
};

// Inputs for the operator-callable `attestDkgReshare(uint64,bytes,bytes)`.
export type DkgReshareAttestationInput = {
  intentId: string;
  blsPublicKeysHex: string;
  thresholdSigHex: string;
};

export type FreezeAdmissionInput = {
  reasonHashHex: string;
};

export type EmergencyKeyRotationInput = {
  targetPubkeyHex: string;
  effectiveEpoch: string;
  intentId: string;
};

export type OtaRebootMode = "default" | "powercycle";

// Inputs for the Talos Upgrade RPC. `preserve=true` is enforced by the
// Rust bridge so `/var/lib/protocore` survives the image replacement.
export type OtaApplyInput = {
  image: string;
  stage: boolean;
  rebootMode: OtaRebootMode;
};

export type OpStage = "preview" | "auth" | "executing" | "done" | "error";

export type OpField = { key: string; label: string; value: string };

export type OpRequest = {
  kind: OpKind;
  title: string;
  sub: string;
  intro: string;
  fields: OpField[];
  icon?: string;
  risk?: "low" | "medium" | "high";
  effects?: string[];
  diff?: OpField[];
  needsPasskey?: boolean;
  destructive?: boolean;
  confirmLabel?: string;
  /** Present only when `kind === "operator-register"`. Carries the
   *  parsed form inputs the SDK helper needs to build + submit the
   *  register tx. Lives on OpRequest so the OpsContext branch stays
   *  shape-pure and the form component owns validation. */
  registerInput?: RegisterInput;
  /** Present only when `kind === "redelegate"`. Carries the parsed
   *  delegation precompile arguments for the signed tx path. */
  redelegateInput?: RedelegateInput;
  /** Present only when `kind === "operator-restore"`. Carries the
   *  node-registry peer id recovered by the foundation-gated executor. */
  restoreInput?: RestoreInput;
  /** Present only when `kind === "chat-bootstrap-peers"`. Carries the
   *  operator-owned chat bootstrap metadata declaration. */
  chatBootstrapPeersInput?: ChatBootstrapPeersInput;
  /** Present only when `kind` maps to a foundation pending-change op. */
  pendingChangeInput?: PendingChangeInput;
  /** Present only when `kind === "rotate-keys"`. Carries the DKG re-share
   *  attestation payload produced by the external ceremony. */
  dkgReshareInput?: DkgReshareAttestationInput;
  /** Present only when `kind === "freeze-admission"`. */
  freezeAdmissionInput?: FreezeAdmissionInput;
  /** Present only when `kind === "emergency-key-rotation"`. */
  emergencyKeyRotationInput?: EmergencyKeyRotationInput;
  /** Present only when `kind === "ota-apply"`. Carries the Talos image
   *  reference and non-secret upgrade switches. */
  otaApplyInput?: OtaApplyInput;
};

export type OpResult = {
  ok: boolean;
  message: string;
  txHash?: string;
  receiptId?: string;
};
