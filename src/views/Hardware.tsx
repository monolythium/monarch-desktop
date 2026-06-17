// Hardware — live disk / CPU / RAM monitoring for the operator's Monarch OS
// node, plus disk-growth trends and a "full in ~N days" projection.
//
// All node reads are READ-ONLY Talos RPCs (the same hard rule as the node-status
// header): host telemetry (mounts / memory / CPU / network), the protocore log
// directory size, and the data-dir size. Nothing here controls the node — no
// service action, config patch, upgrade, reboot, or wipe. The one mutating
// affordance is the disk-fill warning's button, which opens the EXISTING
// "Clean up logs" Operations flow through the Ops drawer (which itself gates on
// operator review). Resource samples are persisted locally (SQLite) so the
// growth deltas and the CPU/RAM sparklines survive an app restart.

import { useEffect, useMemo, useState } from "react";
import {
  inTauri,
  getStoredRpcEndpoint,
  computeDiskTrend,
  formatFillTime,
  formatPacePerDay,
  immediateEstimateFromDatadir,
  immediateEstimateFromLogfile,
  talosConfigInfo,
  talosDataDirUsage,
  talosHostTelemetry,
  talosLogDiskUsage,
  talosNodeStatus,
  talosProtocoreReadiness,
  talosService,
  talosStatus,
  useHwSamples,
  type DiskTrend,
  type FillTone,
  type ProtocoreReadiness,
  type TalosConfigInfo,
  type TalosDataDirUsage,
  type TalosHostTelemetry,
  type TalosLogDiskUsage,
  type TalosMountTelemetry,
  type TalosNodeStatus,
  type TalosServiceInfo,
  type TalosStatus,
} from "../sdk";
import { NodeStatusHeader } from "../components/NodeStatusHeader";
import { useOps } from "../ops/OpsContext";
import { OP_CATALOG } from "../ops/catalog";
import { DEFAULT_LOG_RETENTION, type OpKind, type OpRequest } from "../ops/types";

type HardwareState = {
  status: TalosStatus | null;
  config: TalosConfigInfo | null;
  service: TalosServiceInfo | null;
  readiness: ProtocoreReadiness | null;
  telemetry: TalosHostTelemetry | null;
  nodeStatus: TalosNodeStatus | null;
  logUsage: TalosLogDiskUsage | null;
  dataDir: TalosDataDirUsage | null;
  loading: boolean;
  error: string | null;
  telemetryError: string | null;
};

const EMPTY: HardwareState = {
  status: null,
  config: null,
  service: null,
  readiness: null,
  telemetry: null,
  nodeStatus: null,
  logUsage: null,
  dataDir: null,
  loading: true,
  error: null,
  telemetryError: null,
};

/** Choose the mount whose fill matters for the projection: the one carrying the
 *  protocore data dir (`/var/lib/protocore` → usually the EPHEMERAL `/var`
 *  mount), else the largest non-root data mount, else `/`. Returns null when no
 *  mount was reported. */
export function pickTrackedMount(
  mounts: readonly TalosMountTelemetry[],
): TalosMountTelemetry | null {
  if (mounts.length === 0) return null;
  // Longest `mountedOn` that is a prefix of the data dir wins (most specific).
  const dataPath = "/var/lib/protocore";
  const covering = mounts
    .filter((m) => dataPath.startsWith(m.mountedOn) && m.mountedOn !== "")
    .sort((a, b) => b.mountedOn.length - a.mountedOn.length);
  if (covering[0]) return covering[0];
  // Otherwise the largest mount (the data partition is the big one).
  return [...mounts].sort((a, b) => b.sizeBytes - a.sizeBytes)[0] ?? null;
}

const TONE_VAR: Record<FillTone, string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  err: "var(--err)",
  muted: "var(--fg-400)",
};

export function Hardware() {
  const [state, setState] = useState<HardwareState>(EMPTY);
  const ops = useOps();

  const refresh = async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    if (!inTauri()) {
      setState({
        ...EMPTY,
        loading: false,
        error: "Open Monarch Desktop to see hardware telemetry from your node.",
      });
      return;
    }
    try {
      const [
        status,
        config,
        serviceResult,
        readiness,
        telemetryResult,
        nodeStatus,
        logUsage,
        dataDir,
      ] = await Promise.all([
        talosStatus().catch(() => null),
        talosConfigInfo().catch(() => null),
        talosService("ext-protocore").catch(() => null),
        talosProtocoreReadiness(getStoredRpcEndpoint()).catch(() => null),
        talosHostTelemetry()
          .then((telemetry) => ({ telemetry, error: null }))
          .catch((err) => ({
            telemetry: null,
            error: (err as Error)?.message ?? String(err),
          })),
        talosNodeStatus().catch(() => null),
        talosLogDiskUsage().catch(() => null),
        talosDataDirUsage().catch(() => null),
      ]);
      setState({
        status,
        config,
        service: serviceResult?.service ?? null,
        readiness,
        telemetry: telemetryResult.telemetry,
        nodeStatus,
        logUsage,
        dataDir,
        loading: false,
        error: null,
        telemetryError: telemetryResult.error,
      });
    } catch (err) {
      setState({
        ...EMPTY,
        loading: false,
        error: (err as Error)?.message ?? String(err),
      });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const statusTone = state.status?.reachable ? "halo halo--ok" : "halo halo--warn";

  // The disk mount we project a fill time for.
  const tracked = useMemo(
    () => pickTrackedMount(state.telemetry?.mounts ?? []),
    [state.telemetry],
  );

  const cpuPct =
    state.telemetry?.cpuUsedPercent != null &&
    Number.isFinite(state.telemetry.cpuUsedPercent)
      ? state.telemetry.cpuUsedPercent
      : null;
  const mem = state.telemetry?.memory ?? null;

  // Feed the local time-series the current reading so trends persist. Only
  // record when we have a usable disk figure to anchor the row.
  const sampleInput = useMemo(() => {
    if (!tracked) return null;
    return {
      diskUsed: tracked.usedBytes,
      diskTotal: tracked.sizeBytes,
      cpuPct,
      memUsed: mem?.usedBytes ?? 0,
      memTotal: mem?.totalBytes ?? 0,
    };
  }, [tracked, cpuPct, mem]);

  const hw = useHwSamples(sampleInput, { active: inTauri() });

  // Immediate, first-open growth estimate from the node itself: the unbounded
  // append-only log file's size / age, else the data-dir size / node uptime.
  const immediateBytesPerDay = useMemo(() => {
    const largestLog = state.logUsage?.files?.[0] ?? null;
    if (largestLog && largestLog.modified) {
      // The append-only file's age ≈ since it was first created. Use its
      // modified time only as a floor; the node's uptime is a better age proxy.
      const uptime = state.nodeStatus?.uptimeSeconds ?? null;
      if (uptime && uptime > 0) {
        const fromLog = immediateEstimateFromLogfile({
          logfileSize: largestLog.size,
          logfileAgeMs: uptime * 1000,
        });
        if (fromLog != null) return fromLog;
      }
    }
    if (state.dataDir && state.nodeStatus?.uptimeSeconds) {
      return immediateEstimateFromDatadir({
        datadirSize: state.dataDir.totalBytes,
        uptimeSeconds: state.nodeStatus.uptimeSeconds,
      });
    }
    return null;
  }, [state.logUsage, state.dataDir, state.nodeStatus]);

  const trend: DiskTrend | null = useMemo(() => {
    if (!tracked) return null;
    return computeDiskTrend({
      samples: hw.samples,
      diskUsed: tracked.usedBytes,
      diskTotal: tracked.sizeBytes,
      nowMs: Date.now(),
      immediateBytesPerDay,
    });
  }, [tracked, hw.samples, immediateBytesPerDay]);

  const openCleanupOp = () => {
    const request = logCatalogRequest("clean-protocore-logs", {
      logRetentionInput: { ...DEFAULT_LOG_RETENTION },
    });
    if (request) ops.requestOp(request);
  };

  return (
    <section className="view fade-in" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header>
        <h1 className="view__title">Hardware</h1>
        <p className="view__subtitle">
          Monarch OS substrate · Talos control plane · ext-protocore service
        </p>
      </header>

      <NodeStatusHeader active={inTauri()} />

      {/* Disk-fill warning — also the fix: opens the existing Clean up logs op. */}
      {trend?.warn ? (
        <div
          className="card card--padded"
          style={{
            borderColor: TONE_VAR[trend.tone],
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <span className={`halo halo--${trend.tone === "muted" ? "warn" : trend.tone}`}>
            <span className="dot" /> Disk filling up
          </span>
          <div style={{ flex: 1, minWidth: 240 }}>
            <b style={{ color: "var(--fg-100)" }}>
              {tracked ? tracked.mountedOn : "Data disk"} projected full {formatFillTime(trend.fillDays)}
            </b>
            <div style={{ fontSize: 12, color: "var(--fg-300)", marginTop: 2 }}>
              Growing {formatPacePerDay(trend.paceBytesPerDay)}
              {trend.paceSource === "immediate"
                ? " (estimated from node uptime; refines as samples accrue)"
                : ""}
              . The protocore log appends without rotating — clean up logs to reclaim space.
            </div>
          </div>
          <button type="button" className="btn btn--sm" onClick={openCleanupOp}>
            Clean up logs
          </button>
        </div>
      ) : null}

      {/* Live snapshot tiles: disk / CPU / RAM. */}
      <div className="card card--padded">
        <div className="card__head">
          <div>
            <h3>Live resources</h3>
            <div className="sub">read-only Talos telemetry · disk · CPU · memory</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className={statusTone}>
              <span className="dot" /> {state.status?.reachable ? "reachable" : "not reachable"}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                void refresh();
                hw.refresh();
              }}
            >
              {state.loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {state.error ? (
          <div className="empty-state" style={{ marginBottom: 8 }}>
            <b style={{ color: "var(--fg-100)" }}>No live hardware data</b>
            <div style={{ marginTop: 4 }}>{state.error}</div>
          </div>
        ) : null}

        <div className="grid-3" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <Tile
            label="Disk"
            primary={
              tracked
                ? `${formatBytes(tracked.usedBytes)} / ${formatBytes(tracked.sizeBytes)}`
                : "—"
            }
            secondary={tracked ? `${formatPercent(tracked.usedPercent)} used · ${tracked.mountedOn}` : "no mount reported"}
            pct={tracked?.usedPercent ?? null}
          />
          <Tile
            label="CPU"
            primary={cpuPct != null ? formatPercent(cpuPct) : "—"}
            secondary={
              state.telemetry?.loadAverage
                ? `load ${state.telemetry.loadAverage.load1.toFixed(2)} · ${
                    state.telemetry.cpuCount ?? "?"
                  } cores`
                : cpuPct != null
                  ? "busy %"
                  : "not reported"
            }
            pct={cpuPct}
          />
          <Tile
            label="Memory"
            primary={mem ? `${formatBytes(mem.usedBytes)} / ${formatBytes(mem.totalBytes)}` : "—"}
            secondary={mem ? `${formatPercent(mem.usedPercent)} used` : "not reported"}
            pct={mem?.usedPercent ?? null}
          />
        </div>

        {state.telemetryError ? (
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--fg-400)" }}>
            telemetry read: {state.telemetryError}
          </div>
        ) : null}

        {/* Sparklines: CPU busy% and RAM used% over the local sample window. */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
          <Sparkline
            label="CPU trend"
            values={hw.samples.map((s) => (s.cpuPct >= 0 ? s.cpuPct : null))}
            max={100}
            unit="%"
            color="var(--info)"
          />
          <Sparkline
            label="RAM trend"
            values={hw.samples.map((s) =>
              s.memTotal > 0 ? (s.memUsed / s.memTotal) * 100 : null,
            )}
            max={100}
            unit="%"
            color="var(--gold, var(--info))"
          />
        </div>
        {hw.samples.length < 2 ? (
          <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--fg-500)" }}>
            Trends build up while Monarch is open (a point every few minutes); they persist across restarts.
          </div>
        ) : null}
      </div>

      {/* Per-mount disk bars. */}
      <div className="card card--padded">
        <div className="card__head">
          <div>
            <h3>Disks &amp; mounts</h3>
            <div className="sub">per-filesystem usage from the Talos mounts read</div>
          </div>
        </div>
        {(state.telemetry?.mounts ?? []).length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--fg-400)" }}>No mounts reported.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {(state.telemetry?.mounts ?? []).map((mount) => (
              <MountBar
                key={`${mount.filesystem}:${mount.mountedOn}`}
                mount={mount}
                tracked={tracked?.mountedOn === mount.mountedOn}
              />
            ))}
          </div>
        )}
        {(state.telemetry?.disks ?? []).length > 0 ? (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
            {(state.telemetry?.disks ?? []).slice(0, 4).map((disk) => (
              <div key={disk.deviceName} style={{ fontSize: 11, color: "var(--fg-400)" }}>
                <span className="mono" style={{ color: "var(--fg-300)" }}>{disk.deviceName}</span>{" "}
                · {disk.diskType} · {formatBytes(disk.sizeBytes)} · {disk.systemDisk ? "system" : "data"}
                {disk.readonly ? " · read-only" : ""}
                {disk.model ? ` · ${disk.model}` : ""}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Disk growth + fill-time projection. */}
      <div className="card card--padded">
        <div className="card__head">
          <div>
            <h3>Disk growth &amp; projection</h3>
            <div className="sub">
              {tracked ? tracked.mountedOn : "data disk"} · how fast it's filling and when it'll be full
            </div>
          </div>
          <span className={`halo halo--${(trend ? trend.tone : "muted") === "muted" ? "info" : trend!.tone}`}>
            <span className="dot" /> {trend ? `full ${formatFillTime(trend.fillDays)}` : "—"}
          </span>
        </div>
        <div className="grid-2">
          <div>
            <KV label="24h growth" value={growthLabel(trend?.deltas.h24?.deltaBytes)} />
            <KV label="48h growth" value={growthLabel(trend?.deltas.h48?.deltaBytes)} />
            <KV label="72h growth" value={growthLabel(trend?.deltas.h72?.deltaBytes)} />
          </div>
          <div>
            <KV label="current pace" value={formatPacePerDay(trend?.paceBytesPerDay)} />
            <KV
              label="pace from"
              value={paceSourceLabel(trend?.paceSource)}
            />
            <KV
              label="projected full"
              value={trend ? formatFillTime(trend.fillDays) : "—"}
            />
          </div>
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--fg-500)" }}>
          {(trend?.paceSource === "immediate" || trend?.paceSource === "none") && hw.samples.length < 2
            ? "Before local history accrues, the estimate uses the node's own log/data-dir size over its uptime; it refines as Monarch records samples."
            : "Linear projection from the measured growth pace; treat it as a guide, not a guarantee."}
        </div>
      </div>

      {/* Service / readiness — unchanged read-only context. */}
      <div className="grid-2">
        <div className="card card--padded">
          <div className="card__head">
            <div>
              <h3>ext-protocore</h3>
              <div className="sub">live Talos service read</div>
            </div>
            <span className={readinessHalo(state.readiness, state.service)}>
              <span className="dot" /> {state.readiness?.displayState ?? state.service?.displayState ?? "unknown"}
            </span>
          </div>
          <KV label="service id" value={state.service?.id ?? "ext-protocore"} mono />
          <KV label="state" value={state.service?.state ?? "—"} />
          <KV label="readiness" value={state.readiness?.summary ?? healthLabel(state.service)} />
          <KV label="chain id" value={state.readiness?.chainId?.toString() ?? "—"} />
          <KV label="block" value={state.readiness?.blockNumber?.toLocaleString() ?? "—"} />
          <KV label="syncing" value={boolLabel(state.readiness?.syncing)} />
        </div>

        <div className="card card--padded">
          <div className="card__head">
            <div>
              <h3>Control plane</h3>
              <div className="sub">live Talos configuration and reachability</div>
            </div>
            <span className={state.telemetry ? "halo halo--ok" : "halo halo--warn"}>
              <span className="dot" /> {state.telemetry ? "live" : "unavailable"}
            </span>
          </div>
          <KV label="endpoint" value={state.status?.endpoint ?? "—"} mono />
          <KV label="node" value={state.status?.nodeAddress ?? "—"} mono />
          <KV label="context" value={state.config?.context ?? "—"} />
          <KV label="CA pin" value={state.config?.caPinStatus ?? "—"} />
          <KV label="data dir" value={state.dataDir ? formatBytes(state.dataDir.totalBytes) : "—"} />
          <KV label="protocore logs" value={state.logUsage ? formatBytes(state.logUsage.totalBytes) : "—"} />
          <KV label="Network" value={networkLabel(state.telemetry)} />
        </div>
      </div>
    </section>
  );
}

/** Build an OpRequest from a catalog entry — mirrors the Logs view. */
function logCatalogRequest(kind: OpKind, overrides: Partial<OpRequest> = {}): OpRequest | null {
  const entry = OP_CATALOG.find((candidate) => candidate.kind === kind);
  if (!entry) return null;
  return {
    kind: entry.kind,
    title: entry.title,
    sub: entry.sub,
    intro: entry.intro,
    technical: entry.technical,
    fields: entry.fields,
    effects: entry.effects,
    diff: entry.diff,
    icon: entry.icon,
    risk: entry.risk,
    destructive: entry.destructive,
    needsPasskey: entry.needsPasskey,
    confirmLabel: entry.confirmLabel,
    ...overrides,
  };
}

function Tile({
  label,
  primary,
  secondary,
  pct,
}: {
  label: string;
  primary: string;
  secondary: string;
  pct: number | null;
}) {
  const tone: FillTone =
    pct == null ? "muted" : pct >= 90 ? "err" : pct >= 75 ? "warn" : "ok";
  return (
    <div className="card" style={{ padding: "14px 16px", background: "rgba(255,255,255,0.02)" }}>
      <span className="cap">{label}</span>
      <div className="mono" style={{ fontSize: 18, color: "var(--fg-100)", marginTop: 4 }}>
        {primary}
      </div>
      <div style={{ fontSize: 11, color: "var(--fg-400)", marginTop: 2 }}>{secondary}</div>
      <Bar pct={pct} tone={tone} />
    </div>
  );
}

function Bar({ pct, tone }: { pct: number | null; tone: FillTone }) {
  const width = pct != null && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return (
    <div
      style={{
        marginTop: 8,
        height: 6,
        borderRadius: 3,
        background: "rgba(255,255,255,0.06)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${width}%`,
          height: "100%",
          background: TONE_VAR[tone],
          transition: "width 240ms ease",
        }}
      />
    </div>
  );
}

function MountBar({ mount, tracked }: { mount: TalosMountTelemetry; tracked: boolean }) {
  const tone: FillTone =
    mount.usedPercent >= 90 ? "err" : mount.usedPercent >= 75 ? "warn" : "ok";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <span className="mono" style={{ color: tracked ? "var(--fg-100)" : "var(--fg-300)" }}>
          {mount.mountedOn}
          {tracked ? " · tracked" : ""}
        </span>
        <span style={{ color: "var(--fg-400)" }}>
          {formatBytes(mount.usedBytes)} / {formatBytes(mount.sizeBytes)} ({formatPercent(mount.usedPercent)})
        </span>
      </div>
      <Bar pct={mount.usedPercent} tone={tone} />
    </div>
  );
}

/** Minimal SVG sparkline. `values` may contain nulls (gaps); we plot the
 *  non-null points. Renders a flat placeholder when there's nothing to draw. */
function Sparkline({
  label,
  values,
  max,
  unit,
  color,
}: {
  label: string;
  values: (number | null)[];
  max: number;
  unit: string;
  color: string;
}) {
  const points = values.filter((v): v is number => v != null && Number.isFinite(v));
  const W = 220;
  const H = 40;
  const latest = points.length > 0 ? points[points.length - 1]! : null;
  const path = useMemo(() => {
    if (points.length < 2) return "";
    const stepX = W / (points.length - 1);
    return points
      .map((v, i) => {
        const x = i * stepX;
        const y = H - (Math.max(0, Math.min(max, v)) / max) * H;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [points, max]);

  return (
    <div className="card" style={{ padding: "10px 12px", background: "rgba(255,255,255,0.02)" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span className="cap">{label}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--fg-300)" }}>
          {latest != null ? `${latest.toFixed(0)}${unit}` : "—"}
        </span>
      </div>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ marginTop: 4 }}>
        {path ? (
          <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
        ) : (
          <line x1={0} y1={H - 1} x2={W} y2={H - 1} stroke="var(--fg-500)" strokeWidth={1} strokeDasharray="3 3" />
        )}
      </svg>
    </div>
  );
}

function KV({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="kv">
      <span className="kv__k">{label}</span>
      <span className={mono ? "kv__v mono" : "kv__v"}>{value}</span>
    </div>
  );
}

function serviceHalo(service: TalosServiceInfo | null): string {
  if (!service) return "halo halo--warn";
  if (service.severity === "ok") return "halo halo--ok";
  if (service.severity === "err") return "halo halo--err";
  if (service.severity === "warn") return "halo halo--warn";
  return "halo halo--info";
}

function readinessHalo(readiness: ProtocoreReadiness | null, service: TalosServiceInfo | null): string {
  if (!readiness) return serviceHalo(service);
  if (readiness.severity === "ok") return "halo halo--ok";
  if (readiness.severity === "err") return "halo halo--err";
  if (readiness.severity === "warn") return "halo halo--warn";
  return "halo halo--info";
}

function healthLabel(service: TalosServiceInfo | null): string {
  if (!service) return "—";
  if (service.healthy === true) return "healthy";
  if (service.healthy === false) return service.healthMessage ?? "unhealthy";
  return service.healthMessage ?? "unknown";
}

function boolLabel(value: boolean | null | undefined): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "—";
}

/** Signed byte growth (e.g. "+1.2 GiB", "−420 MiB"), or "—" when no delta. */
function growthLabel(deltaBytes: number | null | undefined): string {
  if (deltaBytes == null || !Number.isFinite(deltaBytes)) return "—";
  if (deltaBytes === 0) return "no change";
  const sign = deltaBytes > 0 ? "+" : "−";
  return `${sign}${formatBytes(Math.abs(deltaBytes))}`;
}

function paceSourceLabel(source: DiskTrend["paceSource"] | undefined): string {
  switch (source) {
    case "local-72h":
      return "72h samples";
    case "local-48h":
      return "48h samples";
    case "local-24h":
      return "24h samples";
    case "immediate":
      return "node uptime estimate";
    default:
      return "—";
  }
}

function networkLabel(telemetry: TalosHostTelemetry | null): string {
  const total = telemetry?.network.find((row) => row.name === "total") ?? telemetry?.network[0];
  if (!total) return "—";
  return `rx ${formatBytes(total.rxBytes)} · tx ${formatBytes(total.txBytes)}`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let unitIndex = 0;
  let current = value;
  while (Math.abs(current) >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : 1;
  return `${current.toFixed(digits)} ${units[unitIndex]}`;
}
