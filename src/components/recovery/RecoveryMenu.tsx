// RecoveryMenu — shown on the Install view when the connected node is
// QUARANTINED (item 5's `NodeStatus.quarantineReason`, e.g. a
// CheckpointStateRootMismatch fork). It offers three escalating recovery
// paths, ordered safest-first:
//
//   1. Resume — a graceful service restart (reuses the `operator-restart` op).
//      Try this first; a transient wedge often clears on a restart.
//   2. Re-provision with existing keys — the seat-preserving DEFAULT. Re-derives
//      the SAME consensus key from this computer's keychain mnemonic after the
//      wipe, so the bonded cluster seat is kept (reuses `operator-recover-keys`).
//      Only enabled when the operator mnemonic is present in the keychain.
//   3. Re-enroll as a new node — the last resort. Wipes the consensus key and
//      comes back with a NEW identity, ORPHANING the bonded seat (reuses
//      `operator-reprovision`). Gated behind a typed "ORPHAN BOND" confirm.
//
// Every action routes through the Operations drawer (`useOps().requestOp`) for
// the same review → authorize → execute → receipt lifecycle as any other op.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useOps } from "../../ops";
import { useKeychainPresence, useSelfOperator } from "../../hooks/useSelfOperator";
import { talosHostTelemetry, talosStatus } from "../../sdk";

const ORPHAN_CONFIRM_PHRASE = "ORPHAN BOND";

type NodeTarget = { host: string | null; disk: string | null };

/** Resolve the Talos host + install disk for the recovery config. The host is
 *  the connected node's address; the disk is its system disk. Best-effort —
 *  the recover-keys op fails closed with a clear message if either is missing. */
async function resolveNodeTarget(): Promise<NodeTarget> {
  const status = await talosStatus().catch(() => null);
  const host = status?.nodeAddress || status?.endpoint || null;
  let disk: string | null = null;
  try {
    const telemetry = await talosHostTelemetry();
    const system = telemetry.disks.find((d) => d.systemDisk && !d.readonly);
    const fallback = telemetry.disks.find((d) => !d.readonly);
    disk = (system ?? fallback)?.deviceName ?? null;
  } catch {
    disk = null;
  }
  return { host, disk };
}

export function RecoveryMenu({ quarantineReason }: { quarantineReason: string | null }) {
  const ops = useOps();
  const presence = useKeychainPresence();
  const self = useSelfOperator();
  const [target, setTarget] = useState<NodeTarget>({ host: null, disk: null });
  const [orphanArmed, setOrphanArmed] = useState(false);
  const [orphanConfirm, setOrphanConfirm] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const resolved = await resolveNodeTarget();
      if (!cancelled) setTarget(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onResume = useCallback(() => {
    ops.requestOp({
      kind: "operator-restart",
      title: "Resume node (graceful restart)",
      sub: "Cycle the operator-node service",
      intro:
        "Cycles the operator-node service. Try this first — a transient wedge or a brief quarantine often clears on a clean restart, without touching your keys or chain data.",
      icon: "RS",
      risk: "low",
      needsPasskey: true,
      fields: [
        { key: "node", label: "Node", value: target.host ?? "configured Talos node" },
        { key: "downtime", label: "Downtime", value: "operator-controlled" },
      ],
    });
  }, [ops, target.host]);

  const onRecoverKeys = useCallback(() => {
    ops.requestOp({
      kind: "operator-recover-keys",
      title: "Re-provision with existing keys",
      sub: "Seat-preserving recovery · re-derives your key",
      intro:
        "Recovers this node WITHOUT losing your bonded cluster seat. Monarch stages your operator mnemonic from this computer's keychain onto the node, wipes the stale forked data, and lets the node re-derive the SAME consensus key on first boot. After re-sync, your seal key is re-published so sealed-mempool duty resumes.",
      icon: "RK",
      risk: "high",
      needsPasskey: true,
      destructive: true,
      confirmLabel: "Recover & keep my seat",
      fields: [
        { key: "node", label: "Node", value: target.host ?? "configured Talos node" },
        { key: "disk", label: "Install disk", value: target.disk ?? "node system disk" },
        { key: "operator", label: "Operator", value: self.operatorId ?? "your registered operator" },
        { key: "mnemonic", label: "Mnemonic source", value: "this computer's OS keychain" },
      ],
      recoverKeysInput: {
        host: target.host ?? "",
        disk: target.disk ?? "",
        operatorId: self.operatorId ?? undefined,
      },
    });
  }, [ops, target.host, target.disk, self.operatorId]);

  const onReEnroll = useCallback(() => {
    if (orphanConfirm.trim().toUpperCase() !== ORPHAN_CONFIRM_PHRASE) return;
    ops.requestOp({
      kind: "operator-reprovision",
      title: "Re-enroll as a new node (wipe keys)",
      sub: "Talos reset · EPHEMERAL · DISCARDS consensus key",
      intro:
        "Erases this node's chain data AND its consensus key, then reboots with a brand-new identity. If this node held a bonded cluster seat, that seat is ORPHANED — it stays bonded to the old key, and you must register and bond again. Use this only when you have lost your operator mnemonic and cannot recover the seat.",
      icon: "WP",
      risk: "high",
      needsPasskey: true,
      destructive: true,
      confirmLabel: "Wipe keys & re-enroll node",
      fields: [
        { key: "node", label: "Node", value: target.host ?? "configured Talos node" },
        { key: "seat", label: "Bonded seat", value: "ORPHANED — re-registration required" },
        { key: "transport", label: "Transport", value: "Talos Reset RPC (EPHEMERAL)" },
      ],
    });
    setOrphanArmed(false);
    setOrphanConfirm("");
  }, [ops, orphanConfirm, target.host]);

  const orphanReady = orphanConfirm.trim().toUpperCase() === ORPHAN_CONFIRM_PHRASE;

  return (
    <div
      className="card card--padded"
      style={{
        maxWidth: 820,
        margin: "0 auto",
        borderColor: "var(--gold)",
        background: "rgba(242,180,65,0.04)",
      }}
    >
      <div className="card__head">
        <div>
          <h3 style={{ color: "var(--gold)" }}>Node quarantined — recover it</h3>
          <div className="sub">
            this node has been quarantined and is no longer signing · pick a recovery path below
          </div>
        </div>
        <span className="halo halo--err">
          <span className="dot" /> quarantined
        </span>
      </div>

      {quarantineReason ? (
        <div className="install-note mono" style={{ marginBottom: 4 }}>
          {quarantineReason}
        </div>
      ) : null}

      {/* Option 1 — Resume (safest) */}
      <RecoveryOption
        badge="1"
        tone="ok"
        title="Resume the node"
        body="Cycle the operator-node service. Try this first — a transient wedge often clears on a clean restart. Your keys and chain data are untouched."
      >
        <button type="button" className="btn btn--ghost btn--sm" onClick={onResume}>
          Graceful restart
        </button>
      </RecoveryOption>

      {/* Option 2 — Re-provision with existing keys (DEFAULT, seat-preserving) */}
      <RecoveryOption
        badge="2"
        tone="gold"
        recommended
        title="Re-provision with existing keys"
        body={
          presence.hasOperatorKey
            ? "Wipes the forked data and re-derives the SAME consensus key from your keychain mnemonic on first boot — so your bonded seat, bond, and identity are preserved. Recommended for a quarantined node."
            : "Requires your operator mnemonic in this computer's keychain so the node can re-derive its consensus key. Import it in Settings → Operator key first, then this becomes the recommended recovery path."
        }
      >
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={!presence.hasOperatorKey || presence.checking}
          onClick={onRecoverKeys}
          title={
            presence.hasOperatorKey
              ? undefined
              : "No operator mnemonic found in this computer's keychain."
          }
        >
          Recover & keep my seat
        </button>
      </RecoveryOption>

      {/* Option 3 — Re-enroll as new (last resort, orphans the bond) */}
      <RecoveryOption
        badge="3"
        tone="err"
        title="Re-enroll as a new node"
        body="Last resort: wipes the consensus key and comes back with a NEW identity. Any bonded cluster seat is ORPHANED — it stays bonded to the old key and you must register and bond again. Use this only if you have lost your operator mnemonic."
      >
        {!orphanArmed ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setOrphanArmed(true)}
          >
            Re-enroll (orphans bond)…
          </button>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 11.5, color: "var(--fg-300)" }}>
              This orphans your bonded seat. Type{" "}
              <span className="mono" style={{ color: "var(--gold)" }}>
                {ORPHAN_CONFIRM_PHRASE}
              </span>{" "}
              to confirm.
            </span>
            <input
              type="text"
              className="input mono"
              value={orphanConfirm}
              onChange={(e) => setOrphanConfirm(e.target.value)}
              placeholder={ORPHAN_CONFIRM_PHRASE}
              autoComplete="off"
              spellCheck={false}
              style={{ maxWidth: 220 }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn btn--danger btn--sm"
                disabled={!orphanReady}
                onClick={onReEnroll}
              >
                Confirm re-enroll
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setOrphanArmed(false);
                  setOrphanConfirm("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </RecoveryOption>
    </div>
  );
}

function RecoveryOption({
  badge,
  tone,
  title,
  body,
  recommended,
  children,
}: {
  badge: string;
  tone: "ok" | "gold" | "err";
  title: string;
  body: string;
  recommended?: boolean;
  children: ReactNode;
}) {
  const toneColor =
    tone === "ok" ? "oklch(0.82 0.16 155)" : tone === "gold" ? "var(--gold)" : "var(--err, #e5484d)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        gap: 16,
        padding: "16px 0",
        alignItems: "center",
        borderTop: "1px solid var(--glass-stroke)",
      }}
    >
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          display: "grid",
          placeItems: "center",
          border: `1px solid ${toneColor}`,
          color: toneColor,
          fontFamily: "var(--f-mono)",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {badge}
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: "var(--fg-100)" }}>
          {title}
          {recommended ? (
            <span
              className="mono"
              style={{
                marginLeft: 8,
                fontSize: 10,
                letterSpacing: "0.08em",
                color: "var(--gold)",
                border: "1px solid var(--gold)",
                borderRadius: 5,
                padding: "1px 5px",
              }}
            >
              RECOMMENDED
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-400)", marginTop: 4, lineHeight: 1.5 }}>
          {body}
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}
