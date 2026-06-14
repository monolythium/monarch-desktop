// Plain-English error translation for the Operations drawer.
//
// Every settleOperation failure path routes through `translateOpError`
// so the operator sees a one-line, jargon-free explanation plus a
// suggested next step, while the verbatim host/RPC message stays
// available in an expandable details row and in the local receipt.
//
// Pure and side-effect free — unit-tested in errors.test.ts.

import type { OpKind } from "./types";

export type TranslatedOpError = {
  /** Plain-English summary rendered in the drawer error halo. */
  friendly: string;
  /** Optional in-app route the drawer offers as a fix-it button. */
  nextStepRoute?: string;
  /** Label for the fix-it button (present iff nextStepRoute is). */
  nextStepLabel?: string;
  /** Verbatim underlying message, for the details row + receipt. */
  raw: string;
};

/** Recovery actions that are unavailable on standard operator installs. */
export const FOUNDATION_OP_KINDS: ReadonlySet<OpKind> = new Set<OpKind>([
  "operator-restore",
  "cluster-accept-invite",
  "cluster-swap",
  "freeze-admission",
  "emergency-key-rotation",
]);

/** Friendly copy for the "operator key missing from keychain" case. */
export const MISSING_OPERATOR_KEY_MESSAGE =
  "No operator key stored - save your 24-word operator mnemonic on the Keys page first.";

/** Friendly copy when a recovery action is unavailable on this install. */
export const MISSING_FOUNDATION_KEY_MESSAGE =
  "This recovery action is not available on this install.";

function rawMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function firstLine(text: string, max = 160): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? text.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

type ErrorRule = {
  test: RegExp;
  friendly: string | ((kind: OpKind) => string);
  nextStepRoute?: string;
  nextStepLabel?: string;
};

const RULES: ReadonlyArray<ErrorRule> = [
  {
    test: /foundation (operations|signer|recovery)?\s*mnemonic not in keychain|foundation:recovery-mnemonic|no foundation signer stored/i,
    friendly: MISSING_FOUNDATION_KEY_MESSAGE,
    nextStepRoute: "/keys",
    nextStepLabel: "Open Keys",
  },
  {
    test: /(operator|anchor)?\s*mnemonic not in keychain|operator:mnemonic|no stored operator mnemonic|no operator key stored/i,
    friendly: MISSING_OPERATOR_KEY_MESSAGE,
    nextStepRoute: "/keys",
    nextStepLabel: "Open Keys",
  },
  {
    test: /insufficient (funds|balance)|balance too low|not enough (funds|balance|lyth)/i,
    friendly:
      "Your operator wallet balance cannot cover this transaction. Fund your operator wallet address, then retry.",
    nextStepRoute: "/wallets",
    nextStepLabel: "Open Treasury",
  },
  {
    test: /already.?registered|duplicate registration|peer.?id.*exists/i,
    friendly:
      "This operator is already registered on-chain - a second register would be rejected. If you meant to update metadata, use Set operator name or Publish seal key instead.",
    nextStepRoute: "/operator",
    nextStepLabel: "Open Operator",
  },
  {
    test: /bond.*(minimum|below|too (low|small))|min(imum)?_?self_?bond|insufficientbond/i,
    friendly:
      "The bond is below the chain minimum (5,000 LYTH on testnet). Raise the bond amount and retry.",
  },
  {
    test: /seal\s*(ek|key).*(not|missing|unpublished)|publish.*seal.*(first|before)|missing seal/i,
    friendly:
      "Your public seal key is not published yet. Publish it from the Operator page, then retry the join.",
    nextStepRoute: "/operator",
    nextStepLabel: "Publish seal key",
  },
  {
    test: /nonce too low|invalid nonce|nonce.*(stale|reused|not greater)/i,
    friendly:
      "The nonce was not accepted - it must be strictly greater than the last accepted one. Bump the nonce and retry.",
  },
  {
    test: /method not found|not yet exposed|-32601|unknown method/i,
    friendly:
      "The connected node does not expose this method yet. Update protocore on the node, or point Monarch at a newer endpoint.",
    nextStepRoute: "/install",
    nextStepLabel: "Check node pairing",
  },
  {
    test: /unknown selector|unsupported selector|selector not/i,
    friendly:
      "The connected chain runtime does not support this operation yet. Nothing was signed or broadcast.",
  },
  {
    test: /not (an? )?(cluster )?member|notclustermember|caller.*not.*(roster|member)/i,
    friendly:
      "Your operator key is not a member of this cluster, so the chain rejected the call.",
    nextStepRoute: "/cluster",
    nextStepLabel: "Open Cluster",
  },
  {
    test: /execution reverted|revert(ed)?\b|preflight.*(fail|reject)/i,
    friendly:
      "The chain rejected this transaction during preflight - the inputs do not satisfy the on-chain rules. Review the details below and the form values.",
  },
  {
    test: /fetch failed|failed to fetch|econnrefused|connection refused|network error|timed? ?out|unreachable|socket/i,
    friendly:
      "Could not reach the node. Check that it is running and that the RPC endpoint is correct.",
    nextStepRoute: "/install",
    nextStepLabel: "Check node pairing",
  },
  {
    test: /no active ssh session|running outside tauri|requires monarch desktop|browser preview/i,
    friendly:
      "This action needs Monarch Desktop with a connected node control channel.",
  },
  {
    test: /keychain/i,
    friendly:
      "The OS keychain rejected the request. Re-open the Keys page and confirm the stored credentials.",
    nextStepRoute: "/keys",
    nextStepLabel: "Open Keys",
  },
];

/**
 * Map a raw error from any settleOperation path to plain English plus
 * an optional fix-it route. The raw message is always preserved.
 */
export function translateOpError(err: unknown, kind: OpKind): TranslatedOpError {
  const raw = rawMessage(err);

  for (const rule of RULES) {
    if (rule.test.test(raw)) {
      return {
        friendly:
          typeof rule.friendly === "function" ? rule.friendly(kind) : rule.friendly,
        nextStepRoute: rule.nextStepRoute,
        nextStepLabel: rule.nextStepLabel,
        raw,
      };
    }
  }

  return {
    friendly: `The operation failed: ${firstLine(raw)}`,
    raw,
  };
}
