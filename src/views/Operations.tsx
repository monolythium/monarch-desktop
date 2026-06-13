// Operations — the home of the canonical operator verbs. Cards are
// sourced from `ops/catalog.ts` so the ⌘K palette and this page stay in
// sync. Every card kicks off the shared Operations drawer state machine;
// nothing executes inline. Verbs are grouped by category
// (system / keys / cluster / treasury / emergency) — matching
// designs/operations.jsx — so the page reads as distinct operation
// groups, not one undifferentiated wall of cards.
//
// Node control + connection settings (Talos mTLS, operator key, SSH dev
// bridge, Ask Monarch, RPC endpoint) live in their own clearly-separated
// "Console & connection" block at the bottom so configuration never sits
// mixed in with the action cards.

import { useState } from "react";
import { AiSettings } from "../components/AiSettings";
import { OperatorKeySettings } from "../components/OperatorKeySettings";
import { SshSettings } from "../components/SshSettings";
import { TalosSettings } from "../components/TalosSettings";
import { useKeychainPresence } from "../hooks/useSelfOperator";
import { OP_CATALOG, useOps } from "../ops";
import type { OpCatalogEntry } from "../ops/catalog";
import { FOUNDATION_OP_KINDS } from "../ops/errors";
import { getStoredRpcEndpoint, rpcEndpoint, setStoredRpcEndpoint } from "../sdk";

/** RPC endpoint override — the one place to point Monarch at a node. */
function RpcEndpointSettings() {
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

  return (
    <div className="card card--padded">
      <div className="card__head">
        <div>
          <h3>RPC endpoint</h3>
          <div className="sub">which node Monarch reads from and submits to</div>
        </div>
        <span className="halo halo--info"><span className="dot" /> active: {rpcEndpoint}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
        <input
          type="url"
          className="mono"
          placeholder="http://127.0.0.1:8545 (leave empty for the default)"
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
          <button type="button" className="btn btn--sm" onClick={apply}>
            Save & reconnect
          </button>
          {note ? <span style={{ fontSize: 11, color: "var(--fg-400)" }}>{note}</span> : null}
        </div>
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          http:// or https:// only. Saving reloads the console so every view reconnects to the
          new endpoint.
        </span>
      </div>
    </div>
  );
}

function formatReceiptTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** One operation verb rendered as a card that opens the shared drawer. */
function OpCard({ v, onRun }: { v: OpCatalogEntry; onRun: (v: OpCatalogEntry) => void }) {
  const risk = v.risk ?? (v.destructive ? "high" : "low");
  return (
    <button type="button" className="ops-card card" onClick={() => onRun(v)}>
      <span className="ops-card__icon">{v.icon ?? "OP"}</span>
      <span className="ops-card__body">
        <span className="ops-card__meta">
          <b>{v.title}</b>
          <span className={`risk risk--${risk}`}>{risk} risk</span>
        </span>
        <small>{v.sub}</small>
        <span className="ops-card__auth">
          {v.needsPasskey ? "keychain required" : "local confirmation"} · {v.fields.length} fields
        </span>
      </span>
      <span className="ops-card__arrow" aria-hidden>→</span>
    </button>
  );
}

export function Operations() {
  const ops = useOps();
  const recentReceipts = ops.receipts.slice(0, 6);
  // Foundation-only verbs are hidden from ordinary operator installs —
  // a novice should never fill a form that can only fail at signing.
  const presence = useKeychainPresence();
  const visibleCatalog = presence.hasFoundationKey
    ? OP_CATALOG
    : OP_CATALOG.filter((entry) => !FOUNDATION_OP_KINDS.has(entry.kind));
  const hiddenCount = OP_CATALOG.length - visibleCatalog.length;

  const runOp = (v: OpCatalogEntry) =>
    ops.requestOp({
      kind: v.kind,
      title: v.title,
      sub: v.sub,
      intro: v.intro,
      fields: v.fields,
      effects: v.effects,
      diff: v.diff,
      icon: v.icon,
      risk: v.risk,
      destructive: v.destructive,
      needsPasskey: v.needsPasskey,
      confirmLabel: v.confirmLabel,
    });

  return (
    <section className="view fade-in">
      <header>
        <h1 className="view__title">Operations</h1>
        <p className="view__subtitle">
          state machine · preview → auth → executing → done. Every verb routes through the shared drawer.
        </p>
      </header>

      <div className="ops-hero card card--padded">
        <div>
          <div className="cap">operator actions</div>
          <h2>Every action shows a diff. Every destructive action needs the keychain.</h2>
        </div>
      </div>

      {hiddenCount > 0 ? (
        <div className="halo halo--info" style={{ alignSelf: "flex-start", whiteSpace: "normal" }}>
          <span className="dot" /> {hiddenCount} foundation-only operations are hidden — no
          foundation signer is stored on this install (ordinary operators never need them).
        </div>
      ) : null}

      <div className="ops-grid">
        {visibleCatalog.map((v) => (
          <OpCard key={v.kind} v={v} onRun={runOp} />
        ))}
      </div>

      {recentReceipts.length > 0 ? (
        <section className="ops-receipts">
          <div className="ops-receipts__head">
            <div>
              <div className="cap">local audit trail</div>
              <h2>Recent operation receipts</h2>
            </div>
            <button type="button" className="btn btn--ghost btn--sm" onClick={ops.clearReceipts}>
              Clear
            </button>
          </div>
          <div className="ops-receipts__list">
            {recentReceipts.map((receipt) => (
              <div className="ops-receipt" key={receipt.id}>
                <span className={receipt.status === "ok" ? "dot" : "dot dot--err"} />
                <div>
                  <b>{receipt.title}</b>
                  <small>
                    {formatReceiptTime(receipt.createdAt)} · {receipt.transport}
                    {receipt.service ? ` · ${receipt.service}` : ""}
                    {receipt.action ? `:${receipt.action}` : ""}
                  </small>
                </div>
                <code>{receipt.txHash ?? receipt.id.slice(0, 12)}</code>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="ops-settings">
        <div className="ops-settings__head">
          <div className="cap">console &amp; connection</div>
          <h2>Node control &amp; settings</h2>
          <p>
            The Talos control plane, your operator key, the SSH development bridge, Ask Monarch, and
            which node this console reads from. Configuration — kept separate from the action verbs above.
          </p>
        </div>
        <div className="ops-settings__grid">
          <OperatorKeySettings />
          <TalosSettings />
          <SshSettings />
          <AiSettings />
          <RpcEndpointSettings />
        </div>
      </section>
    </section>
  );
}
