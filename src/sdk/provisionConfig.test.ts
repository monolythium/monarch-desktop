import { describe, expect, it } from "vitest";
import {
  buildFullNodeConfig,
  normalizeDevice,
  validateDevice,
  PROVISION_CHAIN_ID,
  PROVISION_REGISTRY_NETWORK,
  type TalosMachineSecrets,
} from "./provisionConfig";

// A syntactically valid Talos machine identity for the builder tests. The crt /
// key are base64 placeholders that satisfy the structural guards (real PEM is
// generated per node at provision time); the token matches the Talos
// `<id>.<secret>` shape. These are NOT real keys.
const MACHINE_SECRETS: TalosMachineSecrets = {
  caCrt: "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCkZBS0VDQQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==",
  caKey: "LS0tLS1CRUdJTiBFRDI1NTE5IFBSSVZBVEUgS0VZLS0tLS0KRkFLRUtFWQotLS0tLUVORCBFRDI1NTE5IFBSSVZBVEUgS0VZLS0tLS0K",
  token: "ustbxo.rbumpdfayhzkl191",
};

describe("buildFullNodeConfig", () => {
  const yaml = buildFullNodeConfig({ disk: "/dev/vda", mode: "full", machineSecrets: MACHINE_SECRETS });

  it("embeds the chosen install disk", () => {
    expect(yaml).toContain("install:");
    expect(yaml).toContain("disk: /dev/vda");
  });

  it("pins the node to full (non-signing) mode", () => {
    expect(yaml).toContain("PROTOCORE_NODE_MODE=full");
  });

  it("emits the RPC / p2p / discovery / chain / registry pins", () => {
    expect(yaml).toContain("PROTOCORE_RPC_LISTEN=0.0.0.0:8545");
    expect(yaml).toContain("PROTOCORE_P2P_LISTEN=/ip4/0.0.0.0/tcp/29898");
    expect(yaml).toContain("PROTOCORE_DISCOVERY=hybrid");
    expect(yaml).toContain(`PROTOCORE_CHAIN_ID=${PROVISION_CHAIN_ID}`);
    expect(yaml).toContain(`PROTOCORE_REGISTRY_NETWORK=${PROVISION_REGISTRY_NETWORK}`);
  });

  it("is a two-document machine config with the protocore extension", () => {
    expect(yaml).toContain("version: v1alpha1");
    expect(yaml).toContain("\n---\n");
    expect(yaml).toContain("kind: ExtensionServiceConfig");
    expect(yaml).toContain("name: protocore");
  });

  it("carries the Talos machine identity (token + CA) Talos requires", () => {
    // Talos rejects a machine config without an issuing CA; the builder must
    // emit machine.token + machine.ca.crt/key.
    expect(yaml).toMatch(/^\s*token: ustbxo\.rbumpdfayhzkl191$/m);
    expect(yaml).toMatch(/^\s*ca:$/m);
    expect(yaml).toContain(`crt: ${MACHINE_SECRETS.caCrt}`);
    expect(yaml).toContain(`key: ${MACHINE_SECRETS.caKey}`);
    expect(yaml).toContain("wipe: false");
  });

  it("carries NO Kubernetes cluster PKI", () => {
    // A full node needs the Talos machine CA but NOT the k8s cluster PKI.
    expect(yaml).not.toMatch(/^\s*id:\s/m); // cluster.id
    expect(yaml).not.toMatch(/^\s*secret:\s/m); // cluster.secret
    expect(yaml).not.toContain("aggregatorCA");
    expect(yaml).not.toContain("serviceAccount");
  });

  it("carries NO operator secret, enrollment, or TPM env", () => {
    expect(yaml).not.toContain("PROTOCORE_REQUIRE_ENROLLMENT");
    expect(yaml).not.toContain("PROTOCORE_REQUIRE_TPM_BINDING");
    expect(yaml).not.toContain("PROTOCORE_KEYSTORE_PASSPHRASE");
    expect(yaml).not.toContain("PROTOCORE_OPERATOR_MNEMONIC");
    expect(yaml).not.toContain("PROTOCORE_OPERATOR_PRIVATE_KEY");
    expect(yaml).not.toMatch(/_SHARE/);
    const envLines = yaml
      .split("\n")
      .filter((line) => line.trim().startsWith("- PROTOCORE_"));
    for (const line of envLines) {
      expect(line.toLowerCase()).not.toContain("secret");
      expect(line.toLowerCase()).not.toContain("passphrase");
      expect(line.toLowerCase()).not.toContain("mnemonic");
    }
  });

  it("carries no unfilled placeholder markers", () => {
    // The Rust apply scan rejects these; the generator must never emit them.
    // (Restricted to the env + structural lines — the explanatory comments
    // legitimately say "placeholder" when describing the inert endpoint.)
    const significant = yaml
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
      .toLowerCase();
    for (const marker of ["replace-with", "changeme", "placeholder", "example-secret"]) {
      expect(significant).not.toContain(marker);
    }
    // No angle-bracket placeholder anywhere (base64 PEM never contains '<').
    expect(yaml).not.toContain("<");
  });

  it("reflects a different disk choice", () => {
    const sda = buildFullNodeConfig({ disk: "/dev/sda", mode: "full", machineSecrets: MACHINE_SECRETS });
    expect(sda).toContain("disk: /dev/sda");
    expect(sda).not.toContain("disk: /dev/vda");
  });

  it("rejects an empty or malformed disk", () => {
    expect(() => buildFullNodeConfig({ disk: "", mode: "full", machineSecrets: MACHINE_SECRETS })).toThrow();
    expect(() => buildFullNodeConfig({ disk: "/dev/v da", mode: "full", machineSecrets: MACHINE_SECRETS })).toThrow();
    expect(() => buildFullNodeConfig({ disk: "0.0.0.0:8545", mode: "full", machineSecrets: MACHINE_SECRETS })).toThrow();
  });

  it("rejects missing or malformed machine secrets", () => {
    const ok = MACHINE_SECRETS;
    expect(() =>
      buildFullNodeConfig({ disk: "/dev/vda", mode: "full", machineSecrets: { ...ok, caCrt: "" } }),
    ).toThrow(/CA cert is required/);
    expect(() =>
      buildFullNodeConfig({ disk: "/dev/vda", mode: "full", machineSecrets: { ...ok, caKey: "  " } }),
    ).toThrow(/CA key is required/);
    expect(() =>
      buildFullNodeConfig({ disk: "/dev/vda", mode: "full", machineSecrets: { ...ok, token: "not-a-token" } }),
    ).toThrow(/not a valid Talos token/);
    expect(() =>
      buildFullNodeConfig({ disk: "/dev/vda", mode: "full", machineSecrets: { ...ok, caCrt: "<replace-with-ca>" } }),
    ).toThrow(/placeholder/);
    expect(() =>
      buildFullNodeConfig({ disk: "/dev/vda", mode: "full", machineSecrets: { ...ok, caCrt: "not base64 ###" } }),
    ).toThrow(/base64/);
  });
});

describe("normalizeDevice", () => {
  it("prefixes a bare kernel name with /dev/", () => {
    expect(normalizeDevice("sda")).toBe("/dev/sda");
    expect(normalizeDevice("nvme0n1")).toBe("/dev/nvme0n1");
  });

  it("passes through an absolute path", () => {
    expect(normalizeDevice("/dev/vda")).toBe("/dev/vda");
  });

  it("trims and tolerates empty", () => {
    expect(normalizeDevice("  /dev/sda  ")).toBe("/dev/sda");
    expect(normalizeDevice("")).toBe("");
  });
});

describe("validateDevice", () => {
  const disks = [{ deviceName: "/dev/vda" }, { deviceName: "/dev/sr0" }];

  it("accepts a device in the enumerated list", () => {
    expect(validateDevice("/dev/vda", disks)).toEqual({ ok: true });
  });

  it("matches across bare / absolute forms", () => {
    expect(validateDevice("vda", disks)).toEqual({ ok: true });
    expect(validateDevice("/dev/vda", [{ deviceName: "vda" }])).toEqual({ ok: true });
  });

  it("rejects a device not in the list", () => {
    const result = validateDevice("/dev/sdb", disks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("/dev/sdb");
  });

  it("flags an empty selection", () => {
    expect(validateDevice("", disks).ok).toBe(false);
  });

  it("treats an empty disk list as an unproven manual entry", () => {
    const result = validateDevice("/dev/sda", []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("/dev/sda");
  });
});
