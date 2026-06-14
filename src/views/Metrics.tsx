import { useState } from "react";
import { mrvReadinessSignal, type ReadinessSignal } from "../sdk/mrvReadiness";
import { Sparkline } from "../components/Sparkline";
import { UpdatedAgo } from "../components/UpdatedAgo";
import {
  MONARCH_METRIC_SELECTORS,
  formatMetricValue,
  summarizeMetricsRange,
  useChainStatus,
  useMetricsRange,
  useNodeStatus,
  useOperatorCapabilities,
  type MetricSeriesSummary,
  type RpcSlice,
} from "../sdk";
import type { MetricsRangeResponse, MetricsRangeSeries } from "@monolythium/core-sdk";

// Time-window presets for lyth_metricsRange. The chain targets a ~4s
// commit cadence, so windows are converted to block counts at that
// rate; the toolbar labels them as approximate. "latest" sends a null
// range (node-default retained snapshot — the previous behavior).
const SECONDS_PER_BLOCK = 4;
const RANGE_PRESETS = [
  { id: "latest", label: "latest", seconds: null },
  { id: "1h", label: "1h", seconds: 3_600 },
  { id: "6h", label: "6h", seconds: 6 * 3_600 },
  { id: "24h", label: "24h", seconds: 24 * 3_600 },
  { id: "7d", label: "7d", seconds: 7 * 24 * 3_600 },
  { id: "30d", label: "30d", seconds: 30 * 24 * 3_600 },
] as const;

type RangePresetId = (typeof RANGE_PRESETS)[number]["id"];

// Quantize the anchor height so the cache key stays stable for ~5min
// stretches instead of refetching a brand-new range every poll.
const RANGE_ANCHOR_QUANTUM = 75;

function rangeForPreset(
  preset: RangePresetId,
  blockHeight: number | null,
): readonly [number, number] | null {
  const seconds = RANGE_PRESETS.find((p) => p.id === preset)?.seconds ?? null;
  if (seconds === null || blockHeight === null || blockHeight <= 0) return null;
  const anchor = Math.max(0, blockHeight - (blockHeight % RANGE_ANCHOR_QUANTUM));
  const windowBlocks = Math.max(1, Math.floor(seconds / SECONDS_PER_BLOCK));
  return [Math.max(0, anchor - windowBlocks), anchor] as const;
}

type SeriesStats = { min: string; max: string; avg: string } | null;

function seriesStats(raw: MetricsRangeSeries | undefined): SeriesStats {
  const values = (raw?.samples ?? [])
    .map((sample) => Number(sample.value))
    .filter(Number.isFinite);
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    min: formatMetricValue(min, raw?.unit),
    max: formatMetricValue(max, raw?.unit),
    avg: formatMetricValue(avg, raw?.unit),
  };
}

const TONE_TO_HALO: Record<string, string> = {
  ok: "metric-value metric-value--ok",
  warn: "metric-value metric-value--warn",
  err: "metric-value metric-value--err",
  info: "metric-value metric-value--info",
};

type MetricSignal = ReadinessSignal & { source: string };

export function Metrics() {
  const chain = useChainStatus();
  const node = useNodeStatus();
  const operatorCapabilities = useOperatorCapabilities();
  const [rangePreset, setRangePreset] = useState<RangePresetId>("latest");
  const blockHeight = chain.data?.blockHeight || node.blockNumber || null;
  const range = rangeForPreset(rangePreset, blockHeight);
  const metricsRange = useMetricsRange(MONARCH_METRIC_SELECTORS, range);
  const signals = liveSignals({
    chain,
    nodeReachable: node.reachable,
    operatorCapabilities,
  });
  const metricSeries = summarizeMetricsRange(metricsRange.data);
  const retainedSeries = metricSeries.filter((series) => series.sampleCount > 0).length;
  const metricsSource = metricsSourceLabel(metricsRange);
  const exportCsv = () => {
    const rows = [
      ["kind", "metric_id", "metric", "value", "unit", "source", "block", "status"],
      ...signals.map((signal) => [
        "snapshot",
        signal.id,
        signal.label,
        signal.value,
        signal.unit,
        signal.source,
        "",
        signal.tone,
      ]),
      ...metricSeries.map((series) => [
        "range",
        series.selector,
        series.label,
        series.latestValue,
        series.unit,
        "lyth_metricsRange",
        series.latestBlock ?? "",
        series.status,
      ]),
    ];
    const csv = rows
      .map((row) =>
        row
          .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
          .join(","),
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "monarch-metrics-snapshot.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="view fade-in">
      <header>
        <h1 className="view__title">Metrics</h1>
        <p className="view__subtitle">Live node status and retained telemetry.</p>
      </header>

      <div className="metrics-toolbar card card--padded">
        <div>
          <div className="cap">observability</div>
          <h2>Current node metrics</h2>
          <div className="sub">{metricsSource}</div>
        </div>
        <div className="metrics-toolbar__controls">
          <div className="segmented" role="group" aria-label="Telemetry window">
            {RANGE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={rangePreset === preset.id ? "is-on" : ""}
                onClick={() => setRangePreset(preset.id)}
                title={
                  preset.seconds === null
                    ? "node-default retained snapshot"
                    : `~${preset.label} window at the chain's 4s commit cadence`
                }
              >
                {preset.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={exportCsv}>
            Export CSV
          </button>
          <UpdatedAgo at={metricsRange.lastUpdatedAt} />
        </div>
      </div>

      {rangePreset !== "latest" && range === null ? (
        <div className="status-bar status-bar--warn">
          <span className="dot" /> Block height unknown — the {rangePreset} window falls back to the
          node-default snapshot until the height resolves.
        </div>
      ) : null}

      <div className="grid-2x3">
        {signals.map((s) => (
          <div className="card metric-card" key={s.id}>
            <div className="card__head">
              <div>
                <h3>{s.label}</h3>
                <div className="sub">{s.source}</div>
              </div>
            </div>
            <div className={TONE_TO_HALO[s.tone] ?? "metric-value"}>
              <span>{s.value}</span>
              <small>{s.unit}</small>
            </div>
          </div>
        ))}
      </div>

      <div className="metrics-section-head">
        <div>
          <div className="cap">telemetry history</div>
          <h2>Retained telemetry series</h2>
          <p>
            {metricsRange.data?.tracking
              ? `tracking ${metricsRange.data.tracking}`
              : "node-local metric retention"}
          </p>
        </div>
        <span className={metricsRangeHalo(metricsRange, retainedSeries)}>
          <span className="dot" />{" "}
          {metricsRange.notExposed
            ? "unavailable"
            : metricsRange.error
              ? "error"
              : retainedSeries > 0
                ? `${retainedSeries}/${metricSeries.length} retained`
                : metricsRange.loading
                  ? "loading"
                  : "no retained samples"}
        </span>
      </div>

      {metricsRange.error ? (
        <div className="status-bar status-bar--err">
          <span className="dot" /> {metricsRange.error}
        </div>
      ) : null}

      {metricsRange.notExposed ? (
        <div className="status-bar status-bar--warn">
          <span className="dot" /> Retained telemetry is not available from this node yet.
        </div>
      ) : metricSeries.length === 0 && !metricsRange.loading ? (
        <div className="status-bar status-bar--warn">
          <span className="dot" /> The endpoint returned no retained samples for the canonical Monarch metric selectors.
        </div>
      ) : (
        <div className="grid-2x3">
          {metricSeries.map((series) => (
            <MetricSeriesCard
              key={series.selector}
              series={series}
              stats={seriesStats(
                metricsRange.data?.series.find((raw) => raw.selector === series.selector),
              )}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function MetricSeriesCard({
  series,
  stats,
}: {
  series: MetricSeriesSummary;
  stats: SeriesStats;
}) {
  return (
    <div className="card metric-card metric-card--series">
      <div className="card__head">
        <div>
          <h3>{series.label}</h3>
          <div className="sub">{series.selector}</div>
        </div>
        <span className={`halo halo--${series.tone}`}>
          <span className="dot" /> {series.status}
        </span>
      </div>
      <div className="metric-series__value">{series.latestValue}</div>
      <div className="metric-series__chart">
        <Sparkline data={series.sparkline} height={44} />
      </div>
      {stats ? (
        <div className="metric-series__meta">
          <span>min {stats.min}</span>
          <span>avg {stats.avg}</span>
          <span>max {stats.max}</span>
        </div>
      ) : null}
      <div className="metric-series__meta">
        <span>{series.sampleCount.toLocaleString()} samples</span>
        <span>block {series.latestBlock?.toLocaleString() ?? "-"}</span>
        <span>delta {series.delta}</span>
      </div>
    </div>
  );
}

function liveSignals({
  chain,
  nodeReachable,
  operatorCapabilities,
}: {
  chain: ReturnType<typeof useChainStatus>;
  nodeReachable: boolean;
  operatorCapabilities: ReturnType<typeof useOperatorCapabilities>;
}): MetricSignal[] {
  const chainSource = chain.data
    ? "chain status"
    : chain.loading
      ? "loading chain status"
      : "chain status unavailable";
  const chainTone = chain.error ? "err" : nodeReachable || chain.data?.reachable ? "ok" : "warn";
  const capsSource = operatorCapabilities.data
    ? "capability readiness"
    : operatorCapabilities.loading
      ? "checking readiness"
      : "readiness unavailable";
  const mrv = mrvReadinessSignal({ operatorCapabilities: operatorCapabilities.data });

  return [
    {
      id: "chain-id",
      label: "Chain ID",
      value: chain.data?.chainId ? String(chain.data.chainId) : "—",
      unit: "",
      tone: chainTone,
      source: chainSource,
    },
    {
      id: "block-height",
      label: "Block height",
      value: chain.data?.blockHeight ? chain.data.blockHeight.toLocaleString() : "—",
      unit: "blocks",
      tone: chainTone,
      source: chainSource,
    },
    {
      id: "finalized-height",
      label: "Finalized height",
      value: chain.data?.finalizedHeight ? chain.data.finalizedHeight.toLocaleString() : "—",
      unit: "blocks",
      tone: chainTone,
      source: chainSource,
    },
    {
      id: "operator-count",
      label: "Operator count",
      value: chain.data?.operatorCount ? chain.data.operatorCount.toLocaleString() : "—",
      unit: "operators",
      tone: chain.data?.operatorCount ? "info" : "warn",
      source: chainSource,
    },
    {
      id: "cluster-count",
      label: "Cluster count",
      value: chain.data?.clusterCount ? chain.data.clusterCount.toLocaleString() : "—",
      unit: "clusters",
      tone: chain.data?.clusterCount ? "info" : "warn",
      source: chainSource,
    },
    {
      ...mrv,
      source: capsSource,
    },
  ];
}

function metricsSourceLabel(slice: RpcSlice<MetricsRangeResponse>): string {
  if (slice.notExposed) return "retained telemetry unavailable";
  if (slice.error) return `telemetry read failed: ${slice.error}`;
  if (slice.data) return "retained telemetry";
  return "waiting for telemetry";
}

function metricsRangeHalo(
  slice: RpcSlice<MetricsRangeResponse>,
  retainedSeries: number,
): string {
  if (slice.error) return "halo halo--err";
  if (slice.notExposed || (slice.data && retainedSeries === 0)) return "halo halo--warn";
  if (retainedSeries > 0) return "halo halo--ok";
  return "halo halo--info";
}
