// Operator signing-key settings — imports PQM-1 mnemonics used by the
// Operations drawer and stores them in the OS keychain via `keychain_set`.
// Operator register/redelegate/chat use `operator:mnemonic`; foundation-only
// recovery and roster lifecycle txs use `foundation:recovery-mnemonic` when
// present.
//
// Mirrors `AiSettings`: a single password-typed credential field, the
// cleartext is dropped from React state the moment it is written to the
// keychain, and the Rust side never holds it — the Operations drawer
// reads it back from the keychain just long enough to construct the
// register tx (see `OpsContext.runRegisterFlow` → `submitRegister`).
//
// The input is validated against the PQM-1 spec before it is stored: a
// 24-word BIP-39 mnemonic whose decoded 32-byte payload carries algo
// tag 0x01 (ML-DSA-65). Validation uses the SDK's canonical decoder
// (`pqm1MnemonicToPayload`) so it matches byte-for-byte what the signing
// path will accept. A MetaMask-style BIP-32 seed phrase decodes to a
// payload whose first byte is not 0x01 → it is rejected with a clear
// warning that it is not a Monolythium operator key.

import { useCallback, useEffect, useState } from "react";
import {
  KEYCHAIN_ACCOUNTS,
  inTauri,
  keychainDelete,
  keychainGet,
  keychainSet,
} from "../sdk";
import {
  PQM1_ALGO_TAG_MLDSA65,
  PQM1_V1_MNEMONIC_WORDS,
  Pqm1Error,
  pqm1MnemonicToPayload,
} from "@monolythium/core-sdk/crypto";

type ValidationResult =
  | { ok: true }
  | { ok: false; tone: "err" | "warn"; text: string };

/**
 * Validate that `raw` is a 24-word PQM-1 mnemonic with algo tag 0x01.
 *
 * Delegates to the SDK decoder so this matches exactly what
 * `pqm1MnemonicToMlDsa65Backend` will accept at signing time. The decoder
 * throws `Pqm1Error` with a typed `kind` we map to actionable copy:
 *   - `unsupportedAlgorithm` → a non-0x01 tag, the MetaMask/BIP-32 case →
 *     a hard WARN that this is not a Monolythium operator key.
 *   - the rest (`badWordCount` / `bip39Decode` / `badPayloadLength` /
 *     `unsupportedVersion`) → a plain error.
 */
function validateOperatorMnemonic(raw: string): ValidationResult {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return { ok: false, tone: "err", text: "Enter the operator mnemonic." };
  }
  try {
    const payload = pqm1MnemonicToPayload(normalized);
    // The decoder already enforces algoTag === 0x01, but assert it
    // explicitly so the contract is visible at this call site.
    if (payload.algoTag !== PQM1_ALGO_TAG_MLDSA65) {
      return {
        ok: false,
        tone: "warn",
        text:
          "This mnemonic is not a Monolythium operator key (algo tag is not 0x01). " +
          "MetaMask / BIP-32 seed phrases are NOT compatible — use a PQM-1 (ML-DSA-65) mnemonic.",
      };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Pqm1Error) {
      switch (err.kind) {
        case "unsupportedAlgorithm":
          return {
            ok: false,
            tone: "warn",
            text:
              "This mnemonic is not a Monolythium operator key (algo tag is not 0x01). " +
              "MetaMask / BIP-32 seed phrases are NOT compatible — use a PQM-1 (ML-DSA-65) mnemonic.",
          };
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

export function OperatorKeySettings() {
  const [mnemonicDraft, setMnemonicDraft] = useState("");
  const [foundationDraft, setFoundationDraft] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [hasFoundationKey, setHasFoundationKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: "ok" | "err" | "info" | "warn";
    text: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [stored, foundationStored] = await Promise.all([
        keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic),
        keychainGet(KEYCHAIN_ACCOUNTS.foundationRecoveryMnemonic),
      ]);
      setHasKey(stored !== null && stored.length > 0);
      setHasFoundationKey(foundationStored !== null && foundationStored.length > 0);
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live validation hint for a non-empty draft. Empty draft = no hint
  // (and the button switches to "Clear key").
  const draftTrimmed = mnemonicDraft.trim();
  const liveCheck: ValidationResult | null = draftTrimmed
    ? validateOperatorMnemonic(draftTrimmed)
    : null;
  const foundationDraftTrimmed = foundationDraft.trim();
  const foundationLiveCheck: ValidationResult | null = foundationDraftTrimmed
    ? validateOperatorMnemonic(foundationDraftTrimmed)
    : null;

  const persistMnemonic = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (!draftTrimmed) {
        await keychainDelete(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        setHasKey(false);
        setMessage({ tone: "info", text: "Operator mnemonic cleared." });
        return;
      }
      const check = validateOperatorMnemonic(draftTrimmed);
      if (!check.ok) {
        // Refuse to store anything that the signing path would reject.
        setMessage({ tone: check.tone, text: check.text });
        return;
      }
      const normalized = draftTrimmed.replace(/\s+/g, " ");
      await keychainSet(KEYCHAIN_ACCOUNTS.operatorMnemonic, normalized);
      setHasKey(true);
      setMessage({
        tone: "ok",
        text: "Operator mnemonic stored in keychain.",
      });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    } finally {
      // Drop the cleartext from React state regardless of outcome — the
      // Operations drawer reads it from the keychain on demand. The
      // mounted input re-renders blank.
      setMnemonicDraft("");
      setBusy(false);
    }
  };

  const persistFoundationMnemonic = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (!foundationDraftTrimmed) {
        await keychainDelete(KEYCHAIN_ACCOUNTS.foundationRecoveryMnemonic);
        setHasFoundationKey(false);
        setMessage({ tone: "info", text: "Foundation operations mnemonic cleared." });
        return;
      }
      const check = validateOperatorMnemonic(foundationDraftTrimmed);
      if (!check.ok) {
        setMessage({ tone: check.tone, text: check.text });
        return;
      }
      const normalized = foundationDraftTrimmed.replace(/\s+/g, " ");
      await keychainSet(KEYCHAIN_ACCOUNTS.foundationRecoveryMnemonic, normalized);
      setHasFoundationKey(true);
      setMessage({
        tone: "ok",
        text: "Foundation operations mnemonic stored in keychain.",
      });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    } finally {
      setFoundationDraft("");
      setBusy(false);
    }
  };

  const tauri = inTauri();

  return (
    <>
    <div className="card card--padded" style={{ maxWidth: 720 }}>
      <div className="card__head">
        <div>
          <h3>Operator signing key</h3>
          <div className="sub">
            PQM-1 (ML-DSA-65) mnemonic that signs the node-registry register
            tx. Stored in the OS keychain; read in-memory by the Operations
            drawer only when registering. The bond is paid from this key's
            native balance.
          </div>
        </div>
        <span
          className={
            !tauri ? "halo halo--warn" : hasKey ? "halo halo--ok" : "halo halo--warn"
          }
        >
          <span className="dot" />
          {!tauri
            ? "browser preview"
            : hasKey
              ? "key stored"
              : "no key"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="cap">Operator mnemonic (24-word PQM-1)</span>
          <input
            type="password"
            value={mnemonicDraft}
            placeholder={
              hasKey
                ? "•••• stored in keychain · type to replace"
                : "word1 word2 … word24"
            }
            onChange={(e) => setMnemonicDraft(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            className="mono"
            style={{
              padding: "10px 12px",
              background: "rgba(255, 255, 255, 0.03)",
              border:
                liveCheck && !liveCheck.ok
                  ? "1px solid var(--err-500, #c53030)"
                  : "1px solid var(--glass-stroke)",
              borderRadius: 8,
              color: "var(--fg-100)",
              fontSize: 13,
              outline: "none",
            }}
          />
        </label>
        {liveCheck && !liveCheck.ok ? (
          <div
            className={`halo halo--${liveCheck.tone === "warn" ? "warn" : "err"}`}
            style={{ alignSelf: "flex-start" }}
          >
            <span className="dot" /> {liveCheck.text}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={persistMnemonic}
            disabled={busy || !tauri || (!!draftTrimmed && !!liveCheck && !liveCheck.ok)}
          >
            {draftTrimmed ? "Save key" : "Clear key"}
          </button>
        </div>
      </div>

      {!tauri ? (
        <div className="halo halo--warn" style={{ marginTop: 14, alignSelf: "flex-start" }}>
          <span className="dot" /> running in browser preview — keychain writes are no-ops
        </div>
      ) : null}

      {message ? (
        <div
          className={`halo halo--${
            message.tone === "ok"
              ? "ok"
              : message.tone === "err"
                ? "err"
                : message.tone === "warn"
                  ? "warn"
                  : "info"
          }`}
          style={{ marginTop: 14, alignSelf: "flex-start" }}
        >
          <span className="dot" /> {message.text}
        </div>
      ) : null}
    </div>
    <div className="card card--padded" style={{ maxWidth: 720 }}>
      <div className="card__head">
        <div>
          <h3>Foundation operations signer</h3>
          <div className="sub">
            PQM-1 mnemonic for foundation-authorized recoverOperatorNode and
            submitPendingChange transactions. Leave absent on ordinary operator
            installs; recovery and roster lifecycle actions then fail closed.
          </div>
        </div>
        <span
          className={
            !tauri
              ? "halo halo--warn"
              : hasFoundationKey
                ? "halo halo--ok"
                : "halo halo--warn"
          }
        >
          <span className="dot" />
          {!tauri
            ? "browser preview"
            : hasFoundationKey
              ? "key stored"
              : "no key"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="cap">Foundation mnemonic (24-word PQM-1)</span>
          <input
            type="password"
            value={foundationDraft}
            placeholder={
              hasFoundationKey
                ? "•••• stored in keychain · type to replace"
                : "word1 word2 … word24"
            }
            onChange={(e) => setFoundationDraft(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            className="mono"
            style={{
              padding: "10px 12px",
              background: "rgba(255, 255, 255, 0.03)",
              border:
                foundationLiveCheck && !foundationLiveCheck.ok
                  ? "1px solid var(--err-500, #c53030)"
                  : "1px solid var(--glass-stroke)",
              borderRadius: 8,
              color: "var(--fg-100)",
              fontSize: 13,
              outline: "none",
            }}
          />
        </label>
        {foundationLiveCheck && !foundationLiveCheck.ok ? (
          <div
            className={`halo halo--${
              foundationLiveCheck.tone === "warn" ? "warn" : "err"
            }`}
            style={{ alignSelf: "flex-start" }}
          >
            <span className="dot" /> {foundationLiveCheck.text}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={persistFoundationMnemonic}
            disabled={
              busy ||
              !tauri ||
              (!!foundationDraftTrimmed &&
                !!foundationLiveCheck &&
                !foundationLiveCheck.ok)
            }
          >
            {foundationDraftTrimmed ? "Save key" : "Clear key"}
          </button>
        </div>
      </div>

      {!tauri ? (
        <div className="halo halo--warn" style={{ marginTop: 14, alignSelf: "flex-start" }}>
          <span className="dot" /> running in browser preview — keychain writes are no-ops
        </div>
      ) : null}
    </div>
    </>
  );
}
