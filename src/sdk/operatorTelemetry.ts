import type {
  OperatorRiskResponse,
  OperatorSigningActivityResponse,
  OperatorSigningEntry,
} from "@monolythium/core-sdk";

export type OperatorRiskTone = "ok" | "warn" | "err" | "info";

export type OperatorRiskView = {
  tone: OperatorRiskTone;
  label: string;
  fillPct: number;
  thresholdPct: number;
  detail: string;
};

export type SigningActivityView = {
  observed: number;
  signed: number;
  missed: number;
  noCert: number;
  signedPct: number | null;
  signedPctLabel: string;
  entries: OperatorSigningEntry[];
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function jailLabel(risk: OperatorRiskResponse): string | null {
  if ("reason" in risk.jailStatus) return null;
  if (risk.jailStatus.tombstoned) return "tombstoned";
  if (risk.jailStatus.jailed) return "jailed";
  return null;
}

export function operatorRiskView(
  risk: OperatorRiskResponse | null | undefined,
  fallbackJailed = false,
): OperatorRiskView {
  if (!risk) {
    return fallbackJailed
      ? {
          tone: "err",
          label: "action needed",
          fillPct: 100,
          thresholdPct: 5,
          detail: "operator lifecycle reports removal state; risk window is unavailable",
        }
      : {
          tone: "info",
          label: "pending",
          fillPct: 0,
          thresholdPct: 5,
          detail: "operator risk window is loading",
        };
  }

  const thresholdPct = clampPercent(risk.thresholdBps / 100);
  const fillPct = clampPercent(risk.missRateBps / 100);
  const jailed = jailLabel(risk);
  const tone: OperatorRiskTone = jailed
    ? "err"
    : risk.missRateBps >= risk.thresholdBps
      ? "err"
      : risk.remainingHeadroomBps <= Math.max(100, Math.floor(risk.thresholdBps / 3))
        ? "warn"
        : "ok";
  const label = jailed
    ? jailed
    : tone === "err"
      ? "at threshold"
      : tone === "warn"
        ? "watch"
        : "low";
  const reason = risk.reasons.length > 0 ? ` · ${risk.reasons.join(", ")}` : "";
  return {
    tone,
    label,
    fillPct,
    thresholdPct,
    detail:
      `${risk.missedRounds}/${risk.observedRounds} missed rounds ` +
      `(${(risk.missRateBps / 100).toFixed(2)}%, threshold ${(risk.thresholdBps / 100).toFixed(2)}%)` +
      reason,
  };
}

export function signingActivityView(
  activity: OperatorSigningActivityResponse | null | undefined,
): SigningActivityView {
  const entries = activity?.entries ?? [];
  const signed = entries.filter((entry) => entry.status === "signed").length;
  const missed = entries.filter((entry) => entry.status === "missed").length;
  const noCert = entries.filter((entry) => entry.status === "no_cert").length;
  const observed = entries.length;
  const signedPct = observed > 0 ? (signed / observed) * 100 : null;
  return {
    observed,
    signed,
    missed,
    noCert,
    signedPct,
    signedPctLabel: signedPct === null ? "—" : `${signedPct.toFixed(1)}%`,
    entries,
  };
}
