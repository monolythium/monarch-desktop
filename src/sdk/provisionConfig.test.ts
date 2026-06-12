import { describe, expect, it } from "vitest";
import {
  buildFullNodeConfig,
  normalizeDevice,
  validateDevice,
  PROVISION_CHAIN_ID,
  PROVISION_REGISTRY_NETWORK,
} from "./provisionConfig";

describe("buildFullNodeConfig", () => {
  const yaml = buildFullNodeConfig({ disk: "/dev/vda", mode: "full" });

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

  it("carries NO secret, enrollment, or TPM env", () => {
    expect(yaml).not.toContain("PROTOCORE_REQUIRE_ENROLLMENT");
    expect(yaml).not.toContain("PROTOCORE_REQUIRE_TPM_BINDING");
    expect(yaml).not.toContain("PROTOCORE_KEYSTORE_PASSPHRASE");
    expect(yaml).not.toContain("PROTOCORE_OPERATOR_MNEMONIC");
    expect(yaml).not.toContain("PROTOCORE_OPERATOR_PRIVATE_KEY");
    expect(yaml).not.toMatch(/_SHARE/);
    // No Talos cluster PKI: no CA, no token, no secrets block. (Match the
    // YAML keys themselves, not the explanatory comment prose that mentions
    // "certs/tokens/secrets" to explain their absence.)
    const envLines = yaml
      .split("\n")
      .filter((line) => line.trim().startsWith("- PROTOCORE_"));
    for (const line of envLines) {
      expect(line.toLowerCase()).not.toContain("secret");
      expect(line.toLowerCase()).not.toContain("passphrase");
      expect(line.toLowerCase()).not.toContain("mnemonic");
    }
    expect(yaml).not.toMatch(/^\s*token:/m);
    expect(yaml).not.toMatch(/^\s*ca:/m);
    expect(yaml).toContain("wipe: false");
  });

  it("carries no unfilled placeholder markers", () => {
    // The Rust apply scan rejects these; the generator must never emit them.
    for (const marker of ["<", "replace-with", "changeme", "placeholder", "example-secret"]) {
      expect(yaml.toLowerCase()).not.toContain(marker);
    }
  });

  it("reflects a different disk choice", () => {
    const sda = buildFullNodeConfig({ disk: "/dev/sda", mode: "full" });
    expect(sda).toContain("disk: /dev/sda");
    expect(sda).not.toContain("disk: /dev/vda");
  });

  it("rejects an empty or malformed disk", () => {
    expect(() => buildFullNodeConfig({ disk: "", mode: "full" })).toThrow();
    expect(() => buildFullNodeConfig({ disk: "/dev/v da", mode: "full" })).toThrow();
    expect(() => buildFullNodeConfig({ disk: "0.0.0.0:8545", mode: "full" })).toThrow();
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
