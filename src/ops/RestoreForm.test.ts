import { describe, expect, it } from "vitest";
import { isRestoreInputComplete } from "./RestoreForm";

describe("restore input validation", () => {
  it("requires a 32-byte operator peer id", () => {
    expect(isRestoreInputComplete(undefined)).toBe(false);
    expect(isRestoreInputComplete({ peerIdHex: "0x" + "aa".repeat(31) })).toBe(false);
    expect(isRestoreInputComplete({ peerIdHex: "0x" + "aa".repeat(32) })).toBe(true);
  });
});
