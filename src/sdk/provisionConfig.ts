// Machine-config generator for in-app Talos node provisioning.
//
// A freshly flashed Monarch OS node carries kernel + initramfs + the protocore
// system extension, but NO machine config — so it boots Talos into maintenance
// mode and does not serve RPC. `buildFullNodeConfig` emits the single Talos
// machine-config YAML that turns it into a working FULL (non-signing) node: a
// minimal v1alpha1 machine doc that installs to the operator-chosen disk, plus
// the protocore ExtensionServiceConfig that pins it to `full` mode and the
// testnet network.
//
// A full node needs NO cluster PKI, NO secrets bundle, NO bootstrap: protocore
// runs as a Talos system extension (not a Kubernetes workload) and resolves
// genesis + peers at runtime from the baked chain-registry. This builder
// therefore never emits a CA, token, enrollment material, TPM binding, or any
// inline secret — operator (signing) provisioning needs an enrollment bundle
// the app cannot produce yet and is intentionally out of scope here.
//
// Pure and I/O-free so it can back a live config preview and be unit-tested.

/** Node mode the in-app provision flow can produce. Only `full` for v1. */
export type ProvisionNodeMode = "full";

export type BuildFullNodeConfigOptions = {
  /** Install target, e.g. `/dev/vda`. Validated against the enumerated disks. */
  disk: string;
  /** Only `full` is provisionable in v1. */
  mode: ProvisionNodeMode;
};

/** Chain the testnet provision flow pins a fresh node to. */
export const PROVISION_CHAIN_ID = 69420;

/** chain-registry network key a fresh node resolves genesis + peers from. */
export const PROVISION_REGISTRY_NETWORK = "testnet-69420";

/**
 * Build the Talos machine-config YAML for a FULL Monolythium node.
 *
 * The output is two YAML documents joined by `---`:
 *   1. a minimal v1alpha1 machine doc — install disk + an inert cluster
 *      endpoint placeholder (Monarch never bootstraps etcd/k8s);
 *   2. the protocore ExtensionServiceConfig — `PROTOCORE_NODE_MODE=full` plus
 *      the RPC / p2p / discovery / chain / registry pins.
 *
 * Deliberately absent: any PKI, token, enrollment env, TPM binding, or inline
 * secret. `PROTOCORE_REQUIRE_ENROLLMENT` is never emitted (a full node carries
 * no enrollment material — setting it would fail the node closed).
 */
export function buildFullNodeConfig(opts: BuildFullNodeConfigOptions): string {
  const disk = opts.disk.trim();
  if (!disk) {
    throw new Error("buildFullNodeConfig: an install disk is required.");
  }
  // The disk goes straight into the YAML; reject obviously malformed input so a
  // stray newline can't smuggle a second document in.
  if (/\s/.test(disk) || disk.includes(":")) {
    throw new Error(`buildFullNodeConfig: invalid install disk "${disk}".`);
  }

  return `version: v1alpha1
machine:
  type: controlplane
  install:
    disk: ${disk}
    wipe: false
  # No certs/tokens/secrets needed for a Monarch FULL node: protocore is a Talos
  # system extension, not a Kubernetes workload, and genesis/peers resolve at
  # runtime from chain-registry baked into the image.
cluster:
  controlPlane:
    endpoint: https://127.0.0.1:6443
---
apiVersion: v1alpha1
kind: ExtensionServiceConfig
name: protocore
environment:
  - PROTOCORE_NODE_MODE=full
  - PROTOCORE_RPC_LISTEN=0.0.0.0:8545
  - PROTOCORE_P2P_LISTEN=/ip4/0.0.0.0/tcp/29898
  - PROTOCORE_DISCOVERY=hybrid
  - PROTOCORE_CHAIN_ID=${PROVISION_CHAIN_ID}
  - PROTOCORE_REGISTRY_NETWORK=${PROVISION_REGISTRY_NETWORK}
`;
}

export type DeviceValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate that a chosen install device is among the node's enumerated disks.
 *
 * Both sides are normalised to the `/dev/<name>` form first (the Talos proto
 * reports bare names while the picker / template use the absolute path). When
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
