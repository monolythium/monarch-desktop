import { useMemo, type CSSProperties } from "react";
import {
  CLUSTER_NAME_MAX_BYTES,
  clusterNameAnnualFeeLythoshi,
  normalizeClusterName,
  parseClusterNameId,
} from "../sdk/clusterNameOps";
import { useOps } from "./OpsContext";
import type { ClusterNameInput } from "./types";

function inputStyle(valid: boolean, mono = false): CSSProperties {
  return {
    background: "rgba(0,0,0,0.3)",
    border: valid
      ? "1px solid rgba(255,255,255,0.1)"
      : "1px solid var(--err-500, #c53030)",
    color: "var(--fg-200)",
    padding: "6px 8px",
    fontSize: 12,
    borderRadius: 6,
    fontFamily: mono ? "var(--font-mono, monospace)" : "inherit",
  };
}

function clusterIdStatus(value: string | undefined): { ok: boolean; message: string } {
  try {
    parseClusterNameId(value ?? "");
    return { ok: true, message: "uint64 cluster id" };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

function nameStatus(value: string | undefined): {
  ok: boolean;
  bytes: number;
  fee: string | null;
  message: string;
} {
  try {
    const normalized = normalizeClusterName(value ?? "");
    return {
      ok: true,
      bytes: normalized.bytes.length,
      fee: clusterNameAnnualFeeLythoshi(normalized.name).toString(),
      message: `${normalized.bytes.length}/${CLUSTER_NAME_MAX_BYTES} bytes`,
    };
  } catch (err) {
    return { ok: false, bytes: 0, fee: null, message: (err as Error).message };
  }
}

export function ClusterNameForm() {
  const { request, setClusterNameInput } = useOps();
  const input = request?.clusterNameInput;

  const validity = useMemo(
    () => ({
      clusterId: clusterIdStatus(input?.clusterId),
      name: nameStatus(input?.name),
    }),
    [input?.clusterId, input?.name],
  );

  if (!request || request.kind !== "cluster-name-register") return null;

  const current: ClusterNameInput = input ?? { clusterId: "", name: "" };

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>cluster name registry</div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Cluster id</span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="0"
          value={current.clusterId}
          onChange={(e) => setClusterNameInput({ clusterId: e.target.value.trim() })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.clusterId.ok, true)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          {validity.clusterId.message}
        </span>
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Cluster name</span>
        <input
          type="text"
          placeholder="athena"
          value={current.name}
          onChange={(e) => setClusterNameInput({ name: e.target.value })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.name.ok)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          {validity.name.message}
          {validity.name.fee ? ` · fee ${validity.name.fee} lythoshi` : ""}
        </span>
      </label>

      <div className="halo halo--warn" style={{ alignSelf: "flex-start", marginTop: 12 }}>
        <span className="dot" /> Requires the cluster primary anchor key.
      </div>
    </div>
  );
}

export function isClusterNameInputComplete(input: ClusterNameInput | undefined): boolean {
  if (!input) return false;
  try {
    parseClusterNameId(input.clusterId);
    normalizeClusterName(input.name);
    return true;
  } catch {
    return false;
  }
}
