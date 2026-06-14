import type { ClusterStatus } from "./hooks";

export const MONARCH_TARGET_CLUSTER_COUNT = 100;
export const MONARCH_CLUSTER_SIZE = 10;
export const MONARCH_CLUSTER_THRESHOLD = 7;
export const MONARCH_ACTIVE_OPERATOR_SEATS = 7;
export const MONARCH_STANDBY_OPERATOR_SEATS = 3;
export const MONARCH_TARGET_OPERATOR_POSITIONS =
  MONARCH_TARGET_CLUSTER_COUNT * MONARCH_CLUSTER_SIZE;
export const MONARCH_TARGET_ACTIVE_OPERATOR_SEATS =
  MONARCH_TARGET_CLUSTER_COUNT * MONARCH_ACTIVE_OPERATOR_SEATS;
export const MONARCH_TARGET_STANDBY_OPERATOR_SEATS =
  MONARCH_TARGET_CLUSTER_COUNT * MONARCH_STANDBY_OPERATOR_SEATS;

export const DEFAULT_ACTIVE_CLUSTER_ID = 0;

export type ClusterModelState = "unknown" | "aligned" | "partial" | "degraded";

export type ClusterModelReport = {
  state: ClusterModelState;
  label: string;
  targetSummary: string;
  thresholdSummary: string;
  seatSummary: string;
  liveOperators: number;
  offlineOperators: number;
  standbySeats: number;
  blockers: string[];
};

export function clusterLabel(clusterId: number | null | undefined): string {
  if (clusterId === null || clusterId === undefined || !Number.isFinite(clusterId)) {
    return "C---";
  }
  return `C-${String(Math.trunc(clusterId)).padStart(3, "0")}`;
}

export function targetClusterSummary(clusterCount: number | null | undefined): string {
  const observed =
    clusterCount !== null && clusterCount !== undefined && Number.isFinite(clusterCount)
      ? Math.trunc(clusterCount)
      : null;
  const prefix = observed === null ? `${MONARCH_TARGET_CLUSTER_COUNT}` : `${observed}/${MONARCH_TARGET_CLUSTER_COUNT}`;
  return `${prefix} clusters x ${MONARCH_CLUSTER_SIZE} operator seats`;
}

export function evaluateClusterModel(
  cluster: Pick<ClusterStatus, "size" | "threshold" | "members"> | null | undefined,
  clusterCount?: number | null,
): ClusterModelReport {
  const targetSummary = targetClusterSummary(clusterCount);
  const thresholdSummary = `${MONARCH_CLUSTER_THRESHOLD}-of-${MONARCH_CLUSTER_SIZE} threshold`;
  const seatSummary = `${MONARCH_ACTIVE_OPERATOR_SEATS} active + ${MONARCH_STANDBY_OPERATOR_SEATS} standby`;

  if (!cluster) {
    return {
      state: "unknown",
      label: "awaiting cluster status",
      targetSummary,
      thresholdSummary,
      seatSummary,
      liveOperators: 0,
      offlineOperators: 0,
      standbySeats: MONARCH_STANDBY_OPERATOR_SEATS,
      blockers: ["live cluster status unavailable"],
    };
  }

  const liveOperators = cluster.members.filter((m) => m.state !== "jail").length;
  const offlineOperators = Math.max(cluster.size - liveOperators, 0);
  const standbySeats = Math.max(cluster.size - cluster.threshold, 0);
  const blockers: string[] = [];

  if (cluster.size !== MONARCH_CLUSTER_SIZE) {
    blockers.push(`expected ${MONARCH_CLUSTER_SIZE} operator seats`);
  }
  if (cluster.threshold !== MONARCH_CLUSTER_THRESHOLD) {
    blockers.push(`expected ${MONARCH_CLUSTER_THRESHOLD}-of-${MONARCH_CLUSTER_SIZE} threshold`);
  }
  if (standbySeats !== MONARCH_STANDBY_OPERATOR_SEATS) {
    blockers.push(`expected ${MONARCH_STANDBY_OPERATOR_SEATS} standby seats`);
  }
  if (liveOperators < cluster.threshold) {
    blockers.push("live operators below cluster threshold");
  }

  const topologyAligned =
    cluster.size === MONARCH_CLUSTER_SIZE &&
    cluster.threshold === MONARCH_CLUSTER_THRESHOLD &&
    standbySeats === MONARCH_STANDBY_OPERATOR_SEATS;
  const state: ClusterModelState =
    liveOperators < cluster.threshold
      ? "degraded"
      : topologyAligned
        ? "aligned"
        : "partial";

  return {
    state,
    label:
      state === "aligned"
        ? "whitepaper topology"
        : state === "degraded"
          ? "below threshold"
          : "topology drift",
    targetSummary,
    thresholdSummary,
    seatSummary,
    liveOperators,
    offlineOperators,
    standbySeats,
    blockers,
  };
}
