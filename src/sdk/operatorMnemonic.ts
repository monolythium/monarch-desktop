// Shared PQM-1 operator-mnemonic validation.
//
// Extracted from OperatorKeySettings so the setup wizard and the Operations
// key panel validate identically — both must match byte-for-byte what the
// signing path (`pqm1MnemonicToMlDsa65Backend`) will accept, so this delegates
// to the SDK decoder (`pqm1MnemonicToPayload`) and maps its typed `Pqm1Error`
// kinds to actionable copy. A MetaMask / BIP-32 phrase decodes to a non-0x01
// algo tag and is rejected with a clear "not a Monolythium operator key" warn.

import {
  PQM1_ALGO_TAG_MLDSA65,
  PQM1_V1_MNEMONIC_WORDS,
  Pqm1Error,
  pqm1MnemonicToPayload,
} from "@monolythium/core-sdk/crypto";

export type MnemonicValidation =
  | { ok: true }
  | { ok: false; tone: "err" | "warn"; text: string };

const NOT_OPERATOR_KEY =
  "This mnemonic is not a Monolythium operator key (algo tag is not 0x01). " +
  "MetaMask / BIP-32 seed phrases are NOT compatible — use a PQM-1 (ML-DSA-65) mnemonic.";

export function validateOperatorMnemonic(raw: string): MnemonicValidation {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return { ok: false, tone: "err", text: "Enter the operator mnemonic." };
  }
  try {
    const payload = pqm1MnemonicToPayload(normalized);
    if (payload.algoTag !== PQM1_ALGO_TAG_MLDSA65) {
      return { ok: false, tone: "warn", text: NOT_OPERATOR_KEY };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Pqm1Error) {
      switch (err.kind) {
        case "unsupportedAlgorithm":
          return { ok: false, tone: "warn", text: NOT_OPERATOR_KEY };
        case "badWordCount":
          return {
            ok: false,
            tone: "err",
            text: `Operator mnemonic must be ${PQM1_V1_MNEMONIC_WORDS} words.`,
          };
        case "bip39Decode":
          return {
            ok: false,
            tone: "err",
            text: "Not a valid BIP-39 mnemonic (bad word or checksum).",
          };
        case "badPayloadLength":
          return {
            ok: false,
            tone: "err",
            text: "Decoded payload is not 32 bytes — not a PQM-1 mnemonic.",
          };
        case "unsupportedVersion":
          return {
            ok: false,
            tone: "warn",
            text: "Unsupported PQM-1 version tag — expected version 0x01.",
          };
        default:
          return { ok: false, tone: "err", text: err.message };
      }
    }
    return { ok: false, tone: "err", text: (err as Error)?.message ?? String(err) };
  }
}
