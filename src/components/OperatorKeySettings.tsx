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
  const [mnemonicDraft, setMnemonicDraft] = useState("");
  const [foundationDraft, setFoundationDraft] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [hasFoundationKey, setHasFoundationKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState<GenerationState | null>(null);
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
          {!generation ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={startGeneration}
              disabled={busy || !tauri}
              title={
                hasKey
                  ? "Generates a brand-new key; storing it REPLACES the current one"
                  : "Create a brand-new 24-word PQM-1 operator key"
              }
            >
              Generate new key
            </button>
          ) : null}
        </div>
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
                  disabled={busy || generation.confirmIndices.some((index) => !(generation.confirmInputs[index] ?? "").trim())}
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
