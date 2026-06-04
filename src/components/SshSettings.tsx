// Settings pane — SSH host / user / private-key-path. Values are
// persisted to the OS keychain via `keychain_set` / `keychain_get`
// (see `src-tauri/src/keychain.rs`). When the operator clicks
// "Connect", we call `ssh_connect` against the russh bridge; the
// active session is then held in Tauri-managed state so every
// subsequent `sshExec` call reuses the same channel.
//
// Outside Tauri (`pnpm dev`), all calls become no-ops and the form
// shows a small advisory — the design preview keeps rendering.

import { useCallback, useEffect, useState } from "react";
import {
  KEYCHAIN_ACCOUNTS,
  inTauri,
  keychainDelete,
  keychainGet,
  keychainSet,
  sshConnect,
  sshDisconnect,
  sshStatus,
  type SshStatus,
} from "../sdk";

type FormState = {
  host: string;
  user: string;
  keyPath: string;
};

const EMPTY: FormState = { host: "", user: "", keyPath: "" };

export function SshSettings() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [status, setStatus] = useState<SshStatus>({
    connected: false,
    host: null,
    user: null,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: "ok" | "err" | "info";
    text: string;
  } | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await sshStatus());
    } catch (err) {
      setStatus({ connected: false, host: null, user: null });
      setMessage({
        tone: "err",
        text: (err as Error)?.message ?? String(err),
      });
    }
  }, []);

  // Hydrate the form from the keychain once on mount.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [host, user, keyPath] = await Promise.all([
          keychainGet(KEYCHAIN_ACCOUNTS.sshHost),
          keychainGet(KEYCHAIN_ACCOUNTS.sshUser),
          keychainGet(KEYCHAIN_ACCOUNTS.sshKeyPath),
        ]);
        if (cancelled) return;
        setForm({
          host: host ?? "",
          user: user ?? "",
          keyPath: keyPath ?? "",
        });
      } catch (err) {
        if (cancelled) return;
        setMessage({
          tone: "err",
          text: (err as Error)?.message ?? String(err),
        });
      }
      await refreshStatus();
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshStatus]);

  const persist = async () => {
    setBusy(true);
    setMessage(null);
    try {
      // Empty inputs delete the entry rather than store an empty string.
      await Promise.all([
        form.host
          ? keychainSet(KEYCHAIN_ACCOUNTS.sshHost, form.host)
          : keychainDelete(KEYCHAIN_ACCOUNTS.sshHost),
        form.user
          ? keychainSet(KEYCHAIN_ACCOUNTS.sshUser, form.user)
          : keychainDelete(KEYCHAIN_ACCOUNTS.sshUser),
        form.keyPath
          ? keychainSet(KEYCHAIN_ACCOUNTS.sshKeyPath, form.keyPath)
          : keychainDelete(KEYCHAIN_ACCOUNTS.sshKeyPath),
      ]);
      setMessage({ tone: "ok", text: "Saved to keychain." });
    } catch (err) {
      setMessage({
        tone: "err",
        text: (err as Error)?.message ?? String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await sshConnect({
        host: form.host,
        user: form.user,
        keyPath: form.keyPath,
      });
      await refreshStatus();
      setMessage({ tone: "ok", text: `Connected to ${form.user}@${form.host}.` });
    } catch (err) {
      setMessage({
        tone: "err",
        text: (err as Error)?.message ?? String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await sshDisconnect();
      await refreshStatus();
      setMessage({ tone: "info", text: "Disconnected." });
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
  const ready = form.host.length > 0 && form.user.length > 0 && form.keyPath.length > 0;

  return (
    <div className="card card--padded" style={{ maxWidth: 720 }}>
      <div className="card__head">
        <div>
          <h3>SSH bridge</h3>
          <div className="sub">
            russh client + OS keychain · operations on this host route through
            the configured session
          </div>
        </div>
        <span
          className={
            status.connected ? "halo halo--ok" : tauri ? "halo" : "halo halo--warn"
          }
        >
          <span className="dot" />
          {status.connected
            ? `${status.user}@${status.host}`
            : tauri
              ? "not connected"
              : "browser preview"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
        <Field
          label="SSH host"
          placeholder="monarch-eu-west-1.example.com"
          value={form.host}
          onChange={(v) => setForm((s) => ({ ...s, host: v }))}
          mono
        />
        <Field
          label="SSH user"
          placeholder="monarch"
          value={form.user}
          onChange={(v) => setForm((s) => ({ ...s, user: v }))}
          mono
        />
        <Field
          label="Private key path"
          placeholder="/Users/me/.ssh/id_ed25519"
          value={form.keyPath}
          onChange={(v) => setForm((s) => ({ ...s, keyPath: v }))}
          mono
        />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn--sm"
          onClick={persist}
          disabled={busy || !tauri}
        >
          Save to keychain
        </button>
        {status.connected ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={disconnect}
            disabled={busy}
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={connect}
            disabled={busy || !tauri || !ready}
          >
            Connect
          </button>
        )}
      </div>

      {!tauri ? (
        <div className="halo halo--warn" style={{ marginTop: 14, alignSelf: "flex-start" }}>
          <span className="dot" /> running in browser preview — keychain + russh disabled
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="cap">{label}</span>
      <input
        type="text"
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
