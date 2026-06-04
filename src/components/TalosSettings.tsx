// Monarch OS control-plane settings.
//
// Production Monarch OS nodes are Talos-based and do not expose SSH.
// This panel wires the GUI to the Talos API mTLS path by storing the
// node endpoint + talosconfig path, then asking the Rust bridge to
// probe the node through the native Talos API client.

import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  EMPTY_TALOS_STATUS,
  KEYCHAIN_ACCOUNTS,
  getStoredChatBootstrapPeers,
  getStoredRpcEndpoint,
  inTauri,
  keychainDelete,
  keychainGet,
  keychainSet,
  parseChatBootstrapPeers,
  releaseAttestationStatus,
  rpcEndpoint,
  setStoredChatBootstrapPeers,
  setStoredRpcEndpoint,
  talosConfigInfo,
  talosConnect,
  talosProtocoreReadiness,
  talosService,
  talosStatus,
  talosTrustConfig,
  useRuntimeProvenance,
  validateReleaseDigest,
  type ProtocoreReadiness,
  type TalosConfigInfo,
  type TalosServiceInfo,
  type TalosStatus,
} from "../sdk";

type FormState = {
  endpoint: string;
  configPath: string;
  releaseDigest: string;
  rpcEndpoint: string;
  chatBootstrapPeers: string;
};

const CERT_ROTATION_REQUIRED_DAYS = 14;
const CERT_ROTATION_WARNING_DAYS = 30;

const EMPTY_FORM: FormState = {
  endpoint: "",
  configPath: "",
  releaseDigest: "",
  rpcEndpoint: "",
  chatBootstrapPeers: "",
};

function statusText(status: TalosStatus): string {
  if (status.reachable) return `connected · ${status.nodeAddress ?? status.endpoint}`;
  if (status.configured) return "configured · unreachable";
  return "not configured";
}

function serviceHalo(info: TalosServiceInfo | null): string {
  switch (info?.severity) {
    case "ok":
      return "halo halo--ok";
    case "warn":
      return "halo halo--warn";
    case "err":
      return "halo halo--err";
    default:
      return "halo halo--info";
  }
}

function readinessHalo(info: ProtocoreReadiness): string {
  switch (info.severity) {
    case "ok":
      return "halo halo--ok";
    case "warn":
      return "halo halo--warn";
    case "err":
      return "halo halo--err";
    default:
      return "halo halo--info";
  }
}

function shortFingerprint(value: string): string {
  const parts = value.split(":");
  if (parts.length <= 8) return value;
  return `${parts.slice(0, 4).join(":")}…${parts.slice(-4).join(":")}`;
}

function caPinHalo(info: TalosConfigInfo): string {
  switch (info.caPinStatus) {
    case "matched":
      return "halo halo--ok";
    case "mismatch":
      return "halo halo--err";
    default:
      return "halo halo--warn";
  }
}

function certHalo(cert: { expired: boolean; notYetValid: boolean; expiresInDays: number }): string {
  if (
    cert.expired ||
    cert.notYetValid ||
    cert.expiresInDays < CERT_ROTATION_REQUIRED_DAYS
  ) {
    return "halo halo--err";
  }
  if (cert.expiresInDays < CERT_ROTATION_WARNING_DAYS) {
    return "halo halo--warn";
  }
  return "halo halo--ok";
}

function certStatusText(cert: { expired: boolean; notYetValid: boolean; expiresInDays: number }): string {
  if (cert.expired) return "expired";
  if (cert.notYetValid) return "not yet valid";
  if (cert.expiresInDays < CERT_ROTATION_REQUIRED_DAYS) return "rotate now";
  if (cert.expiresInDays < CERT_ROTATION_WARNING_DAYS) return "rotate soon";
  return "valid";
}

function certExpiryText(cert: { notAfter: string; expiresInDays: number }): string {
  return Number.isFinite(cert.expiresInDays)
    ? `${cert.notAfter} · ${cert.expiresInDays}d remaining`
    : cert.notAfter;
}

export function TalosSettings() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [status, setStatus] = useState<TalosStatus>(EMPTY_TALOS_STATUS);
  const [configInfo, setConfigInfo] = useState<TalosConfigInfo | null>(null);
  const [serviceInfo, setServiceInfo] = useState<TalosServiceInfo | null>(null);
  const [readinessInfo, setReadinessInfo] = useState<ProtocoreReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [serviceOutput, setServiceOutput] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    tone: "ok" | "err" | "info" | "warn";
    text: string;
  } | null>(null);
  const runtimeProvenance = useRuntimeProvenance();

  const refreshStatus = useCallback(async () => {
    try {
      const next = await talosStatus();
      setStatus(next);
      if (next.endpoint || next.configPath) {
        setForm((prev) => ({
          ...prev,
          endpoint: next.endpoint ?? prev.endpoint,
          configPath: next.configPath ?? prev.configPath,
        }));
      }
      if (next.lastError) {
        setMessage({ tone: "warn", text: next.lastError });
      }
    } catch (err) {
      setStatus(EMPTY_TALOS_STATUS);
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    }
  }, []);

  const inspectConfig = useCallback(async (values: Pick<FormState, "endpoint" | "configPath">) => {
    if (!values.configPath.trim()) {
      setConfigInfo(null);
      return;
    }
    const info = await talosConfigInfo({
      endpoint: values.endpoint,
      configPath: values.configPath,
    });
    setConfigInfo(info);
    setForm((prev) => ({
      ...prev,
      endpoint: prev.endpoint || info.endpoint,
      configPath: info.path,
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [endpoint, configPath, releaseDigest] = await Promise.all([
          keychainGet(KEYCHAIN_ACCOUNTS.talosEndpoint),
          keychainGet(KEYCHAIN_ACCOUNTS.talosConfigPath),
          keychainGet(KEYCHAIN_ACCOUNTS.protocoreExpectedDigest),
        ]);
        if (cancelled) return;
        const nextForm = {
          endpoint: endpoint ?? "",
          configPath: configPath ?? "",
          releaseDigest: releaseDigest ?? "",
          rpcEndpoint: getStoredRpcEndpoint() ?? "",
          chatBootstrapPeers: getStoredChatBootstrapPeers().join(", "),
        };
        setForm(nextForm);
        if (nextForm.configPath) {
          try {
            const info = await talosConfigInfo(nextForm);
            if (!cancelled) setConfigInfo(info);
          } catch (err) {
            if (!cancelled) {
              setMessage({ tone: "warn", text: (err as Error)?.message ?? String(err) });
            }
          }
        }
      } catch (err) {
        if (cancelled) return;
        setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
      }
      if (!cancelled) await refreshStatus();
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [inspectConfig, refreshStatus]);

  const saveOnly = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const releaseDigest = validateReleaseDigest(form.releaseDigest);
      await Promise.all([
        form.endpoint
          ? keychainSet(KEYCHAIN_ACCOUNTS.talosEndpoint, form.endpoint)
          : keychainDelete(KEYCHAIN_ACCOUNTS.talosEndpoint),
        form.configPath
          ? keychainSet(KEYCHAIN_ACCOUNTS.talosConfigPath, form.configPath)
          : keychainDelete(KEYCHAIN_ACCOUNTS.talosConfigPath),
        releaseDigest
          ? keychainSet(KEYCHAIN_ACCOUNTS.protocoreExpectedDigest, releaseDigest)
          : keychainDelete(KEYCHAIN_ACCOUNTS.protocoreExpectedDigest),
      ]);
      setForm((prev) => ({ ...prev, releaseDigest }));
      await refreshStatus();
      await inspectConfig(form);
      setMessage({ tone: "ok", text: "Saved Talos connection settings." });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  const saveRpc = () => {
    setMessage(null);
    try {
      const next = setStoredRpcEndpoint(form.rpcEndpoint);
      setMessage({
        tone: "ok",
        text: next
          ? "Saved Protocore RPC endpoint. Reloading."
          : "Cleared Protocore RPC override. Reloading.",
      });
      window.setTimeout(() => window.location.reload(), 250);
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    }
  };

  const saveChatPeers = () => {
    setMessage(null);
    try {
      const peers = setStoredChatBootstrapPeers(
        parseChatBootstrapPeers(form.chatBootstrapPeers),
      );
      setForm((prev) => ({ ...prev, chatBootstrapPeers: peers.join(", ") }));
      setMessage({
        tone: "ok",
        text: peers.length > 0
          ? "Saved chat bootstrap peers. Reloading."
          : "Cleared chat bootstrap peers. Reloading.",
      });
      window.setTimeout(() => window.location.reload(), 250);
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    }
  };

  const connect = async () => {
    setBusy(true);
    setMessage(null);
    setServiceOutput(null);
    setServiceInfo(null);
    setReadinessInfo(null);
    try {
      const releaseDigest = validateReleaseDigest(form.releaseDigest);
      if (releaseDigest) {
        await keychainSet(KEYCHAIN_ACCOUNTS.protocoreExpectedDigest, releaseDigest);
        setForm((prev) => ({ ...prev, releaseDigest }));
      } else {
        await keychainDelete(KEYCHAIN_ACCOUNTS.protocoreExpectedDigest);
      }
      const next = await talosConnect(form);
      setStatus(next);
      await inspectConfig({
        endpoint: next.endpoint ?? form.endpoint,
        configPath: next.configPath ?? form.configPath,
      });
      setMessage({
        tone: next.reachable ? "ok" : "warn",
        text: next.reachable
          ? `Talos API reachable at ${next.nodeAddress ?? next.endpoint}.`
          : (next.lastError ?? "Talos settings saved; API not reachable yet."),
      });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  const readService = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await talosService("ext-protocore");
      const readiness = await talosProtocoreReadiness(getStoredRpcEndpoint()).catch(() => null);
      setServiceOutput(result.output || "(no output)");
      setServiceInfo(readiness?.service ?? result.service);
      setReadinessInfo(readiness);
      setMessage({
        tone: readiness?.severity === "err" ? "err" : readiness?.severity === "warn" ? "warn" : "ok",
        text: readiness ? readiness.summary : `Read ${result.command}.`,
      });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  const chooseConfig = async () => {
    if (!tauri) return;
    setBusy(true);
    setMessage(null);
    try {
      const selected = await open({
        title: "Select talosconfig",
        multiple: false,
        directory: false,
        defaultPath: form.configPath || undefined,
        fileAccessMode: "scoped",
      });
      if (typeof selected !== "string") return;
      const nextForm = { ...form, configPath: selected };
      setForm(nextForm);
      await inspectConfig(nextForm);
      setMessage({ tone: "ok", text: "Loaded talosconfig details." });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  const trustConfig = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const previousPinStatus = configInfo?.caPinStatus;
      const info = await talosTrustConfig({
        endpoint: form.endpoint,
        configPath: form.configPath,
      });
      setConfigInfo(info);
      setMessage({
        tone: "ok",
        text: previousPinStatus === "mismatch"
          ? "Rotated trusted Talos CA fingerprint to the current talosconfig."
          : "Trusted current Talos CA fingerprint.",
      });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error)?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  const tauri = inTauri();
  const ready = form.endpoint.length > 0 && form.configPath.length > 0;
  const attestation = releaseAttestationStatus({
    expectedDigest: form.releaseDigest,
    service: serviceInfo,
    provenance: runtimeProvenance.data,
    provenanceLoading: runtimeProvenance.loading,
    provenanceError: runtimeProvenance.error,
    provenanceNotExposed: runtimeProvenance.notExposed,
    rpcEndpoint,
  });

  return (
    <div className="card card--padded" style={{ maxWidth: 720 }}>
      <div className="card__head">
        <div>
          <h3>Monarch OS</h3>
          <div className="sub">
            native Talos API mTLS · stores endpoint, talosconfig path, and release
            digest in the OS keychain and compares it with live runtime provenance
          </div>
        </div>
        <span
          className={
            status.reachable
              ? "halo halo--ok"
              : status.configured
                ? "halo halo--warn"
                : tauri
                  ? "halo"
                  : "halo halo--warn"
          }
          title={status.lastError ?? status.version ?? undefined}
        >
          <span className="dot" /> {tauri ? statusText(status) : "browser preview"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
        <Field
          label="Talos endpoint"
          placeholder="https://192.0.2.20:50000"
          value={form.endpoint}
          onChange={(v) => {
            setForm((s) => ({ ...s, endpoint: v }));
            setConfigInfo(null);
          }}
          mono
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
          <Field
            label="talosconfig path"
            placeholder="/Users/me/.talos/config"
            value={form.configPath}
            onChange={(v) => {
              setForm((s) => ({ ...s, configPath: v }));
              setConfigInfo(null);
            }}
            mono
          />
          <button
            type="button"
            className="btn btn--sm"
            onClick={chooseConfig}
            disabled={busy || !tauri}
            style={{ alignSelf: "end", minHeight: 38 }}
          >
            Select
          </button>
        </div>
        <Field
          label="expected Protocore digest"
          placeholder="64-character SHA-256 hex, optional for dev"
          value={form.releaseDigest}
          onChange={(v) => setForm((s) => ({ ...s, releaseDigest: v }))}
          mono
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
          <Field
            label="Protocore RPC endpoint"
            placeholder={rpcEndpoint}
            value={form.rpcEndpoint}
            onChange={(v) => setForm((s) => ({ ...s, rpcEndpoint: v }))}
            mono
          />
          <button
            type="button"
            className="btn btn--sm"
            onClick={saveRpc}
            style={{ alignSelf: "end", minHeight: 38 }}
          >
            Save RPC
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
          <Field
            label="Chat bootstrap peers"
            placeholder="/ip4/203.0.113.10/tcp/41001/p2p/12D3KooW..."
            value={form.chatBootstrapPeers}
            onChange={(v) => setForm((s) => ({ ...s, chatBootstrapPeers: v }))}
            mono
          />
          <button
            type="button"
            className="btn btn--sm"
            onClick={saveChatPeers}
            style={{ alignSelf: "end", minHeight: 38 }}
          >
            Save chat
          </button>
        </div>
        <span
          className={attestation.className}
          title={attestation.title}
          style={{ alignSelf: "flex-start" }}
        >
          <span className="dot" /> {attestation.text}
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn--sm"
          onClick={saveOnly}
          disabled={busy || !tauri}
        >
          Save
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={connect}
          disabled={busy || !tauri || !ready}
        >
          Probe Talos API
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void inspectConfig(form)}
          disabled={busy || !tauri || !form.configPath}
        >
          Inspect certs
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={trustConfig}
          disabled={busy || !tauri || !configInfo}
        >
          Trust current CA
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={readService}
          disabled={busy || !tauri || !status.configured}
        >
          Read ext-protocore
        </button>
      </div>

      {status.version ? (
        <pre
          className="mono"
          style={{
            marginTop: 14,
            maxHeight: 88,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            color: "var(--fg-300)",
            fontSize: 11,
          }}
        >
          {status.version}
        </pre>
      ) : null}

      {configInfo ? (
        <div
          style={{
            marginTop: 14,
            paddingTop: 14,
            borderTop: "1px solid var(--glass-stroke)",
          }}
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="halo halo--ok">
              <span className="dot" /> context · {configInfo.context}
            </span>
            <span className="halo">server · {configInfo.serverName}</span>
            <span className={caPinHalo(configInfo)}>
              <span className="dot" /> CA pin · {configInfo.caPinStatus}
            </span>
            {configInfo.warnings.map((warning) => (
              <span className="halo halo--warn" key={warning}>
                <span className="dot" /> {warning}
              </span>
            ))}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 10,
              marginTop: 12,
            }}
          >
            {configInfo.certificates.map((cert) => (
              <div
                key={cert.role}
                style={{
                  minWidth: 0,
                  border: "1px solid var(--glass-stroke)",
                  borderRadius: 8,
                  padding: 10,
                  background: "rgba(255,255,255,0.02)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <strong style={{ fontSize: 12, color: "var(--fg-100)" }}>
                    {cert.role}
                  </strong>
                  <span
                    className={certHalo(cert)}
                  >
                    <span className="dot" /> {certStatusText(cert)}
                  </span>
                </div>
                <div className="cap" style={{ marginTop: 8 }}>
                  fingerprint
                </div>
                <div className="mono" title={cert.sha256Fingerprint} style={{ fontSize: 11 }}>
                  {shortFingerprint(cert.sha256Fingerprint)}
                </div>
                <div className="cap" style={{ marginTop: 8 }}>
                  expires
                </div>
                <div style={{ fontSize: 12, color: "var(--fg-300)" }}>
                  {certExpiryText(cert)}
                </div>
                <div className="cap" style={{ marginTop: 8 }}>
                  subject
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--fg-400)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {cert.subject}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {serviceInfo || readinessInfo ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className={serviceHalo(serviceInfo)}>
              <span className="dot" /> {serviceInfo?.displayState ?? "not registered"}
            </span>
            <span className="halo">raw · {serviceInfo?.state ?? "—"}</span>
            {readinessInfo ? (
              <span className={readinessHalo(readinessInfo)}>
                <span className="dot" /> readiness · {readinessInfo.displayState}
              </span>
            ) : null}
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--fg-300)" }}>
            {readinessInfo?.summary ?? serviceInfo?.summary ?? "ext-protocore service state unavailable"}
          </div>
          {readinessInfo ? (
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--fg-400)" }}>
              RPC · {readinessInfo.rpcEndpoint} · chain {readinessInfo.chainId ?? "—"} · block{" "}
              {readinessInfo.blockNumber?.toLocaleString() ?? "—"}
            </div>
          ) : null}
          {readinessInfo?.checks.map((check) => (
            <div
              key={check.name}
              style={{
                marginTop: 6,
                fontSize: 11,
                color:
                  check.state === "err"
                    ? "var(--err)"
                    : check.state === "warn"
                      ? "var(--warn)"
                      : "var(--fg-400)",
                overflowWrap: "anywhere",
              }}
            >
              {check.name} · {check.message}
            </div>
          ))}
          {serviceInfo?.lastEvent ? (
            <div
              style={{
                marginTop: 8,
                fontSize: 11,
                color: "var(--fg-400)",
                overflowWrap: "anywhere",
              }}
            >
              latest event · {serviceInfo.lastEvent.state} · {serviceInfo.lastEvent.message}
            </div>
          ) : null}
        </div>
      ) : null}

      {serviceOutput ? (
        <pre
          className="mono"
          style={{
            marginTop: 14,
            maxHeight: 140,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            color: "var(--fg-300)",
            fontSize: 11,
          }}
        >
          {serviceOutput}
        </pre>
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
