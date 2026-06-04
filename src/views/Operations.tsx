// Operations — the home of the canonical operator verbs. Cards are
// sourced from `ops/catalog.ts` so the ⌘K palette and this page stay in
// sync. Every card kicks off the shared Operations drawer state machine;
// nothing executes inline. Categories follow designs/operations.jsx
// (system / keys / cluster / treasury / emergency).
//
// The TalosSettings panel is the production Monarch OS control path:
// Talos API mTLS via the operator's talosconfig. SshSettings remains a
// plain-Linux development bridge until all operation verbs are mapped
// to Talos service/config calls. AiSettings configures Ask Monarch's
// advisory bridge.

import { AiSettings } from "../components/AiSettings";
import { OperatorKeySettings } from "../components/OperatorKeySettings";
import { SshSettings } from "../components/SshSettings";
import { TalosSettings } from "../components/TalosSettings";
import { OP_CATALOG, useOps } from "../ops";

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

export function Operations() {
  const ops = useOps();
  const recentReceipts = ops.receipts.slice(0, 6);

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
          <h2>Every action shows a diff before anything signs.</h2>
          <p>
            Monarch routes sensitive changes through preview, keychain approval,
            execution, and receipt capture. Unsupported actions fail closed until
            their production path exists.
          </p>
        </div>
        <span className="halo halo--gold"><span className="dot" /> preview first</span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
          gap: 14,
        }}
      >
        <OperatorKeySettings />
        <TalosSettings />
        <SshSettings />
        <AiSettings />
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

      <div className="ops-grid">
        {OP_CATALOG.map((v) => (
          <button
            type="button"
            className="ops-card card"
            key={v.kind}
            onClick={() =>
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
              })
            }
          >
            <span className="ops-card__icon">{v.icon ?? "OP"}</span>
            <span className="ops-card__body">
              <span className="ops-card__meta">
                <span className="cap">{v.category}</span>
                <span className={`risk risk--${v.risk ?? (v.destructive ? "high" : "low")}`}>
                  {v.risk ?? (v.destructive ? "high" : "low")} risk
                </span>
              </span>
              <b>{v.title}</b>
              <small>{v.sub}</small>
              <span className="ops-card__auth">
                {v.needsPasskey ? "keychain required" : "local confirmation"} · {v.fields.length} fields
              </span>
            </span>
            <span className="ops-card__arrow" aria-hidden>→</span>
          </button>
        ))}
      </div>
    </section>
  );
}
