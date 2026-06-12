// Install-disk helpers for in-app Talos node provisioning.
//
// The machine-config YAML itself is generated RUST-SIDE by the
// `talos_generate_full_node_config` command (src-tauri/src/provision.rs, via
// `talosGenerateFullNodeConfig` in bridge.ts): a freshly flashed Monarch OS
// node needs the COMPLETE Talos cluster PKI (machine CA + cluster
// ca/aggregatorCA/etcd.ca/serviceAccount + tokens) or it wedges at runtime —
// and minting that PKI is native crypto work (rcgen/rsa), not template
// interpolation. The generator also returns the node's talosconfig, which the
// committing apply persists; the YAML never needs to be assembled in the
// webview, so no templating lives here anymore.
//
// What remains in this module is the install-disk picker logic shared by
// ProvisionStep: normalising device names to the `/dev/<name>` form and
// validating an operator's choice against the node's enumerated disks.

export type DeviceValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate that a chosen install device is among the node's enumerated disks.
 *
 * Both sides are normalised to the `/dev/<name>` form first (the Talos proto
 * reports bare names while the picker / generator use the absolute path). When
 * the disk list is empty (enumeration failed and the operator typed a device
 * manually) validation cannot prove membership — the caller must require an
 * explicit override acknowledgement, signalled here by `ok: false` with a
 * manual-entry reason. A device that IS in the list is always `ok: true`.
 */
export function validateDevice(
  device: string,
  disks: ReadonlyArray<{ deviceName: string }>,
): DeviceValidation {
  const chosen = normalizeDevice(device);
  if (!chosen) {
    return { ok: false, reason: "Choose an install disk." };
  }
  if (disks.length === 0) {
    return {
      ok: false,
      reason: `Could not enumerate this node's disks — confirm ${chosen} is the right install target before applying.`,
    };
  }
  const found = disks.some((disk) => normalizeDevice(disk.deviceName) === chosen);
  if (!found) {
    return {
      ok: false,
      reason: `${chosen} was not found among this node's disks.`,
    };
  }
  return { ok: true };
}

/** Normalise a device to the `/dev/<name>` form, matching the Rust side. */
export function normalizeDevice(device: string): string {
  const trimmed = device.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/dev/${trimmed}`;
}
