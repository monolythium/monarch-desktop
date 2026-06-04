import { describe, expect, it } from "vitest";
import {
  bpsToPercent,
  formatLythHex,
  hostingClassLabel,
  normalizeOperatorIdList,
} from "./hooks";

describe("bpsToPercent", () => {
  it("formats a 0..=10000 basis-points score as a percent", () => {
    expect(bpsToPercent(10000)).toBe("100.0%");
    expect(bpsToPercent(7350)).toBe("73.5%");
    expect(bpsToPercent(100)).toBe("1.0%"); // PROTOCOL_MAX_OPERATOR_FEE_BPS
    expect(bpsToPercent(0)).toBe("0.0%");
  });

  it("honours the digits argument", () => {
    expect(bpsToPercent(7350, 0)).toBe("74%");
    expect(bpsToPercent(12, 2)).toBe("0.12%");
  });

  it("renders an em dash for missing / NaN values", () => {
    expect(bpsToPercent(null)).toBe("—");
    expect(bpsToPercent(undefined)).toBe("—");
    expect(bpsToPercent(Number.NaN)).toBe("—");
  });
});

describe("formatLythHex", () => {
  it("formats a 0x-hex lythoshi uint256 as LYTH (LYTH = 18 decimals)", () => {
    // 0.1 LYTH = 1e17 lythoshi (0x16345785d8a0000) — the prover-market fee floor.
    expect(formatLythHex("0x16345785d8a0000")).toBe("0.1 LYTH");
    // 250 LYTH = 250e18 lythoshi (0xd8d726b7177a80000) — the prover bond.
    expect(formatLythHex("0xd8d726b7177a80000")).toBe("250 LYTH");
    expect(formatLythHex("0x0")).toBe("0 LYTH");
  });

  it("renders an em dash for empty / malformed input", () => {
    expect(formatLythHex(null)).toBe("—");
    expect(formatLythHex(undefined)).toBe("—");
    expect(formatLythHex("")).toBe("—");
    expect(formatLythHex("not-hex")).toBe("—");
  });
});

describe("hostingClassLabel", () => {
  it("maps the node-registry wire strings to human labels", () => {
    expect(hostingClassLabel("bare_metal")).toBe("bare-metal");
    expect(hostingClassLabel("co_location")).toBe("co-location");
    expect(hostingClassLabel("cloud")).toBe("cloud");
  });

  it("renders an em dash for unknown / missing classes", () => {
    expect(hostingClassLabel(null)).toBe("—");
    expect(hostingClassLabel(undefined)).toBe("—");
    expect(hostingClassLabel("mainframe")).toBe("—");
  });
});

describe("normalizeOperatorIdList", () => {
  it("deduplicates non-empty operator ids while preserving order", () => {
    expect(normalizeOperatorIdList([
      " 0xaaa ",
      null,
      "",
      "0xbbb",
      "0xaaa",
      undefined,
      "0xccc",
    ])).toEqual(["0xaaa", "0xbbb", "0xccc"]);
  });
});
