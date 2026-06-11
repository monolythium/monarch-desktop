import { useEffect, useState, type ReactNode } from "react";
import {
  inTauri,
  getStoredRpcEndpoint,
  talosConfigInfo,
  talosHostTelemetry,
  talosProtocoreReadiness,
  talosService,
  talosStatus,
  type ProtocoreReadiness,
  type TalosConfigInfo,
  type TalosHostTelemetry,
  type TalosServiceInfo,
  type TalosStatus,
} from "../sdk";

type HardwareState = {
  status: TalosStatus | null;
  config: TalosConfigInfo | null;
  service: TalosServiceInfo | null;
  readiness: ProtocoreReadiness | null;
  telemetry: TalosHostTelemetry | null;
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
  loading: true,
  error: null,
  telemetryError: null,
};

export function Hardware() {
  const [state, setState] = useState<HardwareState>(EMPTY);

  const refresh = async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    if (!inTauri()) {
      setState({
        status: null,
        config: null,
        service: null,
        readiness: null,
        telemetry: null,
        loading: false,
        error:
          "Open the Monarch Desktop app to see hardware telemetry — the browser preview has no Talos control channel to your node.",
        telemetryError: null,
      });
      return;
    }
    try {
      const [status, config, serviceResult, readiness, telemetryResult] = await Promise.all([
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
      ]);
      setState({
        status,
        config,
        service: serviceResult?.service ?? null,
        readiness,
        telemetry: telemetryResult.telemetry,
        loading: false,
        error: null,
        telemetryError: telemetryResult.error,
      });
    } catch (err) {
      setState({
        status: null,
        config: null,
        service: null,
        readiness: null,
        telemetry: null,
        loading: false,
        error: (err as Error)?.message ?? String(err),
        telemetryError: null,
      });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const statusTone = state.status?.reachable ? "halo halo--ok" : "halo halo--warn";

  return (
    <section className="view fade-in" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header>
        <h1 className="view__title">Hardware</h1>
        <p className="view__subtitle">
          Monarch OS substrate · Talos control plane · ext-protocore service
        </p>
      </header>

      <div className="card card--padded">
        <div className="card__head">
          <div>
            <h3>Control plane</h3>
            <div className="sub">live Talos configuration and reachability</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className={statusTone}>
              <span className="dot" /> {state.status?.reachable ? "reachable" : "not reachable"}
            </span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void refresh()}>
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
        <div className="grid-2">
          <Panel title="Talos status">
            <KV label="configured" value={state.status?.configured ? "yes" : "no"} />
            <KV label="endpoint" value={state.status?.endpoint ?? "—"} mono />
            <KV label="node" value={state.status?.nodeAddress ?? "—"} mono />
            <KV label="client" value={state.status?.clientMode ?? "—"} />
            <KV label="version" value={state.status?.version ?? "—"} mono />
            <KV label="last error" value={state.status?.lastError ?? "—"} />
          </Panel>
          <Panel title="Talos config">
            <KV label="context" value={state.config?.context ?? "—"} />
            <KV label="server" value={state.config?.serverName ?? "—"} mono />
            <KV label="CA pin" value={state.config?.caPinStatus ?? "—"} />
            <KV label="endpoints" value={state.config?.endpoints.join(", ") || "—"} mono />
            <KV label="nodes" value={state.config?.nodes.join(", ") || "—"} mono />
          </Panel>
        </div>
      </div>

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
          <KV label="RPC endpoint" value={state.readiness?.rpcEndpoint ?? "—"} mono />
          <KV label="chain id" value={state.readiness?.chainId?.toString() ?? "—"} />
          <KV label="block" value={state.readiness?.blockNumber?.toLocaleString() ?? "—"} />
          <KV label="syncing" value={boolLabel(state.readiness?.syncing)} />
          <KV label="P2P listening" value={boolLabel(state.readiness?.listening)} />
          <KV label="client" value={state.readiness?.clientVersion ?? "—"} mono />
          <KV label="last event" value={state.service?.lastEvent?.message ?? "—"} />
          {state.readiness?.checks.map((check) => (
            <KV key={check.name} label={check.name} value={`${check.state}: ${check.message}`} />
          ))}
        </div>

        <div className="card card--padded">
          <div className="card__head">
            <div>
              <h3>Host telemetry</h3>
              <div className="sub">live Talos machine and storage reads</div>
            </div>
            <span className={state.telemetry ? "halo halo--ok" : "halo halo--warn"}>
              <span className="dot" /> {state.telemetry ? "live" : "unavailable"}
            </span>
          </div>
          {state.telemetryError ? <KV label="last error" value={state.telemetryError} /> : null}
          <KV label="CPU load" value={loadLabel(state.telemetry)} />
          <KV label="Memory" value={memoryLabel(state.telemetry)} />
          <KV label="Network counters" value={networkLabel(state.telemetry)} />
          <KV label="Disk I/O" value={diskIoLabel(state.telemetry)} />
          <KV label="NVMe SMART" value="Talos SMART health endpoint not exposed" />
          {(state.telemetry?.mounts ?? []).slice(0, 4).map((mount) => (
            <KV
              key={`${mount.filesystem}:${mount.mountedOn}`}
              label={`mount ${mount.mountedOn}`}
              value={`${formatBytes(mount.usedBytes)} / ${formatBytes(mount.sizeBytes)} (${formatPercent(mount.usedPercent)})`}
            />
          ))}
          {(state.telemetry?.disks ?? []).slice(0, 4).map((disk) => (
            <KV
              key={disk.deviceName}
              label={`disk ${disk.deviceName}`}
              value={`${disk.diskType} · ${formatBytes(disk.sizeBytes)} · ${disk.systemDisk ? "system" : "data"}${disk.readonly ? " · read-only" : ""}${disk.model ? ` · ${disk.model}` : ""}`}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)" }}>
      <div className="card__head">
        <div>
          <h3>{title}</h3>
        </div>
      </div>
      {children}
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

function loadLabel(telemetry: TalosHostTelemetry | null): string {
  const load = telemetry?.loadAverage;
  if (!load) return "—";
  return `${load.load1.toFixed(2)} / ${load.load5.toFixed(2)} / ${load.load15.toFixed(2)}`;
}

function memoryLabel(telemetry: TalosHostTelemetry | null): string {
  const memory = telemetry?.memory;
  if (!memory) return "—";
  return `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)} (${formatPercent(memory.usedPercent)})`;
}

function networkLabel(telemetry: TalosHostTelemetry | null): string {
  const total = telemetry?.network.find((row) => row.name === "total") ?? telemetry?.network[0];
  if (!total) return "—";
  const errors = total.rxErrors + total.txErrors + total.rxDropped + total.txDropped;
  return `rx ${formatBytes(total.rxBytes)} · tx ${formatBytes(total.txBytes)} · errors/drops ${errors.toLocaleString()}`;
}

function diskIoLabel(telemetry: TalosHostTelemetry | null): string {
  const total = telemetry?.diskIo.find((row) => row.name === "total") ?? telemetry?.diskIo[0];
  if (!total) return "—";
  return `read ${formatBytes(total.readBytes)} · write ${formatBytes(total.writeBytes)} · in-flight ${total.ioInProgress.toLocaleString()}`;
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
