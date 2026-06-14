import { describe, expect, it } from "vitest";
import {
  FOUNDATION_OP_KINDS,
  MISSING_FOUNDATION_KEY_MESSAGE,
  MISSING_OPERATOR_KEY_MESSAGE,
  translateOpError,
} from "./errors";
import { OP_KINDS } from "./types";

describe("translateOpError", () => {
  it("maps the missing-operator-key dev-speak to plain English with a Keys link", () => {
    const out = translateOpError(
      new Error(
        "Operator mnemonic not in keychain. Store it under monarch-desktop/operator:mnemonic first.",
      ),
      "operator-register",
    );
    expect(out.friendly).toBe(MISSING_OPERATOR_KEY_MESSAGE);
    expect(out.nextStepRoute).toBe("/keys");
    expect(out.raw).toContain("operator:mnemonic");
  });

  it("is idempotent on the already-friendly operator key constant", () => {
    expect(translateOpError(MISSING_OPERATOR_KEY_MESSAGE, "redelegate").friendly).toBe(
      MISSING_OPERATOR_KEY_MESSAGE,
    );
    expect(translateOpError(MISSING_FOUNDATION_KEY_MESSAGE, "operator-restore").friendly).toContain(
      MISSING_FOUNDATION_KEY_MESSAGE,
    );
  });

  it("maps the foundation signer gap to the foundation message", () => {
    const out = translateOpError(
      "Foundation operations mnemonic not in keychain. Store it in Operator settings.",
      "operator-restore",
    );
    expect(out.friendly).toBe(MISSING_FOUNDATION_KEY_MESSAGE);
    expect(out.nextStepRoute).toBe("/keys");
  });

  it("translates insufficient balance with a Treasury fix-it", () => {
    const out = translateOpError(new Error("insufficient funds for transfer"), "operator-register");
    expect(out.friendly).toMatch(/balance/i);
    expect(out.nextStepRoute).toBe("/wallets");
  });

  it("translates duplicate registration", () => {
    const out = translateOpError("execution failed: already registered peer", "operator-register");
    expect(out.friendly).toMatch(/already registered/i);
  });

  it("translates method-not-found into update-your-node guidance", () => {
    const out = translateOpError({ code: -32601, message: "method not found" } as never, "redelegate");
    // rawMessage falls back to JSON for plain objects; feed a string too.
    const fromString = translateOpError("method not found: lyth_submit", "redelegate");
    expect(fromString.friendly).toMatch(/does not expose this method/i);
    expect(out.raw.length).toBeGreaterThan(0);
  });

  it("translates connection failures with a pairing fix-it", () => {
    const out = translateOpError(new Error("fetch failed: ECONNREFUSED 127.0.0.1:8545"), "operator-start");
    expect(out.friendly).toMatch(/could not reach the node/i);
    expect(out.nextStepRoute).toBe("/install");
  });

  it("keeps unknown errors verbatim behind a generic summary", () => {
    const out = translateOpError(new Error("some totally novel failure"), "ota-apply");
    expect(out.friendly).toContain("some totally novel failure");
    expect(out.raw).toBe("some totally novel failure");
  });

  it("clips multi-line raw messages to one line in the friendly fallback", () => {
    const out = translateOpError("line one detail\nline two stack", "ota-apply");
    expect(out.friendly).toContain("line one detail");
    expect(out.friendly).not.toContain("line two");
    expect(out.raw).toContain("line two stack");
  });

  it("declares only real op kinds foundation-only", () => {
    for (const kind of FOUNDATION_OP_KINDS) {
      expect(OP_KINDS).toContain(kind);
    }
    expect(FOUNDATION_OP_KINDS.size).toBe(5);
  });
});
