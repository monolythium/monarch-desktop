// Step 2 — Operator key.
//
// Create a brand-new 24-word PQM-1 (ML-DSA-65) operator mnemonic via the REAL
// keygen path (`generatePqm1Mnemonic`), or import an existing one. Either way
// the cleartext is stored in the OS keychain (`keychain_set` -> Rust keyring)
// under `operator:mnemonic` — the same account the Operations drawer reads at
// register/sign time. The derived bech32m operator account address comes from
// the SDK (`pqm1MnemonicToAddress`). The mnemonic is shown ONCE behind a
// "written it down" confirm, then dropped from React state.
//
// Outside Tauri (the `pnpm dev` browser preview) keychain writes are no-ops;
// the step says so plainly rather than faking a stored key.

import { useEffect, useState } from "react";
import { generatePqm1Mnemonic, pqm1MnemonicToAddress } from "@monolythium/core-sdk/crypto";
import { KEYCHAIN_ACCOUNTS, inTauri, keychainSet } from "../../sdk";
import { validateOperatorMnemonic } from "../../sdk/operatorMnemonic";
import { CopyButton } from "./CopyButton";
import { StepShell } from "./StepShell";

type Mode = "choose" | "create-reveal" | "create-confirm" | "import";

export function KeyStep({
  n,
  onKeyReady,
  storedAddress,
}: {
  n: number;
  /** Fired with the derived bech32m address once a key is stored. */
  onKeyReady: (address: string) => void;
  /** Address already detected for a pre-existing keychain key, if any. */
  storedAddress: string | null;
}) {
  const tauri = inTauri();
  const [mode, setMode] = useState<Mode>("choose");
  const [words, setWords] = useState<string[] | null>(null);
  const [confirmIdx] = useState(() => pickConfirmIndices(24));
  const [confirmInputs, setConfirmInputs] = useState<Record<number, string>>({});
  const [importDraft, setImportDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err" | "warn" | "info"; text: string } | null>(null);
  const [address, setAddress] = useState<string | null>(storedAddress);

  useEffect(() => {
    if (storedAddress) setAddress(storedAddress);
  }, [storedAddress]);

  const startCreate = () => {
    setMessage(null);
    try {
      const mnemonic = generatePqm1Mnemonic();
      setWords(mnemonic.trim().split(/\s+/u));
      setMode("create-reveal");
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    }
  };

  const storeNew = async () => {
    if (!words) return;
    const mismatch = confirmIdx.some(
      (i) => (confirmInputs[i] ?? "").trim().toLowerCase() !== (words[i] ?? "").toLowerCase(),
    );
    if (mismatch) {
      setMessage({ tone: "err", text: "One or more words don't match — check your written copy." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const mnemonic = words.join(" ");
      const derived = pqm1MnemonicToAddress(mnemonic);
      await keychainSet(KEYCHAIN_ACCOUNTS.operatorMnemonic, mnemonic);
      setAddress(derived);
      onKeyReady(derived);
      setMessage({
        tone: "ok",
        text: "Operator key stored in the OS keychain. Your written copy is the ONLY backup.",
      });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    } finally {
      // Drop the cleartext words from state regardless of outcome.
      setWords(null);
      setConfirmInputs({});
      setBusy(false);
      setMode("choose");
    }
  };

  const storeImport = async () => {
    const check = validateOperatorMnemonic(importDraft);
    if (!check.ok) {
      setMessage({ tone: check.tone, text: check.text });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const normalized = importDraft.trim().replace(/\s+/g, " ");
      const derived = pqm1MnemonicToAddress(normalized);
      await keychainSet(KEYCHAIN_ACCOUNTS.operatorMnemonic, normalized);
      setAddress(derived);
      onKeyReady(derived);
      setMessage({ tone: "ok", text: "Operator key imported and stored in the OS keychain." });
      setMode("choose");
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    } finally {
      setImportDraft("");
      setBusy(false);
    }
  };

  const liveCheck = importDraft.trim() ? validateOperatorMnemonic(importDraft) : null;

  return (
    <StepShell
      n={n}
      title="Your operator key"
      sub="A 24-word PQM-1 (ML-DSA-65) mnemonic is your operator identity — it signs registration, posts your bond, and controls your funds. It is stored in your OS keychain."
    >
      {!tauri ? (
        <div className="halo halo--warn" style={{ alignSelf: "flex-start", marginBottom: 12 }}>
          <span className="dot" /> running in browser preview — keychain writes are no-ops here; key
          creation works in the desktop app.
        </div>
      ) : null}

      {address ? (
        <div style={{ marginBottom: 14 }}>
          <div className="cap" style={{ marginBottom: 6 }}>operator account address</div>
          <div className="setup__addr">
            {address}
            <CopyButton value={address} label="Copy operator address" />
          </div>
        </div>
      ) : null}

      {mode === "choose" ? (
        <div className="setup__toggle">
          <button
            type="button"
            className="setup__toggle-opt"
            onClick={startCreate}
            disabled={busy}
          >
            <b>{address ? "Create a new key" : "Create a new key"}</b>
            <span>Generate a fresh 24-word mnemonic. Shown once — write it down on paper.</span>
          </button>
          <button
            type="button"
            className="setup__toggle-opt"
            onClick={() => {
              setMode("import");
              setMessage(null);
            }}
            disabled={busy}
          >
            <b>Import an existing key</b>
            <span>Paste a 24-word PQM-1 mnemonic you already control.</span>
          </button>
        </div>
      ) : null}

      {mode === "create-reveal" && words ? (
        <div
          style={{
            border: "1px solid var(--gold)",
            borderRadius: 12,
            padding: 16,
            background: "rgba(242,180,65,0.05)",
          }}
        >
          <div className="cap" style={{ marginBottom: 8 }}>your new operator key — shown once</div>
          <p style={{ fontSize: 12, color: "var(--fg-300)", lineHeight: 1.5, margin: "0 0 12px" }}>
            Write these 24 words on paper, in order. Anyone with them controls your node, bond, and
            funds. Never store them in a file, screenshot, or password manager.
          </p>
          <ol className="setup__words">
            {words.map((word, i) => (
              <li key={`${i}-${word}`} className="setup__word">
                <i>{i + 1}.</i>
                {word}
              </li>
            ))}
          </ol>
          <div className="setup__foot" style={{ marginTop: 16 }}>
            <button type="button" className="btn btn--primary" onClick={() => setMode("create-confirm")}>
              I wrote it down — continue
            </button>
            <CopyButton value={words.join(" ")} label="Copy mnemonic" />
            <span className="setup__foot-spacer" />
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setWords(null);
                setMode("choose");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {mode === "create-confirm" && words ? (
        <div
          style={{
            border: "1px solid var(--gold)",
            borderRadius: 12,
            padding: 16,
            background: "rgba(242,180,65,0.05)",
          }}
        >
          <div className="cap" style={{ marginBottom: 8 }}>confirm your written copy</div>
          <p style={{ fontSize: 12, color: "var(--fg-300)", lineHeight: 1.5, margin: "0 0 12px" }}>
            Type the requested words from your written copy. The key is stored only after they match.
          </p>
          <div style={{ display: "grid", gap: 8 }}>
            {confirmIdx.map((i) => (
              <label key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="cap" style={{ width: 84, flex: "0 0 auto" }}>word #{i + 1}</span>
                <input
                  type="text"
                  className="setup__input"
                  style={{ flex: 1, fontSize: 13, padding: "8px 10px" }}
                  value={confirmInputs[i] ?? ""}
                  onChange={(e) => setConfirmInputs({ ...confirmInputs, [i]: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                />
              </label>
            ))}
          </div>
          <div className="setup__foot" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void storeNew()}
              disabled={busy || confirmIdx.some((i) => !(confirmInputs[i] ?? "").trim())}
            >
              Confirm &amp; store key
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setMode("create-reveal")}>
              Show words again
            </button>
          </div>
        </div>
      ) : null}

      {mode === "import" ? (
        <div className="setup__field">
          <label className="cap" htmlFor="setup-import">operator mnemonic (24-word PQM-1)</label>
          <textarea
            id="setup-import"
            className={`setup__input${liveCheck && !liveCheck.ok ? " setup__input--err" : ""}`}
            style={{ minHeight: 70, resize: "vertical" }}
            placeholder="word1 word2 … word24"
            value={importDraft}
            onChange={(e) => setImportDraft(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
          {liveCheck && !liveCheck.ok ? (
            <span className={`halo halo--${liveCheck.tone}`} style={{ alignSelf: "flex-start" }}>
              <span className="dot" /> {liveCheck.text}
            </span>
          ) : null}
          <div className="setup__foot" style={{ marginTop: 4 }}>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void storeImport()}
              disabled={busy || !tauri || !importDraft.trim() || (!!liveCheck && !liveCheck.ok)}
            >
              Import &amp; store key
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setMode("choose")}>
              Back
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <div className={`halo halo--${message.tone}`} style={{ marginTop: 14, alignSelf: "flex-start" }}>
          <span className="dot" /> {message.text}
        </div>
      ) : null}
    </StepShell>
  );
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
