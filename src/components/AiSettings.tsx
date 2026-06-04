// Advisory bridge settings: provider toggle, hosted API key (kept in the
// OS keychain via `keychain_set`), and hosted/local endpoint settings.
//
// Mirrors `SshSettings` so the Operations view shows two side-by-side
// configuration cards. The Hosted provider key is the only credential we
// touch here; the Rust side reads it just before issuing the HTTPS
// request, so the cleartext key never persists in the React process
// past the input handler.

import { useCallback, useEffect, useState } from "react";
import {
  KEYCHAIN_ACCOUNTS,
  getAiConfig,
  inTauri,
  keychainDelete,
  keychainGet,
  keychainSet,
  setAiConfig,
  type AiConfig,
  type AiProvider,
} from "../sdk";

const DEFAULT_CONFIG: AiConfig = {
  provider: "local",
  hosted_url: "",
  hosted_model: "",
  local_url: "http://localhost:11434",
  local_model: "qwen2.5:3b",
};

export function AiSettings() {
  const [cfg, setCfg] = useState<AiConfig>(DEFAULT_CONFIG);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: "ok" | "err" | "info";
    text: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getAiConfig();
      setCfg(next);
      const stored = await keychainGet(KEYCHAIN_ACCOUNTS.hostedProviderApiKey);
      setHasKey(stored !== null && stored.length > 0);
    } catch (err) {
      setMessage({
        tone: "err",
        text: (err as Error)?.message ?? String(err),
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const persistConfig = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await setAiConfig(cfg);
      setMessage({ tone: "ok", text: "Advisory bridge config saved." });
    } catch (err) {
      setMessage({
        tone: "err",
        text: (err as Error)?.message ?? String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const persistApiKey = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const trimmed = apiKeyDraft.trim();
      if (!trimmed) {
        await keychainDelete(KEYCHAIN_ACCOUNTS.hostedProviderApiKey);
        setHasKey(false);
        setMessage({ tone: "info", text: "Hosted provider API key cleared." });
      } else {
        await keychainSet(KEYCHAIN_ACCOUNTS.hostedProviderApiKey, trimmed);
        setHasKey(true);
        setMessage({ tone: "ok", text: "Hosted provider API key stored in keychain." });
      }
      // Drop the cleartext from React state immediately — the Rust
      // side reads it from the keychain on demand. The mounted input
      // re-renders blank.
      setApiKeyDraft("");
    } catch (err) {
      setMessage({
        tone: "err",
        text: (err as Error)?.message ?? String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const tauri = inTauri();

  return (
    <div className="card card--padded" style={{ maxWidth: 720 }}>
      <div className="card__head">
        <div>
          <h3>advisory bridge</h3>
          <div className="sub">
            Ask Monarch uses either a configured hosted endpoint or a local chat endpoint.
            Every proposed action routes through the Operations drawer.
          </div>
        </div>
        <span
          className={
            !tauri
              ? "halo halo--warn"
              : cfg.provider === "hosted" && !hasKey
                ? "halo halo--warn"
                : "halo halo--ok"
          }
        >
          <span className="dot" />
          {!tauri
            ? "browser preview"
            : cfg.provider === "hosted"
              ? hasKey
                ? "hosted · key stored"
                : "hosted · no key"
              : `local · ${cfg.local_model}`}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
        <div>
          <div className="cap" style={{ marginBottom: 6 }}>
            Provider
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {(["hosted", "local"] as AiProvider[]).map((p) => (
              <button
                key={p}
                type="button"
                className={`btn btn--sm ${cfg.provider === p ? "btn--primary" : "btn--ghost"}`}
                onClick={() => setCfg((s) => ({ ...s, provider: p }))}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {cfg.provider === "hosted" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Field
              label="Hosted endpoint"
              placeholder="Configured endpoint URL"
              value={cfg.hosted_url}
              onChange={(v) => setCfg((s) => ({ ...s, hosted_url: v }))}
              mono
            />
            <Field
              label="Hosted model"
              placeholder="Configured model"
              value={cfg.hosted_model}
              onChange={(v) => setCfg((s) => ({ ...s, hosted_model: v }))}
              mono
            />
            <Field
              label="Hosted provider API key"
              placeholder={
                hasKey
                  ? "•••• stored in keychain · type to replace"
                  : "provider API key"
              }
              value={apiKeyDraft}
              onChange={setApiKeyDraft}
              mono
              type="password"
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn btn--sm"
                onClick={persistApiKey}
                disabled={busy || !tauri}
              >
                {apiKeyDraft.trim() ? "Save key" : "Clear key"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Field
              label="Local base URL"
              placeholder="http://localhost:11434"
              value={cfg.local_url}
              onChange={(v) => setCfg((s) => ({ ...s, local_url: v }))}
              mono
            />
            <Field
              label="Local model"
              placeholder="qwen2.5:3b"
              value={cfg.local_model}
              onChange={(v) => setCfg((s) => ({ ...s, local_model: v }))}
              mono
            />
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={persistConfig}
          disabled={busy || !tauri}
        >
          Save bridge config
        </button>
      </div>

      {!tauri ? (
        <div className="halo halo--warn" style={{ marginTop: 14, alignSelf: "flex-start" }}>
          <span className="dot" /> running in browser preview — bridge calls are no-ops
        </div>
      ) : null}

      {message ? (
        <div
          className={`halo halo--${message.tone === "ok" ? "ok" : message.tone === "err" ? "err" : "info"}`}
          style={{ marginTop: 14, alignSelf: "flex-start" }}
        >
          <span className="dot" /> {message.text}
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: "text" | "password";
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="cap">{label}</span>
      <input
        type={type ?? "text"}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        className={mono ? "mono" : undefined}
        style={{
          padding: "10px 12px",
          background: "rgba(255, 255, 255, 0.03)",
          border: "1px solid var(--glass-stroke)",
          borderRadius: 8,
          color: "var(--fg-100)",
          fontSize: 13,
          outline: "none",
        }}
      />
    </label>
  );
}
