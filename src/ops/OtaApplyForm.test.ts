import { describe, expect, it } from "vitest";
import { isOtaApplyInputComplete, isValidUpgradeImage } from "./OtaApplyForm";

describe("OS upgrade input validation", () => {
  it("accepts tagged and digest image references", () => {
    expect(isValidUpgradeImage("ghcr.io/monolythium/monarch-os:2026.06.01")).toBe(true);
    expect(
      isValidUpgradeImage(
        "registry.example/monarch/os@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ),
    ).toBe(true);
  });

  it("rejects bare names, whitespace, and incomplete inputs", () => {
    expect(isValidUpgradeImage("monarch-os")).toBe(false);
    expect(isValidUpgradeImage("ghcr.io/monolythium/monarch os:latest")).toBe(false);
    expect(isValidUpgradeImage("ghcr.io/monolythium/monarch-os")).toBe(false);
    expect(isValidUpgradeImage("registry.example/monarch/os@sha256:not-a-digest")).toBe(false);
    expect(isOtaApplyInputComplete(undefined)).toBe(false);
  });

  it("requires a known reboot mode", () => {
    expect(
      isOtaApplyInputComplete({
        image: "ghcr.io/monolythium/monarch-os:2026.06.01",
        stage: false,
        rebootMode: "default",
      }),
    ).toBe(true);
    expect(
      isOtaApplyInputComplete({
        image: "ghcr.io/monolythium/monarch-os:2026.06.01",
        stage: true,
        rebootMode: "powercycle",
      }),
    ).toBe(true);
  });
});
