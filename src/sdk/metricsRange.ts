import type {
  MetricsRangeResponse,
  MetricsRangeSample,
  MetricsRangeSeries,
} from "@monolythium/core-sdk";

export const MONARCH_METRIC_SELECTORS = [
  "committed_round",
  "mempool_depth",
  "execution_units_used_per_block",
  "proposer_latency",
  "attestation_rate",
  "p2p_bandwidth_in",
  "p2p_bandwidth_out",
  "finality_lag",
] as const;

export type MonarchMetricSelector = (typeof MONARCH_METRIC_SELECTORS)[number];

export type MetricSeriesSummary = {
  selector: string;
  label: string;
  status: string;
  unit: string;
  latestValue: string;
  latestRawValue: number | null;
  latestBlock: number | null;
  sampleCount: number;
  delta: string;
  tone: "ok" | "warn" | "info";
  sparkline: number[];
};

const METRIC_LABELS: Record<MonarchMetricSelector, string> = {
  committed_round: "Committed round",
  mempool_depth: "Mempool depth",
  execution_units_used_per_block: "Execution units",
  proposer_latency: "Proposer latency",
  attestation_rate: "Attestation rate",
  p2p_bandwidth_in: "P2P ingress",
  p2p_bandwidth_out: "P2P egress",
  finality_lag: "Finality lag",
};

export function metricLabel(selector: string): string {
  return METRIC_LABELS[selector as MonarchMetricSelector] ?? selector.replace(/_/g, " ");
}

export function metricUnitLabel(unit: string | null | undefined): string {
  switch (unit) {
    case "basis_points":
      return "%";
    case "bytes_per_second":
      return "B/s";
    case "execution_units":
      return "EU";
    case "round":
      return "round";
    case "blocks":
      return "blocks";
    case "count":
      return "count";
    case "ms":
      return "ms";
    default:
      return unit ?? "";
  }
}

export function latestMetricSample(
  series: Pick<MetricsRangeSeries, "samples"> | null | undefined,
): MetricsRangeSample | null {
  const samples = series?.samples ?? [];
  return samples.length > 0 ? samples[samples.length - 1]! : null;
}

export function formatMetricValue(
  value: number | null | undefined,
  unit: string | null | undefined,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  if (unit === "basis_points") return `${(value / 100).toFixed(1)}%`;
  if (unit === "bytes_per_second") return formatBytesPerSecond(value);
  if (unit === "ms") return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function summarizeMetricsRange(
  response: MetricsRangeResponse | null | undefined,
): MetricSeriesSummary[] {
  return (response?.series ?? []).map((series) => summarizeSeries(series));
}

function summarizeSeries(series: MetricsRangeSeries): MetricSeriesSummary {
  const samples = series.samples ?? [];
  const latest = latestMetricSample(series);
  const first = samples[0] ?? null;
  const latestValue = latest ? Number(latest.value) : null;
  const firstValue = first ? Number(first.value) : null;
  const unit = series.unit ?? null;
  const deltaValue =
    latestValue !== null && firstValue !== null ? latestValue - firstValue : null;
  const hasSamples = samples.length > 0;

  return {
    selector: series.selector,
    label: metricLabel(series.selector),
    status: series.status,
    unit: metricUnitLabel(unit),
    latestValue: formatMetricValue(latestValue, unit),
    latestRawValue: latestValue,
    latestBlock: latest ? Number(latest.blockNumber) : null,
    sampleCount: samples.length,
    delta: formatMetricDelta(deltaValue, unit),
    tone: series.status === "available" && hasSamples ? "ok" : series.status === "not_retained" ? "warn" : "info",
    sparkline: samples.map((sample) => Number(sample.value)).filter(Number.isFinite),
  };
}

function formatMetricDelta(
  delta: number | null,
  unit: string | null | undefined,
): string {
  if (delta === null || !Number.isFinite(delta)) return "-";
  const prefix = delta > 0 ? "+" : "";
  if (unit === "basis_points") return `${prefix}${(delta / 100).toFixed(1)} pp`;
  if (unit === "bytes_per_second") return `${prefix}${formatBytesPerSecond(delta)}`;
  if (unit === "ms") return `${prefix}${delta.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`;
  return `${prefix}${delta.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatBytesPerSecond(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_048_576) return `${sign}${(abs / 1_048_576).toFixed(1)} MiB/s`;
  if (abs >= 1_024) return `${sign}${(abs / 1_024).toFixed(1)} KiB/s`;
  return `${sign}${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })} B/s`;
}
