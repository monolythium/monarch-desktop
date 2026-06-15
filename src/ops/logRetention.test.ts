import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOG_RETENTION,
  LOG_RETENTION_LIMITS,
  isLogRetentionInputComplete,
} from "./types";
import { formatBytes } from "../views/Logs";

describe("log retention input validation", () => {
  it("accepts the default retention", () => {
    expect(isLogRetentionInputComplete(DEFAULT_LOG_RETENTION)).toBe(true);
  });

  it("rejects out-of-range or non-integer bounds", () => {
    expect(isLogRetentionInputComplete(undefined)).toBe(false);
    expect(isLogRetentionInputComplete({ maxMegabytes: 0, maxFiles: 5 })).toBe(false);
    expect(isLogRetentionInputComplete({ maxMegabytes: 512, maxFiles: 0 })).toBe(false);
    expect(
      isLogRetentionInputComplete({
        maxMegabytes: 512,
        maxFiles: LOG_RETENTION_LIMITS.maxFiles + 1,
      }),
    ).toBe(false);
    expect(
      isLogRetentionInputComplete({
        maxMegabytes: LOG_RETENTION_LIMITS.maxMegabytes + 1,
        maxFiles: 5,
      }),
    ).toBe(false);
    expect(isLogRetentionInputComplete({ maxMegabytes: 1.5, maxFiles: 5 })).toBe(false);
    expect(isLogRetentionInputComplete({ maxMegabytes: 512, maxFiles: 3.2 })).toBe(false);
    expect(isLogRetentionInputComplete({ maxMegabytes: Number.NaN, maxFiles: 5 })).toBe(false);
  });
});

describe("formatBytes", () => {
  it("formats binary byte sizes the operator sees in the panel", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    // The live fleet's 10GB log.
    expect(formatBytes(10 * 1024 * 1024 * 1024)).toBe("10.0 GB");
  });

  it("returns a placeholder for invalid sizes", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});
