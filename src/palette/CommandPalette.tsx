// ⌘K command palette. Opens on Cmd+K (or Ctrl+K on Linux/Windows) and
// fuzzy-searches across:
//
//   - every nav route (jumps via react-router)
//   - every Operations verb (invokes `requestOp` so the keychain-bound
//     drawer state machine handles it like a manual click)
//   - starter Ask Monarch queries (opens the live advisory rail)
//   - a live "Chain" group: the input is debounced against
//     lyth_resolveName / lyth_operatorInfo / lyth_search, plus copy
//     actions for the operator address and the RPC endpoint
//
// Items are MRU-ranked: selections are recorded in localStorage and the
// most recently used commands float to the top (plus a "Recent" group
// when the input is empty). Built on `cmdk` (lightweight, hooks-only).
// The dialog lives at the app root via `<CommandPalette />` in App.tsx.

import { Command } from "cmdk";
import { Title as DialogTitle } from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { NAV_ROUTES } from "../nav/routes";
import { OP_CATALOG, useOps } from "../ops";
import { rpc, rpcEndpoint } from "../sdk/client";
import { useSelfOperator } from "../hooks/useSelfOperator";
import "../styles/livedata.css";

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
  | { kind: "ask"; id: string; label: string; sub: string; keywords: string[]; query: string; icon: string }
  | { kind: "copy"; id: string; label: string; sub: string; keywords: string[]; text: string; icon: string };

type ChainHit = {
  id: string;
  label: string;
  sub: string;
  copyText: string;
};

// ---- MRU ranking (localStorage) ---------------------------------------

const MRU_KEY = "monarch.paletteMru.v1";
const MRU_MAX = 50;

type MruMap = Record<string, { at: number; count: number }>;

export function readPaletteMru(): MruMap {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MRU_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as MruMap) : {};
  } catch {
    return {};
  }
}

export function recordPaletteMru(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const mru = readPaletteMru();
    const prev = mru[id];
    mru[id] = { at: Date.now(), count: (prev?.count ?? 0) + 1 };
    // Trim to the newest MRU_MAX entries so the map never grows unbounded.
    const entries = Object.entries(mru)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MRU_MAX);
    window.localStorage.setItem(MRU_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Palette ranking is best-effort; storage may be unavailable.
  }
}

function sortByMru<T extends { id: string }>(items: T[], mru: MruMap): T[] {
  return [...items].sort((a, b) => (mru[b.id]?.at ?? 0) - (mru[a.id]?.at ?? 0));
}

// ---- live chain lookups ------------------------------------------------

const OPERATOR_ID_RE = /^(0x)?[0-9a-fA-F]{64}$/u;
const NAME_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/u;

function shortId(value: string): string {
  return value.length > 26 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

async function queryChain(input: string): Promise<ChainHit[]> {
  const q = input.trim();
  const hits: ChainHit[] = [];

  if (OPERATOR_ID_RE.test(q)) {
    const operatorId = q.startsWith("0x") ? q : `0x${q}`;
    try {
      const info = await rpc.lythOperatorInfo(operatorId);
      const display = info.moniker ?? info.alias ?? shortId(info.operatorId);
      hits.push({
        id: `chain:operator-address:${info.operatorId}`,
        label: `${display} — copy address`,
        sub: `operator · ${shortId(info.chainAddress)}`,
        copyText: info.chainAddress,
      });
      hits.push({
        id: `chain:operator-id:${info.operatorId}`,
        label: `${display} — copy operator id`,
        sub: `operator · ${shortId(info.operatorId)}`,
        copyText: info.operatorId,
      });
    } catch {
      // Unknown operator id — fall through to the generic search.
    }
  } else if (NAME_RE.test(q.toLowerCase())) {
    try {
      const resolved = await rpc.lythResolveName(q.toLowerCase());
      if (resolved.address) {
        hits.push({
          id: `chain:name:${resolved.name}`,
          label: `${resolved.name} → ${shortId(resolved.address)}`,
          sub: `${resolved.category} name · copy address`,
          copyText: resolved.address,
        });
      }
    } catch {
      // Name registry not exposed or name unregistered — skip.
    }
  }

  try {
    const res = await rpc.lythSearch(q, 5);
    for (const hit of res.hits) {
      hits.push({
        id: `chain:search:${hit.type}:${hit.id}`,
        label: `${hit.label} — copy id`,
        sub: `${hit.type} · ${shortId(hit.id)}`,
        copyText: hit.id,
      });
    }
  } catch {
    // lyth_search not exposed on this endpoint — name/operator hits stand alone.
  }

  // De-dupe by id, keep first occurrence.
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.id)) return false;
    seen.add(hit.id);
    return true;
  }).slice(0, 6);
}

// -------------------------------------------------------------------------

function buildItems(selfAddress: string | null, selfOperatorId: string | null): Item[] {
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
  const copies: Item[] = [
    {
      kind: "copy",
      id: "copy:rpc-endpoint",
      label: "Copy RPC endpoint",
      sub: rpcEndpoint,
      keywords: ["copy", "rpc", "endpoint", "node", "url"],
      text: rpcEndpoint,
      icon: "CP",
    },
  ];
  if (selfAddress) {
    copies.push({
      kind: "copy",
      id: "copy:operator-address",
      label: "Copy your operator address",
      sub: selfAddress,
      keywords: ["copy", "operator", "address", "wallet", "mono1"],
      text: selfAddress,
      icon: "CP",
    });
  }
  if (selfOperatorId) {
    copies.push({
      kind: "copy",
      id: "copy:operator-id",
      label: "Copy your operator id",
      sub: shortId(selfOperatorId),
      keywords: ["copy", "operator", "id", "peer"],
      text: selfOperatorId,
      icon: "CP",
    });
  }
  return [...routes, ...ops, ...ask, ...copies];
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
  const self = useSelfOperator();
  const [search, setSearch] = useState("");
  const [mru, setMru] = useState<MruMap>(() => readPaletteMru());
  const [chainHits, setChainHits] = useState<ChainHit[]>([]);

  const items = useMemo(
    () => buildItems(self.address, self.operatorId),
    [self.address, self.operatorId],
  );

  // Reset search when the palette closes; re-read MRU when it opens so
  // ranking reflects selections made elsewhere (e.g. another window).
  useEffect(() => {
    if (!open) {
      setSearch("");
      setChainHits([]);
    } else {
      setMru(readPaletteMru());
    }
  }, [open]);

  // Debounced live chain lookups against the typed input.
  useEffect(() => {
    if (!open || search.trim().length < 2) {
      setChainHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void queryChain(search).then((hits) => {
        if (!cancelled) setChainHits(hits);
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search, open]);

  const recordUse = (id: string) => {
    recordPaletteMru(id);
    setMru(readPaletteMru());
  };

  const select = (item: Item) => {
    recordUse(item.id);
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
      return;
    }
    void navigator.clipboard?.writeText(item.text);
  };

  const selectChainHit = (hit: ChainHit) => {
    recordUse(hit.id);
    onOpenChange(false);
    void navigator.clipboard?.writeText(hit.copyText);
  };

  const ranked = sortByMru(items, mru);
  const recent = search.trim().length === 0
    ? ranked.filter((i) => mru[i.id]).slice(0, 5)
    : [];

  const renderItem = (i: Item) => (
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
  );

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
      <DialogTitle className="sr-only">Command palette</DialogTitle>
      <Command.Input
        value={search}
        onValueChange={setSearch}
        placeholder="Search, jump, run, ask…"
        className="cmdk-input"
      />
      <Command.List className="cmdk-list">
        <Command.Empty className="cmdk-empty">No matches.</Command.Empty>

        {recent.length > 0 ? (
          <Command.Group heading="Recent" className="cmdk-group">
            {recent.map((i) => (
              <Command.Item
                key={`recent:${i.id}`}
                value={`recent ${i.label} ${i.keywords.join(" ")}`}
                onSelect={() => select(i)}
                className="cmdk-item"
              >
                <span className="cmdk-item__icon">{i.icon}</span>
                <span className="cmdk-item__label">{i.label}</span>
                <span className="cmdk-item__sub">{i.sub}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        <Command.Group heading="Navigate" className="cmdk-group">
          {ranked.filter((i) => i.kind === "route").map(renderItem)}
        </Command.Group>

        <Command.Group heading="Operations" className="cmdk-group">
          {ranked.filter((i) => i.kind === "op").map(renderItem)}
        </Command.Group>

        <Command.Group heading="Chain" className="cmdk-group">
          {/* Static copy actions rank like everything else… */}
          {ranked.filter((i) => i.kind === "copy").map(renderItem)}
          {/* …while live hits embed the raw query in their value so the
              cmdk filter never hides what the node just resolved. */}
          {chainHits.map((hit) => (
            <Command.Item
              key={hit.id}
              value={`${search} ${hit.label}`}
              onSelect={() => selectChainHit(hit)}
              className="cmdk-item"
            >
              <span className="cmdk-item__icon">CH</span>
              <span className="cmdk-item__label">{hit.label}</span>
              <span className="cmdk-item__sub">{hit.sub}</span>
            </Command.Item>
          ))}
        </Command.Group>

        <Command.Group heading="Ask Monarch" className="cmdk-group">
          {ranked.filter((i) => i.kind === "ask").map(renderItem)}
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
