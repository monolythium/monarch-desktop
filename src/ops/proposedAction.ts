// Bridge between the advisory bridge's `ProposedAction` payload
// and the Operations drawer's `OpRequest`. The Rust side already
// validates that `kind` is one of the known `OpKind` values; this
// module narrows the type for the TS side and applies sensible
// defaults so the drawer always lands in `preview` (never `executing`).
//
// Important: this helper does NOT call `requestOp`. It only shapes
// the payload. The Ask rail is the only caller and the only place
// that ever opens the drawer — keeping the side-effect surface
// localized is what makes the "every action through the drawer" rule
// trivially auditable.

import type { ProposedAction } from "../sdk";
import { OP_KINDS, type OpKind, type OpRequest } from "./types";

const KNOWN_KINDS: ReadonlySet<OpKind> = new Set<OpKind>(OP_KINDS);

function normalizeKind(kind: string): OpKind | null {
  return KNOWN_KINDS.has(kind as OpKind) ? (kind as OpKind) : null;
}

function findFieldValue(
  fields: ProposedAction["fields"],
  names: readonly string[],
): string | null {
  for (const field of fields ?? []) {
    const key = field.key.trim().toLowerCase();
    const label = field.label.trim().toLowerCase();
    if (names.includes(key) || names.includes(label)) {
      return field.value;
    }
  }
  return null;
}

/**
 * Turn a model-proposed action into a drawer `OpRequest`. Returns
 * `null` if the kind isn't one we know about — the Rust parser already
 * filters this, but the runtime check here is the second line of
 * defense (e.g. when a future model emits a kind that hasn't shipped
 * to the React side yet).
 */
export function proposedActionToOpRequest(
  action: ProposedAction,
  source: { query: string; provider: string; model: string },
): OpRequest | null {
  const kind = normalizeKind(action.kind);
  if (!kind) {
    return null;
  }
  // Always inject a "Source" + "Query" pair so the drawer's preview
  // shows the operator the human prompt that produced this request.
  // Model-provided fields stack on top.
  const fields = [
    { key: "source", label: "Source", value: `Ask Monarch · ${action.title}` },
    { key: "query", label: "Query", value: source.query },
    {
      key: "model",
      label: "Model",
      value: `${source.provider} · ${source.model}`,
    },
    ...(action.fields ?? []),
  ];

  const req: OpRequest = {
    kind,
    title: action.title,
    sub: action.sub,
    intro: action.intro,
    fields,
    icon: "ASK",
    risk: action.destructive ? "high" : "low",
    destructive: action.destructive ?? false,
    needsPasskey: action.needsPasskey ?? false,
  };
  if (kind === "ota-apply") {
    req.otaApplyInput = {
      image: findFieldValue(action.fields, ["image", "upgrade image", "signed image"]) ?? "",
      stage: false,
      rebootMode: "default",
    };
  }
  return req;
}
