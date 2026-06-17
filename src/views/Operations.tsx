// Operations — compact action launcher and local receipt trail.

import { useMemo, useState } from "react";
import { useKeychainPresence } from "../hooks/useSelfOperator";
import { OP_CATALOG, useOps } from "../ops";
import {
  OP_BANDS,
  actionBadge,
  bandHeading,
  type OpCatalogEntry,
  type OpCategory,
} from "../ops/catalog";
import { FOUNDATION_OP_KINDS } from "../ops/errors";
import type { OpKind } from "../ops/types";
import { OpIcon } from "../components/icons";

type CategoryFilter = "all" | OpCategory;

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: "All",
  system: OP_BANDS.system.label,
  cluster: OP_BANDS.cluster.label,
  keys: OP_BANDS.keys.label,
  treasury: OP_BANDS.treasury.label,
  emergency: OP_BANDS.emergency.label,
};

// Bands are shown in numeric order so the page reads 1→100 top to bottom.
const BAND_ORDER: OpCategory[] = [
  "system",
  "cluster",
  "keys",
  "treasury",
  "emergency",
];

const CATEGORY_ORDER: CategoryFilter[] = ["all", ...BAND_ORDER];

// kind → action number, so the (schema-stable) receipt rows can show the
// reference number without persisting it into the hashed audit payload.
const ACTION_NUMBER_BY_KIND: Partial<Record<OpKind, number>> = Object.fromEntries(
  OP_CATALOG.map((entry) => [entry.kind, entry.actionNumber]),
);

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

function riskLabel(v: OpCatalogEntry): "low" | "medium" | "high" {
  return v.risk ?? (v.destructive ? "high" : "low");
}

function searchableText(v: OpCatalogEntry): string {
  return [
    v.title,
    v.sub,
    v.kind,
    v.category,
    // The reference number, both bare ("49") and badged ("#49"), so typing
    // either finds the op.
    String(v.actionNumber),
    actionBadge(v),
    ...(v.keywords ?? []),
  ].join(" ").toLowerCase();
}

function buildRequest(v: OpCatalogEntry) {
  return {
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
  };
}

function OpRow({
  selected,
  v,
  onSelect,
}: {
  selected: boolean;
  v: OpCatalogEntry;
  onSelect: (kind: OpKind) => void;
}) {
  const risk = v.risk ?? (v.destructive ? "high" : "low");
  return (
    <button
      type="button"
      className={selected ? "ops-action is-selected" : "ops-action"}
      onClick={() => onSelect(v.kind)}
    >
      <span className="ops-action__pick">
        <span className="ops-action__icon">
          <OpIcon kind={v.kind} size={16} />
        </span>
        <span className="ops-action__copy">
          <b>{v.title}</b>
          <small>{v.sub}</small>
        </span>
      </span>
      <span className="ops-action__num" title={`Action ${v.actionNumber}`}>
        {actionBadge(v)}
      </span>
      <span className={`ops-action__risk risk risk--${risk}`}>{risk}</span>
    </button>
  );
}

export function Operations() {
  const ops = useOps();
  const recentReceipts = ops.receipts.slice(0, 6);
  // Recovery-only actions appear only on installs that can authorize them.
  const presence = useKeychainPresence();
  const visibleCatalog = presence.hasFoundationKey
    ? OP_CATALOG
    : OP_CATALOG.filter((entry) => !FOUNDATION_OP_KINDS.has(entry.kind));
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedKind, setSelectedKind] = useState<OpKind | null>(visibleCatalog[0]?.kind ?? null);

  const counts = useMemo(() => {
    const next: Record<CategoryFilter, number> = {
      all: visibleCatalog.length,
      system: 0,
      cluster: 0,
      keys: 0,
      treasury: 0,
      emergency: 0,
    };
    for (const item of visibleCatalog) next[item.category] += 1;
    return next;
  }, [visibleCatalog]);

  const filteredCatalog = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return visibleCatalog.filter((entry) => {
      if (category !== "all" && entry.category !== category) return false;
      if (needle && !searchableText(entry).includes(needle)) return false;
      return true;
    });
  }, [category, query, visibleCatalog]);

  const selectedEntry =
    filteredCatalog.find((entry) => entry.kind === selectedKind) ??
    filteredCatalog[0] ??
    null;

  const runOp = (v: OpCatalogEntry) =>
    ops.requestOp(buildRequest(v));

  return (
    <section className="view fade-in">
      <header className="view-head">
        <div>
          <h1 className="view__title">Operations</h1>
          <p className="view__subtitle">Find an action, review it, then authorize.</p>
        </div>
      </header>

      <div className="ops-console">
        <div className="ops-console__bar">
          <label className="ops-search">
            <span className="cap">search actions</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="restart, register, backup..."
              spellCheck={false}
            />
          </label>
          <div className="ops-tabs" aria-label="Operation category">
            {CATEGORY_ORDER.filter((item) => item === "all" || counts[item] > 0).map((item) => (
              <button
                type="button"
                key={item}
                className={category === item ? "is-on" : ""}
                onClick={() => setCategory(item)}
              >
                <span>{CATEGORY_LABELS[item]}</span>
                <b>{counts[item]}</b>
              </button>
            ))}
          </div>
        </div>

        <div className="ops-workbench">
          <div className="ops-action-list" aria-label="Available operations">
            {filteredCatalog.length > 0 ? (
              BAND_ORDER.map((band) => {
                const items = filteredCatalog
                  .filter((entry) => entry.category === band)
                  .sort((a, b) => a.actionNumber - b.actionNumber);
                if (items.length === 0) return null;
                return (
                  <div className="ops-band" key={band}>
                    <div className="ops-band__head cap">{bandHeading(band)}</div>
                    {items.map((v) => (
                      <OpRow
                        key={v.kind}
                        selected={selectedEntry?.kind === v.kind}
                        v={v}
                        onSelect={(kind) => setSelectedKind(kind)}
                      />
                    ))}
                  </div>
                );
              })
            ) : (
              <div className="empty-state">No action matches this search.</div>
            )}
          </div>

          <aside className="ops-detail" aria-label="Selected operation detail">
            {selectedEntry ? (
              <>
                <div className="ops-detail__head">
                  <span className="ops-action__icon">
                    <OpIcon kind={selectedEntry.kind} size={18} />
                  </span>
                  <div>
                    <div className="cap">
                      {CATEGORY_LABELS[selectedEntry.category]} · action{" "}
                      {selectedEntry.actionNumber}
                    </div>
                    <h2>{selectedEntry.title}</h2>
                    <p>{selectedEntry.sub}</p>
                  </div>
                  <span className="ops-detail__num" title={`Action ${selectedEntry.actionNumber}`}>
                    {actionBadge(selectedEntry)}
                  </span>
                </div>
                <div className="ops-detail__tags">
                  <span className={`risk risk--${riskLabel(selectedEntry)}`}>
                    {riskLabel(selectedEntry)} risk
                  </span>
                  <span>{selectedEntry.needsPasskey ? "Keychain" : "Confirm"}</span>
                  <span>{selectedEntry.fields.length} inputs</span>
                </div>
                <p className="ops-detail__intro">{selectedEntry.intro}</p>
                {selectedEntry.effects && selectedEntry.effects.length > 0 ? (
                  <details className="ops-detail__more">
                    <summary>What changes</summary>
                    <ul>
                      {selectedEntry.effects.slice(0, 3).map((effect) => (
                        <li key={effect}>{effect}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                <button type="button" className="btn btn--primary" onClick={() => runOp(selectedEntry)}>
                  Review action
                </button>
              </>
            ) : (
              <div className="empty-state">Select an action to see details.</div>
            )}
          </aside>
        </div>
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
                  <b>
                    {ACTION_NUMBER_BY_KIND[receipt.kind] !== undefined ? (
                      <span
                        className="ops-receipt__num"
                        title={`Action ${ACTION_NUMBER_BY_KIND[receipt.kind]}`}
                      >
                        #{ACTION_NUMBER_BY_KIND[receipt.kind]}
                      </span>
                    ) : null}
                    {receipt.title}
                  </b>
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
    </section>
  );
}
