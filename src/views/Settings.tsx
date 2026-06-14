// Settings — the one place to change how Monarch connects and to update the
// app. Software updates (manual check + one-click install), the node RPC
// endpoint (with live connection status so a behind/syncing node is obvious),
// the operator key, and the Talos / Ask-Monarch console settings all live here.

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { AiSettings } from "../components/AiSettings";
import { OperatorKeySettings } from "../components/OperatorKeySettings";
import { TalosSettings } from "../components/TalosSettings";
import {
  checkForUpdate,
  downloadAndInstallUpdate,
  type UpdateCheckResult,
} from "../sdk/updater";
import { APP_CHANGELOG } from "../sdk/changelog";
import {
  getStoredRpcEndpoint,
  rpcEndpoint,
  setStoredRpcEndpoint,
  useChainStatus,
  useNodeStatus,
} from "../sdk";

function SettingsSection({
  title,
  description,
  meta,
  children,
  defaultOpen = false,
}: {
  title: string;
  description: string;
  meta?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="settings-section" {...(defaultOpen ? { open: true } : {})}>
      <summary className="settings-section__summary">
        <span className="settings-section__copy">
          <span className="settings-section__title">{title}</span>
          <span className="settings-section__description">{description}</span>
        </span>
        {meta ? <span className="settings-section__meta">{meta}</span> : null}
        <span className="settings-section__chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="settings-section__body">{children}</div>
    </details>
  );
}

function ChangelogCard() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {APP_CHANGELOG.map((entry) => (
        <div key={entry.version} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <b style={{ fontFamily: "var(--f-mono)", fontSize: 13 }}>v{entry.version}</b>
            <span className="cap" style={{ color: "var(--fg-400)" }}>{entry.date}</span>
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              display: "flex",
              flexDirection: "column",
              gap: 5,
            }}
          >
            {entry.highlights.map((h) => (
              <li key={h} style={{ fontSize: 12.5, color: "var(--fg-200)", lineHeight: 1.55 }}>
                {h}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Software updates — manual check + one-click install & restart. */
function UpdatesCard() {
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => undefined);
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    setNote(null);
    try {
      const r = await checkForUpdate();
      setResult(r);
      if (!r.available) setNote("You're on the latest version.");
    } catch (err) {
      setNote((err as Error)?.message ?? "Update check failed.");
    } finally {
      setChecking(false);
    }
  }, []);

  const install = useCallback(async () => {
    setInstalling(true);
    setNote(null);
    try {
      await downloadAndInstallUpdate((done, total) => {
        setProgress(total ? Math.round((done / total) * 100) : null);
      });
      // On success the app relaunches; this line is effectively unreachable.
    } catch (err) {
      setNote((err as Error)?.message ?? "Install failed.");
      setInstalling(false);
    }
  }, []);

  return (
    <div className="card card--padded">
      <div className="card__head">
        <div>
          <h3>Software updates</h3>
          <div className="sub">current version {version ? `v${version}` : "—"}</div>
        </div>
        <button type="button" className="btn btn--sm" onClick={() => void check()} disabled={checking || installing}>
          {checking ? "Checking…" : "Check for updates"}
        </button>
      </div>
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        {result?.available ? (
          <div className="halo halo--gold" style={{ alignSelf: "flex-start", whiteSpace: "normal" }}>
            <span className="dot" /> Monarch Desktop v{result.version} is available
          </div>
        ) : null}
        {result?.available ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => void install()} disabled={installing}>
              {installing ? (progress !== null ? `Installing… ${progress}%` : "Installing…") : "Install & restart"}
            </button>
            {result.notes ? <span style={{ fontSize: 11, color: "var(--fg-400)" }}>{result.notes}</span> : null}
          </div>
        ) : null}
        {note ? <span style={{ fontSize: 11.5, color: "var(--fg-400)" }}>{note}</span> : null}
        <span style={{ fontSize: 10.5, color: "var(--fg-500)" }}>
          Updates are signed and verified before install. Installing relaunches Monarch.
        </span>
      </div>
    </div>
  );
}

/** RPC endpoint + live connection status, so a behind/syncing node is obvious. */
function NodeConnectionCard() {
  const status = useNodeStatus();
  const chain = useChainStatus();
  const [draft, setDraft] = useState(() => getStoredRpcEndpoint() ?? "");
  const [note, setNote] = useState<string | null>(null);

  const apply = () => {
    try {
      setStoredRpcEndpoint(draft.trim() || null);
      setNote("Saved — reloading to reconnect…");
      window.setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      setNote((err as Error)?.message ?? String(err));
    }
  };

  const chainId = chain.data?.chainId ?? status.chainId;
  const block = status.blockNumber;
  const behind = status.reachable && (block === null || block === 0);

  return (
    <div className="card card--padded">
      <div className="card__head">
        <div>
          <h3>Node connection</h3>
          <div className="sub">which node Monarch reads from and submits to</div>
        </div>
        <span className={`halo ${status.reachable ? "halo--info" : "halo--err"}`}>
          <span className="dot" /> {status.reachable ? "connected" : "unreachable"}
        </span>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "12px 0" }}>
        <div><div className="cap">chain</div><b style={{ fontSize: 14 }}>{chainId ?? "—"}</b></div>
        <div><div className="cap">block</div><b style={{ fontSize: 14 }}>{block?.toLocaleString() ?? "—"}</b></div>
        <div><div className="cap">endpoint</div><b className="mono" style={{ fontSize: 12 }}>{rpcEndpoint}</b></div>
      </div>

      {behind ? (
        <div className="halo halo--warn" style={{ alignSelf: "flex-start", whiteSpace: "normal", marginBottom: 10 }}>
          <span className="dot" /> This node is at block 0 — it's still syncing to the committee, so
          balances and the chain head will read empty. Point at a synced node below (e.g. a public
          fleet endpoint) to operate while yours catches up.
        </div>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input
          type="url"
          className="mono"
          placeholder="http://127.0.0.1:8545"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          autoComplete="off"
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
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" className="btn btn--sm" onClick={apply}>Save & reconnect</button>
          {note ? <span style={{ fontSize: 11, color: "var(--fg-400)" }}>{note}</span> : null}
        </div>
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          http:// or https:// only. Saving reloads the console so every view reconnects.
        </span>
      </div>
    </div>
  );
}

export function Settings() {
  return (
    <section className="view fade-in">
      <header>
        <h1 className="view__title">Settings</h1>
        <p className="view__subtitle">Open a section only when you need to change it.</p>
      </header>

      <div className="ops-settings__grid settings-list">
        <SettingsSection
          title="Software updates"
          description="Check for signed Monarch Desktop releases."
          meta="desktop"
        >
          <UpdatesCard />
        </SettingsSection>
        <SettingsSection
          title="Changelog"
          description="What changed in each Monarch Desktop release."
          meta={APP_CHANGELOG[0] ? `v${APP_CHANGELOG[0].version}` : "desktop"}
        >
          <ChangelogCard />
        </SettingsSection>
        <SettingsSection
          title="Node connection"
          description="Choose the Protocore RPC endpoint Monarch reads from."
          meta="operator"
        >
          <NodeConnectionCard />
        </SettingsSection>
        <SettingsSection
          title="Operator signing key"
          description="Import or generate the 24-word key used for registry actions."
          meta="operator"
        >
          <OperatorKeySettings />
        </SettingsSection>
        <SettingsSection
          title="Monarch OS"
          description="Talos endpoint, talosconfig, release digest, and runtime checks."
          meta="advanced"
        >
          <TalosSettings />
        </SettingsSection>
        <SettingsSection
          title="Ask Monarch"
          description="Hosted or local advisory model configuration."
          meta="optional"
        >
          <AiSettings />
        </SettingsSection>
      </div>
    </section>
  );
}
