// Service-reward EARNINGS rollup — the pure view-model behind the Operator
// view's earnings panel.
//
// THE MODEL: stake sets RANK only. A cluster's block-reward weight is its
// settled per-cluster ServiceScore — the `u64` the reward path reads each
// block (node-registry Component A) — NOT its bonded stake. Rewards come
// from the services a cluster PROVES, scored on-chain across these families:
//
//   * base       — consensus signing (the floor every active cluster proves)
//   * archive    — historical-shard custody, proven by serve-challenge (Component B)
//   * prover     — GPU proving for the prover market (MB-4)
//   * rpc        — public RPC serving
//   * indexer    — projection / indexer serving
//   * diversity  — roster ASN/geo/hosting spread (PF-6), the one family the
//                  chain exposes as its own scored breakdown
//
// This module is deliberately HONEST: the chain settles the families into a
// single `ServiceScore` and does not expose a per-family numeric split, so
// we do NOT invent per-family sub-scores. We surface the live settled score
// (the headline) plus the live signals we CAN read per family — the
// diversity sub-breakdown (live bps), and whether each family is being
// served — and label everything else as "scored on-chain" rather than
// fabricating a value. Every input is read live; nothing is mocked.

import type { ActiveCharterView, ClusterDiversityView } from "@monolythium/core-sdk";

/** A scored service family the per-cluster ServiceScore folds together. */
export type ServiceFamilyKey =
  | "base"
  | "archive"
  | "prover"
  | "rpc"
  | "indexer"
  | "diversity";

export type ServiceFamilyStatus = "active" | "available" | "scored" | "unknown";

export type ServiceFamilyRow = {
  key: ServiceFamilyKey;
  label: string;
  /** Plain-language description of the proved service this family scores. */
  blurb: string;
  status: ServiceFamilyStatus;
  /** A live, honestly-read detail for the family (e.g. the diversity %); never fabricated. */
  detail: string;
};

export type EarningsSplit = {
  /** `true` once the cluster has adopted an explicit economics charter. */
  present: boolean;
  /** Operator-pot share of each block reward, in basis points (sum of seat shares = 10000 of the operator pot). */
  operatorShareBps: number;
  /** Delegator share of each block reward, in basis points. */
  delegatorShareBps: number;
};

export type ServiceRewardEarningsView = {
  /** The settled per-cluster ServiceScore (Component A) — the reward weight. */
  score: bigint | null;
  /** `true` when the score read came back `0n` (never scored), not an error. */
  scored: boolean;
  scoreLabel: string;
  families: ServiceFamilyRow[];
  split: EarningsSplit;
  /** One-line summary suitable for an aria-label / status line. */
  summary: string;
};

const FAMILY_META: Record<ServiceFamilyKey, { label: string; blurb: string }> = {
  base: {
    label: "Base · consensus signing",
    blurb: "The signing floor every active cluster proves each round.",
  },
  archive: {
    label: "Archive · shard custody",
    blurb: "Custody of historical shards, proven by random serve-challenge.",
  },
  prover: {
    label: "Prover · GPU proving",
    blurb: "Serving the GPU prover market — a direct per-operator service tier.",
  },
  rpc: {
    label: "RPC · public serving",
    blurb: "Answering public RPC traffic for the network.",
  },
  indexer: {
    label: "Indexer · projections",
    blurb: "Serving indexer / projection queries for explorers and wallets.",
  },
  diversity: {
    label: "Diversity · roster spread",
    blurb: "ASN, geographic, and hosting spread across the cluster's operators.",
  },
};

const FAMILY_ORDER: ServiceFamilyKey[] = [
  "base",
  "archive",
  "prover",
  "rpc",
  "indexer",
  "diversity",
];

/** Format a `0..=10000` basis-points value as a percent string. */
function bps(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value / 100).toFixed(1)}%`;
}

/** Sum the per-seat operator-pot shares into a single operator-pot bps. */
export function sumMemberShareBps(memberShareBps: readonly number[]): number {
  return memberShareBps.reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);
}

/** Live signals the rollup folds in, read straight from the chain. */
export type ServiceRewardEarningsInputs = {
  /** Settled per-cluster ServiceScore (`bigint`), or `null` when the read is unavailable. */
  score: bigint | null;
  /** Live diversity view (PF-6), or `null` when the read is gated/unavailable. */
  diversity: ClusterDiversityView | null;
  /** Whether this cluster is actively serving the GPU prover market (live prover-market signal). */
  proverActive: boolean;
  /** Active economics charter (operator/delegator split), or `null` when unread/legacy default. */
  charter: ActiveCharterView | null;
};

/**
 * Build the read-only earnings rollup from live reads. Pure: every field is
 * derived from the passed-in live values — no fixtures, no fabricated
 * per-family numbers. Families with a real live signal (diversity %, prover
 * active) report it; the rest are labelled "scored on-chain".
 */
export function serviceRewardEarningsView(
  inputs: ServiceRewardEarningsInputs,
): ServiceRewardEarningsView {
  const { score, diversity, proverActive, charter } = inputs;

  const scored = score !== null && score > 0n;
  const scoreLabel = score === null ? "—" : score.toString();

  const families: ServiceFamilyRow[] = FAMILY_ORDER.map((key) => {
    const meta = FAMILY_META[key];
    if (key === "diversity") {
      const detail = diversity
        ? `${bps(diversity.score)} spread · ASN ${bps(diversity.asnVariance)} · geo ${bps(
            diversity.geoVariance,
          )} · hosting ${bps(diversity.hostingSpread)}`
        : "diversity data unavailable";
      return {
        key,
        label: meta.label,
        blurb: meta.blurb,
        status: diversity ? "active" : "unknown",
        detail,
      };
    }
    if (key === "prover") {
      return {
        key,
        label: meta.label,
        blurb: meta.blurb,
        status: proverActive ? "active" : "available",
        detail: proverActive
          ? "serving the prover market"
          : "available when the cluster opts in",
      };
    }
    if (key === "base") {
      return {
        key,
        label: meta.label,
        blurb: meta.blurb,
        status: "active",
        detail: "proven every round by signing activity",
      };
    }
    // archive / rpc / indexer: the chain folds these into the settled score
    // but does not expose a per-family number; report honestly.
    return {
      key,
      label: meta.label,
      blurb: meta.blurb,
      status: "scored",
      detail: "scored on-chain from this cluster's service proofs",
    };
  });

  const split: EarningsSplit = charter && charter.present
    ? {
        present: true,
        operatorShareBps: sumMemberShareBps(charter.memberShareBps),
        delegatorShareBps: charter.delegatorShareBps,
      }
    : { present: false, operatorShareBps: 0, delegatorShareBps: 0 };

  const summary = scored
    ? `Your cluster's reward weight is its settled ServiceScore (${scoreLabel}) — earned from proved service, not stake.`
    : score === null
      ? "ServiceScore read is unavailable on this endpoint."
      : "Your cluster has not been scored yet — rewards track proved service, not stake.";

  return { score, scored, scoreLabel, families, split, summary };
}
