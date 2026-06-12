// Machine-config generator for in-app Talos node provisioning.
//
// A freshly flashed Monarch OS node carries kernel + initramfs + the protocore
// system extension, but NO machine config — so it boots Talos into maintenance
// mode and does not serve RPC. `buildFullNodeConfig` emits the single Talos
// machine-config YAML that turns it into a working FULL (non-signing) node: a
// minimal v1alpha1 machine doc that installs to the operator-chosen disk and
// carries the node's Talos machine identity (issuing CA + bootstrap token),
// plus the protocore ExtensionServiceConfig that pins it to `full` mode and the
// testnet network.
//
// Why the machine CA + token are required (verified against a real Talos
// v1.13.0 maintenance node, dry-run): Talos's own `v1alpha1.Config` validator
// hard-rejects any machine config without an issuing CA —
//   "issuing CA or some accepted CAs are required (.machine.ca, machine.acceptedCAs)"
//   "issuing CA is required (.machine.ca)"
// — regardless of whether the node ever bootstraps etcd/Kubernetes. The CA and
// token are the node's *Talos* machine identity (its apid/trustd PKI), distinct
// from protocore's chain identity. A full node still needs them so Talos accepts
// the config and the maintenance API can hand off to the configured node.
//
// What a full node does NOT need (confirmed by dry-run: the minimal accepted
// shape is `machine.{type,token,ca,install}`): the full Kubernetes cluster PKI —
// `cluster.id`, `cluster.secret`, `cluster.ca`, the k8s aggregator/service-
// account/etcd CAs — none of which this builder emits. protocore runs as a Talos
// system extension (not a Kubernetes workload) and resolves genesis + peers at
// runtime from the baked chain-registry.
//
// What this builder NEVER emits: a chain-operator enrollment bundle, TPM
// binding, operator mnemonic/keystore passphrase, or any threshold/key share.
// `PROTOCORE_REQUIRE_ENROLLMENT` / `PROTOCORE_REQUIRE_TPM_BINDING` are explicitly
// set false to override the image's embedded true defaults (a full node carries no enrollment
// material — setting it would fail the node closed). Operator (signing)
// provisioning needs an enrollment bundle the app cannot produce yet and is
// intentionally out of scope here.
//
// The Talos machine secrets (`ca` + `token`) are generated per node — the
// `talosctl gen secrets` equivalent: a fresh self-signed Ed25519 CA and a
// bootstrap token. This builder takes them as input and is otherwise pure and
// I/O-free so it can back a live config preview and be unit-tested.

/** Node mode the in-app provision flow can produce. Only `full` for v1. */
export type ProvisionNodeMode = "full";

/**
 * A node's Talos machine identity: the issuing CA (PEM, base64-encoded as Talos
 * stores it in the machine config) and the bootstrap token. Generated per node
 * (the `talosctl gen secrets` equivalent), never shared between nodes.
 */
export type TalosMachineSecrets = {
  /** Issuing CA, base64-encoded PEM (the `machine.ca.crt` value). */
  caCrt: string;
  /** Issuing CA private key, base64-encoded PEM (the `machine.ca.key` value). */
  caKey: string;
  /** Bootstrap token (`machine.token`), e.g. `abcdef.0123456789abcdef`. */
  token: string;
};

export type BuildFullNodeConfigOptions = {
  /** Install target, e.g. `/dev/vda`. Validated against the enumerated disks. */
  disk: string;
  /** Only `full` is provisionable in v1. */
  mode: ProvisionNodeMode;
  /**
   * The node's Talos machine identity (issuing CA + token). Required: Talos
   * rejects a machine config without an issuing CA.
   */
  machineSecrets: TalosMachineSecrets;
};

/** Chain the testnet provision flow pins a fresh node to. */
export const PROVISION_CHAIN_ID = 69420;

/** chain-registry network key a fresh node resolves genesis + peers from. */
export const PROVISION_REGISTRY_NETWORK = "testnet-69420";

/** A base64 blob that is plausibly a non-empty PEM (cheap structural guard). */
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;

/** Talos bootstrap-token shape: `<id>.<secret>`, lowercase alnum. */
const TALOS_TOKEN_RE = /^[a-z0-9]{6}\.[a-z0-9]{16}$/;

/**
 * Build the Talos machine-config YAML for a FULL Monolythium node.
 *
 * The output is two YAML documents joined by `---`:
 *   1. a minimal v1alpha1 machine doc — the node's Talos machine identity
 *      (`machine.token` + `machine.ca`), the install disk, and an inert cluster
 *      endpoint placeholder (Monarch never bootstraps etcd/k8s);
 *   2. the protocore ExtensionServiceConfig — `PROTOCORE_NODE_MODE=full` plus
 *      the RPC / p2p / discovery / chain / registry pins.
 *
 * Deliberately absent: the full Kubernetes cluster PKI (`cluster.id/secret/ca`),
 * any operator enrollment env, TPM binding, or inline operator secret.
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

  const { caCrt, caKey, token } = opts.machineSecrets ?? ({} as TalosMachineSecrets);
  validateMachineSecrets({ caCrt, caKey, token });

  // Talos stores the CA crt/key as single-line base64; collapse any incidental
  // whitespace so the emitted YAML scalars are clean.
  const crt = caCrt.replace(/\s+/g, "");
  const key = caKey.replace(/\s+/g, "");
  const tok = token.trim();

  return `version: v1alpha1
machine:
  type: controlplane
  token: ${tok}
  # The node's Talos machine identity (issuing CA). Talos rejects a machine
  # config without one. This is the node's apid/trustd PKI — NOT a protocore
  # chain key, and NOT shared between nodes. Generated per node.
  ca:
    crt: ${crt}
    key: ${key}
  install:
    disk: ${disk}
    wipe: false
cluster:
  # No Kubernetes cluster PKI (id/secret/ca): protocore is a Talos system
  # extension, not a k8s workload, and genesis/peers resolve at runtime from
  # chain-registry baked into the image. Only an inert endpoint placeholder is
  # carried (Monarch never bootstraps etcd/k8s).
  controlPlane:
    endpoint: https://127.0.0.1:6443
---
apiVersion: v1alpha1
kind: ExtensionServiceConfig
name: protocore
environment:
  - PROTOCORE_NODE_MODE=full
  # The image's embedded protocore service config requires enrollment + TPM
  # binding by default. A
  # full (non-signing) node carries no enrollment bundle or TPM material, so we
  # MUST explicitly turn both off — otherwise ext-protocore crashes after the
  # maintenance apply with "PROTOCORE_EXPECTED_DIGEST_FILE is not readable".
  - PROTOCORE_REQUIRE_ENROLLMENT=false
  - PROTOCORE_REQUIRE_TPM_BINDING=false
  - PROTOCORE_RPC_LISTEN=0.0.0.0:8545
  - PROTOCORE_P2P_LISTEN=/ip4/0.0.0.0/tcp/29898
  - PROTOCORE_DISCOVERY=hybrid
  - PROTOCORE_CHAIN_ID=${PROVISION_CHAIN_ID}
  - PROTOCORE_REGISTRY_NETWORK=${PROVISION_REGISTRY_NETWORK}
`;
}

/**
 * Validate the Talos machine secrets before they go into the YAML. Catches the
 * empty / placeholder / wrong-shape cases in-app rather than letting the node's
 * validator reject the apply (or, worse, accepting a malformed identity).
 */
function validateMachineSecrets(s: TalosMachineSecrets): void {
  for (const [label, value] of [
    ["machine CA cert", s.caCrt],
    ["machine CA key", s.caKey],
    ["machine token", s.token],
  ] as const) {
    if (!value || !value.trim()) {
      throw new Error(`buildFullNodeConfig: ${label} is required (machine secrets are not generated).`);
    }
    // The Rust apply scan rejects these; refuse them here so a half-filled
    // template never reaches the node.
    const lower = value.toLowerCase();
    for (const marker of ["<", "replace-with", "changeme", "placeholder", "example-secret"]) {
      if (lower.includes(marker)) {
        throw new Error(`buildFullNodeConfig: ${label} looks like an unfilled placeholder ("${marker}").`);
      }
    }
  }
  if (!BASE64_RE.test(s.caCrt) || !BASE64_RE.test(s.caKey)) {
    throw new Error("buildFullNodeConfig: machine CA crt/key must be base64-encoded PEM.");
  }
  if (!TALOS_TOKEN_RE.test(s.token.trim())) {
    throw new Error(`buildFullNodeConfig: machine token "${s.token}" is not a valid Talos token (<id>.<secret>).`);
  }
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
