// Types shared by the Operations approval flow. Every sensitive action must be
// expressed as an OpRequest and routed through the drawer.

export const OP_KINDS = [
  "operator-start",
  "operator-stop",
  "operator-restart",
  "operator-restore",
  "operator-register",
  "operator-display",
  "chat-bootstrap-peers",
  "cluster-name-register",
  "redelegate",
  "export-backup",
  "cluster-swap",
  "cluster-accept-invite",
  "cluster-form",
  "cluster-update-charter",
  "cluster-request-join",
  "cluster-vote-admit",
  "seat-apply",
  "seat-vote-admit",
  "cluster-resign",
  "freeze-admission",
  "emergency-key-rotation",
  "ota-apply",
  "ota-rollback",
  "operator-reprovision",
  "operator-recover-keys",
  "operator-bootstrap",
  "clean-protocore-logs",
  "set-log-retention",
] as const;

export type OpKind = (typeof OP_KINDS)[number];

// Inputs the register form collects from the operator. Lives on
// OpRequest as `registerInput` so the OpsContext branch can pass them
// to the SDK helper without re-parsing the `fields[]` display rows.
export type RegisterInput = {
  endpoint: string;
  capabilities: number;
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

// Inputs for node-registry `setOperatorDisplay(bytes32,string,string)`.
// The peer id selects the operator-owned registration row; empty text clears
// the corresponding public display field.
export type OperatorDisplayInput = {
  peerIdHex: string;
  moniker: string;
  alias: string;
};

// Inputs for cluster-name-registry `register(string,uint64)`.
// The tx must be signed by the cluster's primary anchor key.
export type ClusterNameInput = {
  clusterId: string;
  name: string;
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

// Inputs for CJ-1 self-service cluster admission. `requestClusterJoin`
// is signed by the joining operator and sends the bond as tx value once
// the runtime precompile is live.
export type ClusterJoinRequestInput = {
  clusterId: string;
  operatorPubkeyHex: string;
  bondLythoshi: string;
};

// Inputs for CJ-1 cluster-member admission votes. The chain tallies
// votes by the current cluster roster and admits once policy threshold is met.
export type ClusterVoteAdmitInput = {
  clusterId: string;
  operatorIdHex: string;
  voterPubkeyHex: string;
};

// Inputs for the L6 open-seat `applyForSeat(uint32,uint32,bytes)` call. The
// applicant signs with the operator key and escrows the FULL self-bond as
// native value. `selfBondLythoshi` is `max(min_self_bond_floor, seat.minBond)`
// — defaulting to the 5,000 LYTH floor — escrowed at apply and refundable if
// the applicant withdraws before admission; admission retains the already-
// escrowed bond. There is no separate application escrow.
export type ApplyForSeatInput = {
  clusterId: string;
  seatId: string;
  operatorPubkeyHex: string;
  selfBondLythoshi: string;
};

// Inputs for the L6 open-seat `voteSeatAdmit(uint32,bytes32,bytes)` call cast
// by a current cluster member. The application key is the candidate's op-hash
// returned by `applyForSeat`; the chain admits once the 7-of-10 threshold is
// reached.
export type VoteSeatAdmitInput = {
  clusterId: string;
  appKeyHex: string;
  voterPubkeyHex: string;
};

// Inputs for the self-service `formCluster(bytes,bytes,bytes)` call.
// Signatures are ten ML-DSA-65 consent signatures over the canonical
// roster digest, in roster order: seven active first, then three standby.
// When `charterHex` (the 30-byte V2 economics charter) is present the
// executor encodes `formCluster(bytes,bytes,bytes,bytes)` and the ten
// signatures must verify over the charter-committing V2 digest; absent,
// the V1 flow stays byte-identical.
export type ClusterFormInput = {
  activePubkeysHex: string;
  standbyPubkeysHex: string;
  signaturesHex: string;
  charterHex?: string;
};

// Inputs for the live-cluster `updateCharter(uint32,bytes,bytes,bytes)`
// amendment (Component H). `charterHex` is the proposed 30-byte charter;
// `signerPubkeysHex` / `signaturesHex` are the ≥7 active-member ML-DSA-65
// consent pubkeys + signatures over the updateCharter consent digest (1:1,
// signer order). The executor encodes the calldata and submits from the
// caller's operator key; the chain enforces the 7-of-10 active-member
// threshold and applies the new terms only after the cooldown.
export type ClusterUpdateCharterInput = {
  clusterId: string;
  charterHex: string;
  signerPubkeysHex: string[];
  signaturesHex: string[];
};

// Inputs for the Q120 voluntary cluster resignation
// (`Tx::ClusterResignation`). The resigning operator signs the native
// frame with the ML-DSA-65 consensus key; the runtime
// resolves the cluster from on-chain membership, so `clusterId` is a
// display-only context field and is NOT part of the signed payload.
// `nonce` is the operator-local resignation nonce (strictly greater than
// the last accepted one). `expedite` requests a foundation expedite; the
// executor still enforces the actual authority.
export type ClusterResignationInput = {
  clusterId: string;
  nonce: string;
  expedite: boolean;
};

export type FreezeAdmissionInput = {
  reasonHashHex: string;
};

export type EmergencyKeyRotationInput = {
  targetPubkeyHex: string;
  effectiveEpoch: string;
  intentId: string;
};

// Inputs for the seat-preserving "Re-provision with existing keys" recovery
// flow (`operator-recover-keys`). This is the DEFAULT recovery path for a
// forked/quarantined operator: the consensus ML-DSA-65 key lives sealed at
// /var/lib/protocore/operator/consensus.key.enc on the EPHEMERAL partition, so
// a naive wipe DISCARDS it and the node returns with a NEW random key (an
// orphaned bonded seat). The recovery config stages the keychain mnemonic via
// `machine.files` + the PROTOCORE_OPERATOR_MNEMONIC_FILE env so first-boot
// keygen RE-DERIVES the SAME key after the wipe, keeping the bonded seat.
//
// `host` is the Talos node address the recovery config is applied to; `disk`
// is the install disk (resolved from the node's system disk); `operatorId` is
// the node-registry peer id shown as recovery context. The mnemonic is NOT
// carried on the input — the flow reads it from the OS keychain at execution
// time and validates it before staging.
export type RecoverKeysInput = {
  host: string;
  disk: string;
  operatorId?: string;
};

export type OtaRebootMode = "default" | "powercycle";

// Inputs for the Talos Upgrade RPC. `preserve=true` is enforced by the
// Rust bridge so `/var/lib/protocore` survives the image replacement.
export type OtaApplyInput = {
  image: string;
  stage: boolean;
  rebootMode: OtaRebootMode;
  /** The applied release's `monoCoreCommit`, carried so the OTA flow can
   *  CONFIRM the node came back on the NEW build (compare against the node's
   *  running `runtime.gitCommit`) rather than only that it is reachable.
   *  Optional: a manually-typed image has no release identity to confirm against. */
  targetMonoCoreCommit?: string;
  /** The applied release's friendly tag (e.g. `v0.1.60-testnet`), shown during
   *  the reconnect/confirm window so the node-version chip reads the tag the
   *  operator just applied instead of a bare `dev <commit>` / `0.1.0+<gitsha>`. */
  targetTag?: string;
};

// Inputs for the protocore log retention ops (`set-log-retention` and
// `clean-protocore-logs`). `maxMegabytes` caps the log size and `maxFiles` caps
// the rotated-file count; the Rust bridge validates both ranges before patching
// the protocore extension config.
export type LogRetentionInput = {
  maxMegabytes: number;
  maxFiles: number;
};

// Default retention the drawer pre-fills: 512 MB across 5 rotated files. A sane
// starting bound for a node whose append-only log otherwise grows to many GB.
export const DEFAULT_LOG_RETENTION: LogRetentionInput = {
  maxMegabytes: 512,
  maxFiles: 5,
};

// Bounds the Rust bridge enforces (kept in sync with build_log_retention_env).
export const LOG_RETENTION_LIMITS = {
  minMegabytes: 1,
  maxMegabytes: 1_048_576,
  minFiles: 1,
  maxFiles: 64,
} as const;

export function isLogRetentionInputComplete(
  input: LogRetentionInput | undefined,
): boolean {
  if (!input) return false;
  if (
    !Number.isInteger(input.maxMegabytes) ||
    input.maxMegabytes < LOG_RETENTION_LIMITS.minMegabytes ||
    input.maxMegabytes > LOG_RETENTION_LIMITS.maxMegabytes
  ) {
    return false;
  }
  if (
    !Number.isInteger(input.maxFiles) ||
    input.maxFiles < LOG_RETENTION_LIMITS.minFiles ||
    input.maxFiles > LOG_RETENTION_LIMITS.maxFiles
  ) {
    return false;
  }
  return true;
}

export type OpStage = "preview" | "auth" | "executing" | "done" | "error";

export type OpField = { key: string; label: string; value: string };

export type OpRequest = {
  kind: OpKind;
  title: string;
  sub: string;
  intro: string;
  /** Optional spec-level prose (selectors, byte sizes, precompile
   *  addresses) demoted out of `intro` into an expandable
   *  "technical details" block in the drawer. */
  technical?: string;
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
   *  node-registry peer id recovered by the recovery executor. */
  restoreInput?: RestoreInput;
  /** Present only when `kind === "chat-bootstrap-peers"`. Carries the
   *  operator-owned chat bootstrap metadata declaration. */
  chatBootstrapPeersInput?: ChatBootstrapPeersInput;
  /** Present only when `kind === "operator-display"`. Carries public
   *  operator display metadata. */
  operatorDisplayInput?: OperatorDisplayInput;
  /** Present only when `kind === "cluster-name-register"`. */
  clusterNameInput?: ClusterNameInput;
  /** Present only when `kind` maps to a foundation pending-change op. */
  pendingChangeInput?: PendingChangeInput;
  /** Present only when `kind === "cluster-request-join"`. */
  clusterJoinRequestInput?: ClusterJoinRequestInput;
  /** Present only when `kind === "cluster-vote-admit"`. */
  clusterVoteAdmitInput?: ClusterVoteAdmitInput;
  /** Present only when `kind === "seat-apply"`. Carries the open-seat
   *  application target + the full self-bond escrowed at apply. */
  seatApplyInput?: ApplyForSeatInput;
  /** Present only when `kind === "seat-vote-admit"`. Carries the candidate
   *  application key the cluster member is voting to admit. */
  seatVoteAdmitInput?: VoteSeatAdmitInput;
  /** Present only when `kind === "cluster-resign"`. Carries the
   *  operator-local resignation nonce and the foundation-expedite flag. */
  clusterResignationInput?: ClusterResignationInput;
  /** Present only when `kind === "cluster-form"`. */
  clusterFormInput?: ClusterFormInput;
  /** Present only when `kind === "cluster-update-charter"`. Carries the
   *  proposed 30-byte charter + the collected active-member consents. */
  clusterUpdateCharterInput?: ClusterUpdateCharterInput;
  /** Present only when `kind === "freeze-admission"`. */
  freezeAdmissionInput?: FreezeAdmissionInput;
  /** Present only when `kind === "emergency-key-rotation"`. */
  emergencyKeyRotationInput?: EmergencyKeyRotationInput;
  /** Present only when `kind === "ota-apply"`. Carries the Talos image
   *  reference and non-secret upgrade switches. */
  otaApplyInput?: OtaApplyInput;
  /** Present only when `kind` is `clean-protocore-logs` or
   *  `set-log-retention`. Carries the validated retention bounds. */
  logRetentionInput?: LogRetentionInput;
  /** Present only when `kind === "operator-recover-keys"`. Carries the Talos
   *  host, install disk, and node-registry peer id for the seat-preserving
   *  re-provision-with-existing-keys flow. The keychain mnemonic is read at
   *  execution time and is NOT stored on the request. */
  recoverKeysInput?: RecoverKeysInput;
};

export type OpResult = {
  ok: boolean;
  message: string;
  txHash?: string;
  receiptId?: string;
};
