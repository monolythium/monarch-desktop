// Shared operator-mnemonic validation.
//
// Extracted from OperatorKeySettings so the setup wizard and the Operations
// key panel validate identically — both must match what the signing path
// (`mnemonicToMlDsa65Backend`) will accept, so this delegates to the SDK's
// `validateMnemonic` (24-word BIP-39 + checksum) and maps failures to
// actionable copy.

import {
  MLDSA65_MNEMONIC_WORDS,
  validateMnemonic,
} from "@monolythium/core-sdk/crypto";

export type MnemonicValidation =
  | { ok: true }
  | { ok: false; tone: "err" | "warn"; text: string };

export function validateOperatorMnemonic(raw: string): MnemonicValidation {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return { ok: false, tone: "err", text: "Enter the operator mnemonic." };
  }
  const words = normalized.split(" ").length;
  if (words !== MLDSA65_MNEMONIC_WORDS) {
    return {
      ok: false,
      tone: "err",
      text: `Operator mnemonic must be ${MLDSA65_MNEMONIC_WORDS} words.`,
    };
  }
  if (!validateMnemonic(normalized)) {
    return {
      ok: false,
      tone: "err",
      text: "Not a valid recovery phrase (unknown word or bad checksum).",
    };
  }
  return { ok: true };
}
