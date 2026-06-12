// Disk-helper tests + provisioning IPC wiring tests.
//
// The machine-config YAML is generated RUST-SIDE (src-tauri/src/provision.rs);
// its content assertions (full cluster PKI, cleared file envs, full-node
// flags, host/disk threading) live in that module's Rust unit tests. What the
// TS layer owns — and what is tested here — is the disk picker helpers and the
// IPC wiring: the right commands invoked with the right payloads, and the
// Rust-side result shapes surfaced unchanged.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { normalizeDevice, validateDevice } from "./provisionConfig";
import { talosGenerateFullNodeConfig, talosMaintenanceApply } from "./bridge";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("talosGenerateFullNodeConfig wiring", () => {
  it("invokes the Rust generator with host + disk and returns the bundle", async () => {
    const bundle = {
      configYaml: "version: v1alpha1\n",
      talosconfigYaml: "context: monarch-node\n",
    };
    invokeMock.mockResolvedValueOnce(bundle);

    const result = await talosGenerateFullNodeConfig("10.0.0.5", "/dev/vda");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("talos_generate_full_node_config", {
      host: "10.0.0.5",
      disk: "/dev/vda",
    });
    expect(result).toEqual(bundle);
  });

  it("surfaces a Rust-side validation rejection", async () => {
    invokeMock.mockRejectedValueOnce(new Error('invalid install disk "vda"'));
    await expect(talosGenerateFullNodeConfig("10.0.0.5", "vda")).rejects.toThrow(
      /invalid install disk/,
    );
  });
});

describe("talosMaintenanceApply wiring", () => {
  const textResult = {
    endpoint: "https://10.0.0.5:50000",
    nodeAddress: "10.0.0.5",
    command: "talos apply-config --insecure --mode try (dry-run)",
    output: "dry-run accepted; no validation warnings reported",
    service: null,
  };

  it("dry-run: forwards the YAML without a talosconfig", async () => {
    invokeMock.mockResolvedValueOnce({
      ...textResult,
      talosconfigPath: null,
      talosconfigError: null,
    });

    const result = await talosMaintenanceApply({
      host: "10.0.0.5",
      configYaml: "version: v1alpha1\n",
      dryRun: true,
      mode: "try",
    });

    expect(invokeMock).toHaveBeenCalledWith("talos_maintenance_apply", {
      host: "10.0.0.5",
      configYaml: "version: v1alpha1\n",
      dryRun: true,
      mode: "try",
      talosconfigYaml: null,
    });
    expect(result.output).toContain("dry-run accepted");
    expect(result.talosconfigPath).toBeNull();
  });

  it("commit: forwards the talosconfig and surfaces the persisted path", async () => {
    invokeMock.mockResolvedValueOnce({
      ...textResult,
      talosconfigPath: "/appdata/talosconfigs/10.0.0.5.talosconfig",
      talosconfigError: null,
    });

    const result = await talosMaintenanceApply({
      host: "10.0.0.5",
      configYaml: "version: v1alpha1\n",
      dryRun: false,
      mode: "reboot",
      talosconfigYaml: "context: monarch-node\n",
    });

    expect(invokeMock).toHaveBeenCalledWith("talos_maintenance_apply", {
      host: "10.0.0.5",
      configYaml: "version: v1alpha1\n",
      dryRun: false,
      mode: "reboot",
      talosconfigYaml: "context: monarch-node\n",
    });
    expect(result.talosconfigPath).toBe("/appdata/talosconfigs/10.0.0.5.talosconfig");
    expect(result.talosconfigError).toBeNull();
  });

  it("commit: a persist failure is surfaced without masking the apply", async () => {
    invokeMock.mockResolvedValueOnce({
      ...textResult,
      talosconfigPath: null,
      talosconfigError: "could not save the node's talosconfig: disk full",
    });

    const result = await talosMaintenanceApply({
      host: "10.0.0.5",
      configYaml: "version: v1alpha1\n",
      dryRun: false,
      mode: "reboot",
      talosconfigYaml: "context: monarch-node\n",
    });

    expect(result.output).toBeTruthy();
    expect(result.talosconfigError).toContain("could not save");
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
