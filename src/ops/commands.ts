// Maps an Operations verb to the shell command we'd actually run on
// a plain Linux development host. Monarch OS system service operations
// use Talos API via `talosActionFor`; SSH remains only a dev fallback.
// Other verbs either have dedicated live helpers or need higher-trust /
// foundation-coordinated paths that do not exist yet. They return null
// here so the drawer never dispatches a shell command no binary implements.
// Chain verbs such as register, redelegate, chat metadata, foundation
// recovery, and foundation pending-change submission, offline backup export,
// plus Talos OS upgrade/rollback, are handled before this mapper by dedicated
// live helpers.
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
    case "chat-bootstrap-peers":
    case "rotate-keys":
    case "redelegate":
    case "export-backup":
    case "cluster-swap":
    case "cluster-accept-invite":
    case "freeze-admission":
    case "emergency-key-rotation":
    case "ota-apply":
    case "ota-rollback":
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
