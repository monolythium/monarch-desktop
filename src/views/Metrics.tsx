import { mrvReadinessSignal, type ReadinessSignal } from "../sdk/mrvReadiness";
import { Sparkline } from "../components/Sparkline";
import {
  MONARCH_METRIC_SELECTORS,
  summarizeMetricsRange,
  useChainStatus,
  useMetricsRange,
  useNodeStatus,
  useOperatorCapabilities,
  type MetricSeriesSummary,
  type RpcSlice,
} from "../sdk";
import type { MetricsRangeResponse } from "@monolythium/core-sdk";

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
  const metricsRange = useMetricsRange(MONARCH_METRIC_SELECTORS);
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
        <p className="view__subtitle">
          live RPC snapshot · retained node telemetry · exportable
        </p>
      </header>

      <div className="metrics-toolbar card card--padded">
        <div>
          <div className="cap">observability</div>
          <h2>Current node metrics</h2>
          <div className="sub">{metricsSource}</div>
        </div>
        <div className="metrics-toolbar__controls">
          <button type="button" className="btn btn--ghost btn--sm" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>

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
          <div className="cap">lyth_metricsRange</div>
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
            ? "not exposed"
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
          <span className="dot" /> lyth_metricsRange is not exposed by this endpoint.
        </div>
      ) : metricSeries.length === 0 && !metricsRange.loading ? (
        <div className="status-bar status-bar--warn">
          <span className="dot" /> The endpoint returned no retained samples for the canonical Monarch metric selectors.
        </div>
      ) : (
        <div className="grid-2x3">
          {metricSeries.map((series) => (
            <MetricSeriesCard key={series.selector} series={series} />
          ))}
        </div>
      )}
    </section>
  );
}

function MetricSeriesCard({ series }: { series: MetricSeriesSummary }) {
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
  const chainSource = chain.notExposed ? "derived from basic RPC fallback" : "lyth_chainStatus";
  const chainTone = chain.error ? "err" : nodeReachable || chain.data?.reachable ? "ok" : "warn";
  const capsSource = operatorCapabilities.notExposed ? "lyth_operatorCapabilities not exposed" : "lyth_operatorCapabilities";
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
  if (slice.notExposed) return "lyth_metricsRange not exposed";
  if (slice.error) return `lyth_metricsRange error: ${slice.error}`;
  if (slice.data) return "lyth_metricsRange retained telemetry";
  return "awaiting lyth_metricsRange";
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
