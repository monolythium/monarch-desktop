import type { ClusterResignationRow } from "@monolythium/core-sdk";

export type ClusterResignationSummary = {
  total: number;
  pending: number;
  wirePending: number;
  applied: number;
  expedited: number;
};

export type ClusterResignationTone = "ok" | "warn" | "info";

export function clusterResignationSummary(
  rows: readonly ClusterResignationRow[] | null | undefined,
): ClusterResignationSummary {
  const safeRows = rows ?? [];
  return {
    total: safeRows.length,
    pending: safeRows.filter((row) => row.status === "pending").length,
    wirePending: safeRows.filter((row) => row.status === "wire_pending").length,
    applied: safeRows.filter((row) => row.status === "applied").length,
    expedited: safeRows.filter((row) => row.expedited).length,
  };
}

export function resignationStatusTone(status: string): ClusterResignationTone {
  switch (status) {
    case "applied":
      return "ok";
    case "wire_pending":
      return "info";
    default:
      return "warn";
  }
}

export function formatResignationHeight(
  value: bigint | number | string | undefined,
): string {
  if (value === undefined) return "not submitted";
  try {
    return BigInt(value).toLocaleString();
  } catch {
    return "not submitted";
  }
}
