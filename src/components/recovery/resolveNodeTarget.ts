// Resolve the Talos host + install disk for the seat-preserving recover-keys
// recovery, ANCHORED to the active connection. Pure logic (no React) so it can
// be unit-tested by mocking the sdk.

import { talosHostTelemetry, talosMaintenanceDisks, talosStatus } from "../../sdk";

export type NodeTarget = { host: string | null; disk: string | null };

/** Resolve the Talos host + install disk for the recovery config, ANCHORED to
 *  the active connection. The host is the connected node's address; the disk is
 *  its system disk. Best-effort — NEVER throws; whatever it could not resolve
 *  comes back null and the operator fills it in via the manual recover-keys form
 *  (RecoverKeysForm), so the op is never a silent dead-end.
 *
 *  Resolution order matters for a QUARANTINED / booting node (the exact state
 *  the recovery menu renders in):
 *   - HOST is resolved from `talosStatus()` FIRST — `build_status` returns
 *     `node_address` whenever the node is `configured` (endpoint+configPath in
 *     the keychain), reachable or not, with NO live probe. Telemetry is only a
 *     secondary host source. This is why host is robust even when a live
 *     telemetry read fails on a quarantined node.
 *   - DISK uses telemetry first, but a quarantined node's live telemetry read
 *     frequently fails or returns no `systemDisk`. When that happens AND the host
 *     is known, fall back to the maintenance-mode disk enumerator
 *     `talosMaintenanceDisks(host)` (the SAME picker the provisioning flow uses).
 *     Both disk sources are best-effort. */
export async function resolveNodeTarget(): Promise<NodeTarget> {
  let host: string | null = null;
  let disk: string | null = null;

  // HOST FIRST, from the active-connection status (no live probe needed).
  const status = await talosStatus().catch(() => null);
  host = status?.nodeAddress || status?.endpoint || null;

  // Telemetry: a secondary host source AND the primary disk source. May fail on
  // a quarantined / booting node — best-effort.
  try {
    const telemetry = await talosHostTelemetry();
    if (!host) host = telemetry.nodeAddress || telemetry.endpoint || null;
    const system = telemetry.disks.find((d) => d.systemDisk && !d.readonly);
    const fallback = telemetry.disks.find((d) => !d.readonly);
    disk = (system ?? fallback)?.deviceName ?? null;
  } catch {
    /* telemetry unavailable — host already resolved from status; disk falls back below */
  }

  // DISK FALLBACK: telemetry gave us nothing usable but we know the host — ask
  // the maintenance-mode disk enumerator (the provisioning disk picker). This is
  // a maintenance-mode RPC and may error on a normally-running node, so it is
  // strictly best-effort and must never mask the host resolution above.
  if (!disk && host) {
    try {
      const disks = await talosMaintenanceDisks(host);
      const system = disks.find((d) => !d.readonly && d.systemDiskHint);
      const fallback = disks.find((d) => !d.readonly);
      disk = (system ?? fallback)?.deviceName ?? null;
    } catch {
      /* maintenance disks unavailable — operator enters the disk manually */
    }
  }

  return { host, disk };
}
