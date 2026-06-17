// READ-ONLY node-status header.
//
// Brings the Talos console/VNC dashboard's at-a-glance fields into Monarch so
// an operator doesn't have to open the VNC console to check node health: Stage,
// health/ready, hostname, Talos version + uptime, node addresses, and the key
// service states (ext-protocore, kubelet). All pulled over Talos *read* RPCs
// (`useTalosNodeStatus` → `talos_node_status`) — nothing here controls the node.
//
// Compact, matches the app's card / halo / mono tokens. Reusable: drop it atop
// any view that wants the OS-side health line (currently the Logs page). Every
// field degrades to a muted "—" when the node can't report it — a missing field
// never paints red; only a hard read failure dims the whole row.

import {
  formatUptime,
  readyView,
  serviceTone,
  stageTone,
  useTalosNodeStatus,
  type NodeStatusTone,
} from "../sdk";

const TONE_VAR: Record<NodeStatusTone, string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  err: "var(--err)",
  info: "var(--info)",
  muted: "var(--fg-400)",
};

/** One labelled stat cell. Value is muted when absent ("—"). */
function Field({
  label,
  value,
  tone = "muted",
  title,
}: {
  label: string;
  value: string | null | undefined;
  tone?: NodeStatusTone;
  title?: string;
}) {
  const shown = value && value.trim() !== "" ? value : "—";
  const isPlaceholder = shown === "—";
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}
      title={title}
    >
      <span className="cap">{label}</span>
      <span
        className="mono"
        style={{
          fontSize: 13,
          color: isPlaceholder ? "var(--fg-400)" : TONE_VAR[tone],
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {shown}
      </span>
    </div>
  );
}

export type NodeStatusHeaderProps = {
  /** When false, the header idles in the unavailable state (e.g. the view isn't
   *  pointed at a Monarch OS node). Defaults to true. */
  active?: boolean;
};

/**
 * READ-ONLY node-status header. Renders nothing-but-chrome outside Tauri / when
 * inactive (so the `pnpm dev` preview and the local log target don't show a
 * fake node). Inside Tauri it polls the snapshot and lays the fields out in a
 * single compact card.
 */
export function NodeStatusHeader({ active = true }: NodeStatusHeaderProps) {
  const { data, loading, error, unavailable } = useTalosNodeStatus({ active });

  // Hide entirely when there's no Monarch OS node in scope — the header is
  // additive context, not a permanent fixture, and an empty placeholder on the
  // local/browser path would be noise.
  if (unavailable) return null;

  const stage = data?.stage ?? null;
  const ready = readyView(data?.ready, data?.unmetConditions ?? []);
  const protocore = data?.services.find((s) => s.id === "ext-protocore") ?? null;
  const kubelet = data?.services.find((s) => s.id === "kubelet") ?? null;

  const version =
    data?.talosVersion && data.talosArch
      ? `${data.talosVersion} · ${data.talosArch}`
      : (data?.talosVersion ?? null);

  const address = data?.addresses?.[0] ?? null;
  const extraAddresses =
    data && data.addresses.length > 1 ? data.addresses.length - 1 : 0;

  // Health dot: a hard read error dims the row; otherwise it tracks readiness.
  const headerTone: NodeStatusTone = error ? "warn" : ready.tone;

  return (
    <div
      className="card"
      style={{
        padding: "12px 18px",
        display: "flex",
        alignItems: "center",
        gap: 22,
        flexWrap: "wrap",
        opacity: loading && !data ? 0.7 : 1,
      }}
      aria-label="node status"
    >
      <span
        className={`halo halo--${headerTone === "muted" ? "info" : headerTone}`}
        title={
          error
            ? `Node status read failed: ${error}. Other Talos reads may still work — last good values shown.`
            : "Read-only node status from the Talos API (no VNC console needed)."
        }
        style={{ flex: "0 0 auto" }}
      >
        <span className="dot" /> Node status
      </span>

      <Field
        label="stage"
        value={stage}
        tone={stageTone(stage)}
        title={stage ? `Talos machine stage: ${stage}` : "stage not reported yet"}
      />
      <Field
        label="health"
        value={ready.label}
        tone={ready.tone}
        title={
          data?.unmetConditions && data.unmetConditions.length > 0
            ? `unmet: ${data.unmetConditions.join(", ")}`
            : "MachineStatus ready"
        }
      />
      <Field
        label="host"
        value={data?.hostname ?? null}
        tone={data?.hostname ? "ok" : "muted"}
      />
      <Field
        label="talos · arch"
        value={version}
        tone={version ? "info" : "muted"}
      />
      <Field
        label="uptime"
        value={data ? formatUptime(data.uptimeSeconds) : null}
        tone={data?.uptimeSeconds != null ? "ok" : "muted"}
      />
      <Field
        label="address"
        value={address}
        tone={address ? "info" : "muted"}
        title={
          data && data.addresses.length > 0
            ? data.addresses.join(", ")
            : "node addresses not reported"
        }
      />
      {extraAddresses > 0 ? (
        <span
          className="mono"
          style={{ fontSize: 10.5, color: "var(--fg-400)", alignSelf: "flex-end" }}
          title={data?.addresses.join(", ")}
        >
          +{extraAddresses}
        </span>
      ) : null}

      <span style={{ flex: 1 }} />

      <Field
        label="ext-protocore"
        value={protocore?.displayState ?? null}
        tone={serviceTone(protocore?.severity)}
        title={
          protocore
            ? `ext-protocore: ${protocore.displayState} (raw: ${protocore.state})`
            : "ext-protocore service not reported"
        }
      />
      <Field
        label="kubelet"
        value={kubelet?.displayState ?? null}
        tone={serviceTone(kubelet?.severity)}
        title={
          kubelet
            ? `kubelet: ${kubelet.displayState} (raw: ${kubelet.state})`
            : "kubelet service not reported"
        }
      />
    </div>
  );
}
