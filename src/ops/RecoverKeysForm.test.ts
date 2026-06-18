import { describe, expect, it } from "vitest";
import {
  isRecoverKeysInputComplete,
  isValidRecoverDisk,
  isValidRecoverHost,
} from "./RecoverKeysForm";

describe("recover-keys manual host/disk validation", () => {
  it("accepts IPv4 / DNS hosts and a /dev install disk", () => {
    expect(isValidRecoverHost("10.0.0.5")).toBe(true);
    expect(isValidRecoverHost("203.0.113.10")).toBe(true);
    expect(isValidRecoverHost("node-1.example.internal")).toBe(true);
    expect(isValidRecoverDisk("/dev/sda")).toBe(true);
    expect(isValidRecoverDisk("/dev/vda")).toBe(true);
    expect(isValidRecoverDisk("/dev/nvme0n1")).toBe(true);
  });

  it("rejects empty / malformed host and disk", () => {
    expect(isValidRecoverHost("")).toBe(false);
    expect(isValidRecoverHost(undefined)).toBe(false);
    expect(isValidRecoverHost("has space")).toBe(false);
    expect(isValidRecoverDisk("")).toBe(false);
    expect(isValidRecoverDisk(undefined)).toBe(false);
    expect(isValidRecoverDisk("sda")).toBe(false); // missing /dev/
    expect(isValidRecoverDisk("/dev/../etc/passwd")).toBe(false); // traversal
  });

  it("is complete only when BOTH host and disk are valid (manual fallback satisfied)", () => {
    expect(isRecoverKeysInputComplete(undefined)).toBe(false);
    expect(isRecoverKeysInputComplete({ host: "", disk: "" })).toBe(false);
    expect(isRecoverKeysInputComplete({ host: "10.0.0.5", disk: "" })).toBe(false);
    expect(isRecoverKeysInputComplete({ host: "", disk: "/dev/sda" })).toBe(false);
    // Auto-resolve came up empty but the operator typed both → op can proceed.
    expect(isRecoverKeysInputComplete({ host: "10.0.0.5", disk: "/dev/sda" })).toBe(true);
    // Pre-filled from auto-resolve also completes.
    expect(
      isRecoverKeysInputComplete({ host: "203.0.113.10", disk: "/dev/vda", operatorId: "0xabc" }),
    ).toBe(true);
  });
});
