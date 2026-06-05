import { describe, expect, it } from "vitest";
import { isOperatorDisplayInputComplete } from "./OperatorDisplayForm";

const peerIdHex = "0x" + "aa".repeat(32);

describe("operator display form validation", () => {
  it("requires a 32-byte peer id and bounded display text", () => {
    expect(isOperatorDisplayInputComplete(undefined)).toBe(false);
    expect(
      isOperatorDisplayInputComplete({
        peerIdHex: "0x" + "aa".repeat(31),
        moniker: "Monolythium Foundation 01",
        alias: "foundation-01",
      }),
    ).toBe(false);
    expect(
      isOperatorDisplayInputComplete({
        peerIdHex,
        moniker: "bad\nname",
        alias: "foundation-01",
      }),
    ).toBe(false);
    expect(
      isOperatorDisplayInputComplete({
        peerIdHex,
        moniker: "a".repeat(129),
        alias: "foundation-01",
      }),
    ).toBe(false);
    expect(
      isOperatorDisplayInputComplete({
        peerIdHex,
        moniker: "",
        alias: "",
      }),
    ).toBe(true);
    expect(
      isOperatorDisplayInputComplete({
        peerIdHex,
        moniker: "Monolythium Foundation 01",
        alias: "foundation-01",
      }),
    ).toBe(true);
  });
});
