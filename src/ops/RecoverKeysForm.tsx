// Inline form rendered inside the Operations drawer when the active
// OpRequest.kind === "operator-recover-keys". It is the MANUAL escape hatch for
// the seat-preserving recovery: auto-resolution (resolveNodeTarget) anchors the
// host to the active connection and best-effort-resolves the disk, but a
// quarantined / booting node can leave the disk (or, rarely, the host) blank.
// This form lets the operator type the Talos host (the node IP they connected
// with) and the install disk (e.g. /dev/sda) so the op never dead-ends with
// "missing host or install disk". When the host is known and reachable in
// maintenance mode, the install disk is offered as a picker (the same
// maintenance-disk enumeration the provisioning flow uses), with free-text
// `/dev/<name>` as the guaranteed fallback.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useOps } from "./OpsContext";
import { talosMaintenanceDisks, type MaintenanceDisk } from "../sdk";
import type { RecoverKeysInput } from "./types";

const HOST_MAX_LEN = 253;
// A host is an IPv4/IPv6 literal or a DNS name — accept the same shapes the
// provisioning flow accepts. Loose on purpose: the Rust side validates the
// reachable endpoint; this only blocks empty / obviously-wrong values.
const HOST_RE = /^[A-Za-z0-9._:[\]-]{2,253}$/u;
// /dev/<name> — kernel block-device path. The provisioning flow already uses
// this form (the Rust side prefixes the bare kernel name).
const DISK_RE = /^\/dev\/[A-Za-z0-9/_-]{1,64}$/u;

export function isValidRecoverHost(value: string | undefined): boolean {
  const v = value?.trim() ?? "";
  if (v.length < 2 || v.length > HOST_MAX_LEN) return false;
  return HOST_RE.test(v);
}

export function isValidRecoverDisk(value: string | undefined): boolean {
  const v = value?.trim() ?? "";
  if (!v) return false;
  if (v.includes("..")) return false;
  return DISK_RE.test(v);
}

export function isRecoverKeysInputComplete(input: RecoverKeysInput | undefined): boolean {
  if (!input) return false;
  return isValidRecoverHost(input.host) && isValidRecoverDisk(input.disk);
}

function inputStyle(valid: boolean): CSSProperties {
  return {
    background: "rgba(0,0,0,0.3)",
    border: valid
      ? "1px solid rgba(255,255,255,0.1)"
      : "1px solid var(--err-500, #c53030)",
    color: "var(--fg-200)",
    padding: "6px 8px",
    fontSize: 12,
    borderRadius: 6,
    fontFamily: "var(--font-mono, monospace)",
  };
}

export function RecoverKeysForm() {
  const { request, setRecoverKeysInput } = useOps();
  const input = request?.recoverKeysInput;
  const host = input?.host ?? "";
  const disk = input?.disk ?? "";

  const hostOk = useMemo(() => isValidRecoverHost(host), [host]);
  const diskOk = useMemo(() => isValidRecoverDisk(disk), [disk]);

  const [disks, setDisks] = useState<MaintenanceDisk[]>([]);

  // When the host is set + valid, best-effort fetch the maintenance disk list to
  // offer a picker. A maintenance-mode RPC that errors on a running node simply
  // leaves the free-text field as the (guaranteed) entry path.
  useEffect(() => {
    if (request?.kind !== "operator-recover-keys") return;
    if (!hostOk) {
      setDisks([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const found = await talosMaintenanceDisks(host.trim());
        if (!cancelled) setDisks(found.filter((d) => !d.readonly));
      } catch {
        if (!cancelled) setDisks([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request?.kind, host, hostOk]);

  if (!request || request.kind !== "operator-recover-keys") return null;

  const bothEmpty = !host.trim() && !disk.trim();

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>recovery target</div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Node host</span>
        <input
          type="text"
          inputMode="text"
          placeholder="node IP / address (e.g. 203.0.113.10)"
          value={host}
          onChange={(e) => setRecoverKeysInput({ host: e.target.value.trim() })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(hostOk || host.trim() === "")}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          The Talos node you connected with. Auto-filled from the active connection when available.
        </span>
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Install disk</span>
        {disks.length > 0 ? (
          <select
            value={disks.some((d) => d.deviceName === disk) ? disk : ""}
            onChange={(e) => setRecoverKeysInput({ disk: e.target.value })}
            style={inputStyle(true)}
          >
            <option value="">— pick the install disk —</option>
            {disks.map((d) => (
              <option key={d.deviceName} value={d.deviceName}>
                {d.deviceName}
                {d.systemDiskHint ? " (system)" : ""} · {d.sizeHuman} · {d.model || d.diskType}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            inputMode="text"
            placeholder="/dev/sda"
            value={disk}
            onChange={(e) => setRecoverKeysInput({ disk: e.target.value.trim() })}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            style={inputStyle(diskOk || disk.trim() === "")}
          />
        )}
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          {bothEmpty
            ? "Auto-detect couldn't read this node's disk — enter the install disk (e.g. /dev/sda) to proceed."
            : "The node's system / install disk, in /dev/<name> form."}
        </span>
      </label>

      {!isRecoverKeysInputComplete(input) ? (
        <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--err-300, #fc8181)" }}>
          Enter a reachable node host and a /dev/&lt;name&gt; install disk to recover this node.
        </p>
      ) : null}
    </div>
  );
}
