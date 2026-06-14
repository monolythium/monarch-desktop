// Operator signing-key settings — imports PQM-1 mnemonics used by the
// Operations drawer and stores them in the OS keychain via `keychain_set`.
// Operator register/redelegate/chat use `operator:mnemonic`.
//
// After successful storage, cleartext words are dropped from React state. The
// Operations drawer reads the key back only long enough to build the signed
// operator transaction.
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
import { generatePqm1Mnemonic } from "@monolythium/core-sdk/crypto";
import {
  validateOperatorMnemonic,
  type MnemonicValidation as ValidationResult,
} from "../sdk/operatorMnemonic";

type GenerationState = {
  stage: "reveal" | "confirm";
  /** Cleartext words — held ONLY while the generation flow is open and
   *  dropped (state reset) the instant the key is stored or cancelled.
   *  Never logged, never persisted anywhere except the OS keychain. */
  words: string[];
  /** Zero-based indices of the 3 words the operator must re-enter. */
  confirmIndices: number[];
  confirmInputs: Record<number, string>;
};

const MNEMONIC_WORD_COUNT = 24;

function emptyMnemonicWords(): string[] {
  return Array.from({ length: MNEMONIC_WORD_COUNT }, () => "");
}

function pickConfirmIndices(total: number, count = 3): number[] {
  const picked = new Set<number>();
  while (picked.size < count) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    picked.add((random[0] ?? 0) % total);
  }
  return [...picked].sort((a, b) => a - b);
}

export function OperatorKeySettings() {
  const [importOpen, setImportOpen] = useState(false);
  const [importWords, setImportWords] = useState<string[]>(emptyMnemonicWords);
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState<GenerationState | null>(null);
  const [message, setMessage] = useState<{
    tone: "ok" | "err" | "info" | "warn";
    text: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const stored = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
      setHasKey(stored !== null && stored.length > 0);
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const importStarted = importWords.some((word) => word.trim().length > 0);
  const importComplete = importWords.every((word) => word.trim().length > 0);
  const importMnemonic = importWords.map((word) => word.trim()).filter(Boolean).join(" ");
  const liveCheck: ValidationResult | null = importStarted
    ? validateOperatorMnemonic(importMnemonic)
    : null;

  const updateImportWord = (index: number, value: string) => {
    const pastedWords = value.trim().split(/\s+/u).filter(Boolean);
    setImportWords((prev) => {
      const next = [...prev];
      if (pastedWords.length > 1) {
        pastedWords.slice(0, MNEMONIC_WORD_COUNT - index).forEach((word, offset) => {
          next[index + offset] = word;
        });
      } else {
        next[index] = value.trim();
      }
      return next;
    });
  };

  const clearMnemonic = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await keychainDelete(KEYCHAIN_ACCOUNTS.operatorMnemonic);
      setHasKey(false);
      setMessage({ tone: "info", text: "Operator mnemonic cleared." });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  const persistImportedMnemonic = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (!importComplete) {
        setMessage({
          tone: "warn",
          text: "Enter all 24 words before saving the operator key.",
        });
        return;
      }
      const check = validateOperatorMnemonic(importMnemonic);
      if (!check.ok) {
        // Refuse to store anything that the signing path would reject.
        setMessage({ tone: check.tone, text: check.text });
        return;
      }
      const normalized = importMnemonic.replace(/\s+/g, " ");
      await keychainSet(KEYCHAIN_ACCOUNTS.operatorMnemonic, normalized);
      setHasKey(true);
      setMessage({
        tone: "ok",
        text: "Operator mnemonic stored in keychain.",
      });
      setImportWords(emptyMnemonicWords());
      setImportOpen(false);
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  const startGeneration = () => {
    setMessage(null);
    try {
      const mnemonic = generatePqm1Mnemonic();
      const words = mnemonic.trim().split(/\s+/u);
      setGeneration({
        stage: "reveal",
        words,
        confirmIndices: pickConfirmIndices(words.length),
        confirmInputs: {},
      });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    }
  };

  const cancelGeneration = () => {
    // Drop the cleartext words immediately.
    setGeneration(null);
    setMessage({ tone: "info", text: "Key generation cancelled — nothing was stored." });
  };

  const confirmGeneration = async () => {
    if (!generation) return;
    const mismatch = generation.confirmIndices.some(
      (index) =>
        (generation.confirmInputs[index] ?? "").trim().toLowerCase() !==
        (generation.words[index] ?? "").toLowerCase(),
    );
    if (mismatch) {
      setMessage({
        tone: "err",
        text: "One or more words do not match — check your written copy and try again.",
      });
      return;
    }
    setBusy(true);
    try {
      await keychainSet(KEYCHAIN_ACCOUNTS.operatorMnemonic, generation.words.join(" "));
      setHasKey(true);
      setMessage({
        tone: "ok",
        text: "New operator key generated and stored in the OS keychain. Keep the written copy safe — it is the ONLY backup.",
      });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    } finally {
      // Drop the cleartext from React state regardless of outcome.
      setGeneration(null);
      setBusy(false);
    }
  };

  const tauri = inTauri();

  return (
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
            ? "Desktop app required"
            : hasKey
              ? "key stored"
              : "no key"}
        </span>
      </div>

      <div className="operator-key-panel">
        <div className="operator-key-status">
          <div>
            <div className="cap">operator key</div>
            <strong>{hasKey ? "Stored in OS keychain" : "No key stored"}</strong>
          </div>
          <span>{hasKey ? "Used when you register or sign operator actions." : "Import an existing key or create a new one."}</span>
        </div>

        <div className="operator-key-actions">
          <button
            type="button"
            className={!hasKey ? "btn btn--primary btn--sm" : "btn btn--sm"}
            onClick={() => {
              setImportOpen((open) => !open);
              setMessage(null);
            }}
            disabled={busy || !!generation}
          >
            {importOpen ? "Hide import" : "Import existing key"}
          </button>
          {!generation ? (
            <button
              type="button"
              className={hasKey ? "btn btn--sm" : "btn btn--primary btn--sm"}
              onClick={startGeneration}
              disabled={busy}
              title={
                hasKey
                  ? "Generates a brand-new key; storing it REPLACES the current one"
                  : "Create a brand-new 24-word PQM-1 operator key"
              }
            >
              Generate new key
            </button>
          ) : null}
          {hasKey ? (
            <button
              type="button"
              className="btn btn--danger btn--sm"
              onClick={() => void clearMnemonic()}
              disabled={busy || !tauri}
            >
              Clear stored key
            </button>
          ) : null}
        </div>

        {importOpen ? (
          <div className="settings-mnemonic-panel">
            <div className="settings-mnemonic-panel__head">
              <div>
                <div className="cap">Import 24-word PQM-1 mnemonic</div>
                <p>
                  Paste the full mnemonic into any box or enter each word in order.
                </p>
              </div>
              <span className="settings-mnemonic-count">
                {importWords.filter((word) => word.trim()).length}/{MNEMONIC_WORD_COUNT}
              </span>
            </div>
            <div className="settings-mnemonic-grid">
              {importWords.map((word, index) => (
                <label className="settings-word-field" key={index}>
                  <span>{index + 1}</span>
                  <input
                    type="text"
                    value={word}
                    onChange={(event) => updateImportWord(index, event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    className="mono"
                    aria-label={`Mnemonic word ${index + 1}`}
                  />
                </label>
              ))}
            </div>
            {liveCheck && !liveCheck.ok ? (
              <div
                className={`halo halo--${liveCheck.tone === "warn" ? "warn" : "err"}`}
                style={{ alignSelf: "flex-start" }}
              >
                <span className="dot" /> {liveCheck.text}
              </div>
            ) : null}
            <div className="operator-key-actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void persistImportedMnemonic()}
                disabled={busy || !tauri || !importComplete || (!!liveCheck && !liveCheck.ok)}
              >
                Save imported key
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setImportWords(emptyMnemonicWords());
                  setImportOpen(false);
                }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {generation ? (
        <div
          style={{
            marginTop: 14,
            border: "1px solid var(--gold)",
            borderRadius: 10,
            padding: 14,
            background: "rgba(242,180,65,0.05)",
          }}
        >
          {generation.stage === "reveal" ? (
            <>
              <div className="cap" style={{ marginBottom: 8 }}>
                your new operator key — shown ONCE
              </div>
              <p style={{ fontSize: 12, color: "var(--fg-300)", lineHeight: 1.5, margin: "0 0 10px" }}>
                Write these 24 words down on paper, in order. They ARE your operator: anyone
                with them controls your node, bond, and funds. Never store them in a file,
                screenshot, or password manager{hasKey ? ". Storing this key REPLACES the one currently in the keychain" : ""}.
              </p>
              <ol
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))",
                  gap: 6,
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                }}
              >
                {generation.words.map((word, index) => (
                  <li
                    key={`${index}-${word}`}
                    className="mono"
                    style={{
                      fontSize: 12,
                      padding: "5px 8px",
                      borderRadius: 6,
                      background: "rgba(0,0,0,0.3)",
                      border: "1px solid var(--glass-stroke)",
                      color: "var(--fg-100)",
                    }}
                  >
                    <span style={{ color: "var(--fg-500)", marginRight: 6 }}>{index + 1}.</span>
                    {word}
                  </li>
                ))}
              </ol>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button type="button" className="btn btn--primary btn--sm" onClick={() => setGeneration({ ...generation, stage: "confirm", confirmInputs: {} })}>
                  I wrote it down — continue
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={cancelGeneration}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="cap" style={{ marginBottom: 8 }}>
                confirm your written copy
              </div>
              <p style={{ fontSize: 12, color: "var(--fg-300)", lineHeight: 1.5, margin: "0 0 10px" }}>
                Type the requested words from your written copy. The key is stored in the OS
                keychain only after they match.
              </p>
              <div style={{ display: "grid", gap: 8 }}>
                {generation.confirmIndices.map((index) => (
                  <label key={index} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className="cap" style={{ width: 84, flex: "0 0 auto" }}>
                      word #{index + 1}
                    </span>
                    <input
                      type="text"
                      value={generation.confirmInputs[index] ?? ""}
                      onChange={(e) =>
                        setGeneration({
                          ...generation,
                          confirmInputs: { ...generation.confirmInputs, [index]: e.target.value },
                        })
                      }
                      spellCheck={false}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      className="mono"
                      style={{
                        flex: 1,
                        padding: "8px 10px",
                        background: "rgba(0,0,0,0.3)",
                        border: "1px solid var(--glass-stroke)",
                        borderRadius: 6,
                        color: "var(--fg-100)",
                        fontSize: 13,
                      }}
                    />
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => void confirmGeneration()}
                  disabled={busy || !tauri || generation.confirmIndices.some((index) => !(generation.confirmInputs[index] ?? "").trim())}
                >
                  {hasKey ? "Confirm & replace stored key" : "Confirm & store key"}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setGeneration({ ...generation, stage: "reveal" })}>
                  Show words again
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={cancelGeneration}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {!tauri ? (
        <div className="halo halo--warn" style={{ marginTop: 14, alignSelf: "flex-start" }}>
          <span className="dot" /> Open Monarch Desktop to save keys in the OS keychain.
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
  );
}
