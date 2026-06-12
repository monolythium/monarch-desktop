// Shared charter-share model — the pure bits the charter EDITOR uses,
// factored out so the cluster-FORMATION editor (Ceremony Room) and the
// live-cluster charter-AMENDMENT editor (Charter panel) render the same
// 10-row share grid, the same %/sum logic, and the same client-side
// guardrails without duplicating any of it.
//
// A charter splits each block reward's cluster pot two ways:
//
//   1. the delegator share (basis points, protocol floor 2000 = 20%) goes
//      to the ARK delegators who staked behind the cluster;
//   2. the remaining operator pot is split across the 10 member seats
//      (7 active + 3 standby) by the ten member shares, which MUST sum to
//      exactly 10000 bps among themselves.
//
// The member-share denominator is independent of the delegator share —
// the ten member shares are a partition of the OPERATOR pot, not of the
// whole reward. See mono-core `cluster_form::decode_cluster_charter`.

import {
  FORM_CLUSTER_ACTIVE_COUNT,
  FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS,
  FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS,
  FORM_CLUSTER_MEMBER_COUNT,
  FORM_CLUSTER_STANDBY_COUNT,
} from "./clusterFormOps";

export {
  FORM_CLUSTER_ACTIVE_COUNT,
  FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS,
  FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS,
  FORM_CLUSTER_MEMBER_COUNT,
  FORM_CLUSTER_STANDBY_COUNT,
};

/** Equal default member share (1000 bps each across 10 seats = 10000). */
export const CHARTER_DEFAULT_MEMBER_SHARE_BPS =
  FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS / FORM_CLUSTER_MEMBER_COUNT;
/** Default delegator share (50%) — the legacy split, well above the floor. */
export const CHARTER_DEFAULT_DELEGATOR_SHARE_BPS = 5000;

/** Member-declaration-order seat label: members 0..6 = active, 7..9 = standby. */
export function charterSeatLabel(memberIndex: number): string {
  return memberIndex < FORM_CLUSTER_ACTIVE_COUNT
    ? `active ${memberIndex + 1}`
    : `standby ${memberIndex - FORM_CLUSTER_ACTIVE_COUNT + 1}`;
}

/** Render a basis-point value as a percentage string (`1234` → `"12.3%"`). */
export function bpsToPct(bps: number, digits = 1): string {
  return `${(bps / 100).toFixed(digits)}%`;
}

/** Equal-split member shares as the editor's initial string rows. */
export function defaultMemberShareStrings(): string[] {
  return Array.from({ length: FORM_CLUSTER_MEMBER_COUNT }, () =>
    String(CHARTER_DEFAULT_MEMBER_SHARE_BPS),
  );
}

/** Decoded charter member shares (numbers) → editor string rows. */
export function memberShareStringsFrom(memberShareBps: readonly number[]): string[] {
  return Array.from({ length: FORM_CLUSTER_MEMBER_COUNT }, (_, index) =>
    String(memberShareBps[index] ?? 0),
  );
}

/** Sum of the editor's member-share rows, or `NaN` if any row is not a
 *  non-negative integer. Pure — drives the live "= X / 10000" indicator. */
export function memberShareSum(rows: readonly string[]): number {
  return rows.reduce((sum, raw) => {
    const bps = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(bps) && bps >= 0 ? sum + bps : Number.NaN;
  }, 0);
}

/** Whether the member-share rows sum to exactly the 10000-bps denominator. */
export function memberShareSumIsExact(rows: readonly string[]): boolean {
  return memberShareSum(rows) === FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS;
}

export type CharterDraftErrorCode =
  | "share-count"
  | "share-range"
  | "share-sum"
  | "delegator-floor"
  | "delegator-ceiling";

export class CharterDraftError extends Error {
  readonly code: CharterDraftErrorCode;
  constructor(code: CharterDraftErrorCode, message: string) {
    super(message);
    this.name = "CharterDraftError";
    this.code = code;
  }
}

export type CharterDraft = {
  /** Ten member shares (bps), member-declaration order. Sum = 10000. */
  memberShareBps: number[];
  /** Delegator share (bps), in [2000, 10000]. */
  delegatorShareBps: number;
};

/** Parse + validate the editor's draft inputs into a charter draft,
 *  applying the SAME guardrails the chain enforces: exactly 10 member
 *  shares, each a whole number in [0, 10000], summing to exactly 10000;
 *  and a delegator share within the protocol floor/ceiling band. Throws a
 *  `CharterDraftError` with a stable `code` per violation so a draft the
 *  chain would reject never reaches a signing flow. */
export function validateCharterDraft(args: {
  memberShareRows: readonly string[];
  delegatorShareBps: number;
}): CharterDraft {
  if (args.memberShareRows.length !== FORM_CLUSTER_MEMBER_COUNT) {
    throw new CharterDraftError(
      "share-count",
      `expected exactly ${FORM_CLUSTER_MEMBER_COUNT} member shares, got ${args.memberShareRows.length}`,
    );
  }
  const memberShareBps = args.memberShareRows.map((raw) => Number.parseInt(raw.trim(), 10));
  if (
    memberShareBps.some(
      (bps) =>
        !Number.isInteger(bps) || bps < 0 || bps > FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS,
    )
  ) {
    throw new CharterDraftError(
      "share-range",
      `member shares must be whole numbers between 0 and ${FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS} bps`,
    );
  }
  const sum = memberShareBps.reduce((acc, bps) => acc + bps, 0);
  if (sum !== FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS) {
    throw new CharterDraftError(
      "share-sum",
      `member shares must sum to exactly ${FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS} bps — currently ${sum}`,
    );
  }
  if (
    !Number.isInteger(args.delegatorShareBps) ||
    args.delegatorShareBps < FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS
  ) {
    throw new CharterDraftError(
      "delegator-floor",
      `delegator share must be at least the protocol floor of ${FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS} bps (${bpsToPct(FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS, 0)})`,
    );
  }
  if (args.delegatorShareBps > FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS) {
    throw new CharterDraftError(
      "delegator-ceiling",
      `delegator share cannot exceed ${FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS} bps (100%)`,
    );
  }
  return { memberShareBps, delegatorShareBps: args.delegatorShareBps };
}
