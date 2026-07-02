// Maps the few service verbs that still have a host-command fallback. Chain
// verbs, recovery actions, offline backup export, and Talos OS upgrade/rollback
// are handled before this mapper by dedicated helpers.
//
// The intent is that `commandFor(op)` returns either a shell line we
// trust to run on the operator host, or `null` to indicate "block this
// verb until a signed path exists". The Operations drawer dispatches
// based on that nullability.

import type { OpKind, OpRequest } from "./types";

export type TalosAction = {
  service: string;
  action: "start" | "stop" | "restart";
};

/**
 * Returns the operator-host shell command for `op`, or null when the
 * verb is handled by a dedicated signed/Talos path or is unsupported.
 */
export function commandFor(op: OpRequest): string | null {
  const kind: OpKind = op.kind;
  switch (kind) {
    case "operator-restart":
      // Cycle the systemd unit. `monod` is the canonical service name.
      return "sudo systemctl restart monod";
    case "operator-stop":
      return "sudo systemctl stop monod";
    case "operator-start":
      return "sudo systemctl start monod";
    // Verbs that use dedicated non-shell paths or still need a real
    // signing path (keychain / TPM / ledger). We deliberately avoid
    // ssh'ing a half-baked command.
    //
    // Cluster invite/swap are foundation pending-change txs handled by
    // `OpsContext.runPendingChangeFlow`; returning null here prevents a
    // shell fallback from bypassing the signed node-registry path.
    case "operator-restore":
    case "operator-register":
    case "operator-display":
    case "chat-bootstrap-peers":
    case "cluster-name-register":
    case "redelegate":
    case "export-backup":
    case "cluster-swap":
    case "cluster-accept-invite":
    case "cluster-form":
    case "cluster-update-charter":
    case "cluster-request-join":
    case "cluster-vote-admit":
    // Open-seat apply/vote are signed node-registry txs handled by
    // `OpsContext.runApplyForSeatFlow` / `runVoteSeatAdmitFlow`; never
    // shell-fallback a signed admission action.
    case "seat-apply":
    case "seat-vote-admit":
    // Open-seat advertise/withdraw/close are signed node-registry txs handled
    // by their dedicated OpsContext flows; never shell-fallback a signed
    // marketplace action.
    case "seat-advertise":
    case "seat-withdraw-application":
    case "seat-close":
    case "cluster-resign":
    case "freeze-admission":
    case "emergency-key-rotation":
    case "ota-apply":
    case "ota-rollback":
    // Wipe & re-provision is a dedicated Talos Reset path
    // (`OpsContext.runReprovisionFlow`); never shell-fallback a destructive
    // partition wipe.
    case "operator-reprovision":
    // Re-provision with existing keys is a dedicated Talos recovery flow
    // (`OpsContext.runRecoverKeysFlow`); never shell-fallback a wipe that
    // re-stages the operator mnemonic.
    case "operator-recover-keys":
    // Bootstrap is a dedicated Talos etcd-bootstrap path
    // (`OpsContext.runBootstrapFlow`).
    case "operator-bootstrap":
    // Log retention / cleanup are dedicated Talos ApplyConfiguration +
    // ServiceRestart paths (`OpsContext.runSetLogRetentionFlow` /
    // `runCleanLogsFlow`); never shell-fallback them.
    case "set-log-retention":
    case "clean-protocore-logs":
      return null;
    default: {
      // Exhaustiveness guard. If a new OpKind is added we want this to
      // surface as a TypeScript error rather than silently falling
      // through to the unsupported-path branch.
      const _exhaustive: never = kind;
      void _exhaustive;
      return null;
    }
  }
}

/** Returns the Monarch OS Talos service operation for an op, when one exists. */
export function talosActionFor(op: OpRequest): TalosAction | null {
  switch (op.kind) {
    case "operator-restart":
      return { service: "ext-protocore", action: "restart" };
    case "operator-stop":
      return { service: "ext-protocore", action: "stop" };
    case "operator-start":
      return { service: "ext-protocore", action: "start" };
    default:
      return null;
  }
}
