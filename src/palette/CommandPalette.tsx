// ⌘K command palette. Opens on Cmd+K (or Ctrl+K on Linux/Windows) and
// fuzzy-searches across:
//
//   - every nav route (jumps via react-router)
//   - every Operations verb (invokes `requestOp` so the keychain-bound
//     drawer state machine handles it like a manual click)
//   - starter Ask Monarch queries (opens the live advisory rail)
//
// Built on `cmdk` (lightweight, hooks-only). The dialog lives at the
// app root via `<CommandPalette />` mounted in App.tsx.

import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { NAV_ROUTES } from "../nav/routes";
import { OP_CATALOG, useOps } from "../ops";

type AskQuery = {
  label: string;
  query: string;
  keywords: string[];
};

const ASK_QUERIES: AskQuery[] = [
  {
    label: "Why did I miss rounds?",
    query: "why did I miss the last 3 rounds?",
    keywords: ["ask", "missed", "round", "blocks", "latency"],
  },
  {
    label: "What is my removal risk?",
    query: "am I at risk of being removed from rotation?",
    keywords: ["ask", "risk", "jail", "liveness"],
  },
  {
    label: "Can I rotate keys now?",
    query: "is it safe to rotate my signing key now?",
    keywords: ["ask", "rotate", "keys", "dkg"],
  },
  {
    label: "When is my next block duty?",
    query: "when is my next block-production duty?",
    keywords: ["ask", "block", "slot", "duty"],
  },
];

type Item =
  | { kind: "route"; id: string; label: string; sub: string; keywords: string[]; path: string; icon: string }
  | { kind: "op"; id: string; label: string; sub: string; keywords: string[]; opIndex: number; icon: string }
  | { kind: "ask"; id: string; label: string; sub: string; keywords: string[]; query: string; icon: string };

function buildItems(): Item[] {
  const routes: Item[] = NAV_ROUTES.map((r) => ({
    kind: "route",
    id: `route:${r.path}`,
    label: r.label,
    sub: `${r.group} · ${r.hint}`,
    keywords: [...r.keywords, r.label.toLowerCase()],
    path: r.path,
    icon: r.icon,
  }));
  const ops: Item[] = OP_CATALOG.map((o, i) => ({
    kind: "op",
    id: `op:${o.kind}`,
    label: o.title,
    sub: `${o.category} · ${o.sub}`,
    keywords: [
      o.category,
      o.kind,
      ...(o.keywords ?? []),
      o.title.toLowerCase(),
    ],
    opIndex: i,
    icon: o.icon ?? "OP",
  }));
  const ask: Item[] = ASK_QUERIES.map((s, i) => ({
    kind: "ask",
    id: `ask:${i}`,
    label: s.label,
    sub: s.query,
    keywords: s.keywords,
    query: s.query,
    icon: "ASK",
  }));
  return [...routes, ...ops, ...ask];
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const ops = useOps();
  const [search, setSearch] = useState("");
  const items = buildItems();

  // Reset search when the palette closes so the next open starts fresh.
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const select = (item: Item) => {
    onOpenChange(false);
    if (item.kind === "route") {
      navigate(item.path);
      return;
    }
    if (item.kind === "op") {
      const verb = OP_CATALOG[item.opIndex];
      if (!verb) return;
      ops.requestOp({
        kind: verb.kind,
        title: verb.title,
        sub: verb.sub,
        intro: verb.intro,
        fields: verb.fields,
        effects: verb.effects,
        diff: verb.diff,
        icon: verb.icon,
        risk: verb.risk,
        destructive: verb.destructive,
        needsPasskey: verb.needsPasskey,
        confirmLabel: verb.confirmLabel,
      });
      return;
    }
    if (item.kind === "ask") {
      window.dispatchEvent(new CustomEvent("monarch:ask", { detail: item.query }));
    }
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      contentClassName="cmdk-content"
      overlayClassName="cmdk-overlay"
      shouldFilter
      loop
    >
      <Command.Input
        value={search}
        onValueChange={setSearch}
        placeholder="Search, jump, run, ask…"
        className="cmdk-input"
      />
      <Command.List className="cmdk-list">
        <Command.Empty className="cmdk-empty">No matches.</Command.Empty>

        <Command.Group heading="Navigate" className="cmdk-group">
          {items
            .filter((i) => i.kind === "route")
            .map((i) => (
              <Command.Item
                key={i.id}
                value={`${i.label} ${i.keywords.join(" ")}`}
                onSelect={() => select(i)}
                className="cmdk-item"
              >
                <span className="cmdk-item__icon">{i.icon}</span>
                <span className="cmdk-item__label">{i.label}</span>
                <span className="cmdk-item__sub">{i.sub}</span>
              </Command.Item>
            ))}
        </Command.Group>

        <Command.Group heading="Operations" className="cmdk-group">
          {items
            .filter((i) => i.kind === "op")
            .map((i) => (
              <Command.Item
                key={i.id}
                value={`${i.label} ${i.keywords.join(" ")}`}
                onSelect={() => select(i)}
                className="cmdk-item"
              >
                <span className="cmdk-item__icon">{i.icon}</span>
                <span className="cmdk-item__label">{i.label}</span>
                <span className="cmdk-item__sub">{i.sub}</span>
              </Command.Item>
            ))}
        </Command.Group>

        <Command.Group heading="Ask Monarch" className="cmdk-group">
          {items
            .filter((i) => i.kind === "ask")
            .map((i) => (
              <Command.Item
                key={i.id}
                value={`${i.label} ${i.keywords.join(" ")}`}
                onSelect={() => select(i)}
                className="cmdk-item"
              >
                <span className="cmdk-item__icon">{i.icon}</span>
                <span className="cmdk-item__label">{i.label}</span>
                <span className="cmdk-item__sub">{i.sub}</span>
              </Command.Item>
            ))}
        </Command.Group>
      </Command.List>
      <div className="cmdk-foot">
        <span className="mono">↑↓ navigate</span>
        <span className="mono">↵ select</span>
        <span className="mono">esc close</span>
      </div>
    </Command.Dialog>
  );
}

/** Total commands surfaced (used for telemetry / smoke checks). */
export const COMMAND_COUNT =
  NAV_ROUTES.length + OP_CATALOG.length + ASK_QUERIES.length;
