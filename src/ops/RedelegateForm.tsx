// Inline form rendered inside the Operations drawer when the active
// OpRequest.kind === "redelegate". It captures the arguments for the
// delegation precompile's signed `redelegate(fromCluster,toCluster,weightBps)`
// call and writes them into `request.redelegateInput`.
//
// Dummy-proofing: source/destination are picked from the LIVE cluster
// directory (dropdowns) and the weight is a percentage slider mapped to
// basis points. Raw numeric inputs remain as the fallback when the
// cluster directory is unavailable on the connected endpoint.

import { useMemo, type CSSProperties } from "react";
import { clusterLabel, useClusterDirectory } from "../sdk";
import { useOps } from "./OpsContext";
import type { RedelegateInput } from "./types";

const MAX_CLUSTER_ID = 0xffff_ffff;
const MAX_WEIGHT_BPS = 10_000;

function parseUintInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

function parseClusterId(value: string): number | null {
  const parsed = parseUintInput(value);
  if (parsed === null || parsed > MAX_CLUSTER_ID) return null;
  return parsed;
}

function parseWeightBps(value: string): number | null {
  const parsed = parseUintInput(value);
  if (parsed === null || parsed < 1 || parsed > MAX_WEIGHT_BPS) return null;
  return parsed;
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

const selectStyle: CSSProperties = {
  border: "1px solid var(--glass-stroke)",
  borderRadius: 8,
  background: "rgba(255, 255, 255, 0.04)",
  padding: "7px 10px",
  color: "var(--fg-100)",
  fontSize: 12,
};

export function RedelegateForm() {
  const { request, setRedelegateInput } = useOps();
  const input = request?.redelegateInput;
  const directory = useClusterDirectory(0, 100);
  const clusterRows = useMemo(() => directory.data ?? [], [directory.data]);
  const hasDirectory = clusterRows.length > 0;
  const validity = useMemo(() => {
    const fromOk =
      !!input &&
      Number.isInteger(input.fromCluster) &&
      input.fromCluster >= 0 &&
      input.fromCluster <= MAX_CLUSTER_ID;
    const toOk =
      !!input &&
      Number.isInteger(input.toCluster) &&
      input.toCluster >= 0 &&
      input.toCluster <= MAX_CLUSTER_ID;
    const weightOk =
      !!input &&
      Number.isInteger(input.weightBps) &&
      input.weightBps >= 1 &&
      input.weightBps <= MAX_WEIGHT_BPS;
    const routeOk = !!input && fromOk && toOk && input.fromCluster !== input.toCluster;
    return { fromOk, toOk, weightOk, routeOk };
  }, [input]);

  if (!request || request.kind !== "redelegate") return null;

  const current: Partial<RedelegateInput> = input ?? {};
  const weightBps = Number.isFinite(current.weightBps) ? (current.weightBps as number) : 0;
  const weightLabel = validity.weightOk
    ? `${(weightBps / 100).toFixed(2)}% of your delegation`
    : "pick a percentage (1 bps to 100%)";

  const setParsed = (key: keyof RedelegateInput, value: string) => {
    const parsed = key === "weightBps" ? parseWeightBps(value) : parseClusterId(value);
    if (parsed === null) {
      setRedelegateInput({ [key]: Number.NaN } as Partial<RedelegateInput>);
      return;
    }
    setRedelegateInput({ [key]: parsed } as Partial<RedelegateInput>);
  };

  const clusterPicker = (
    key: "fromCluster" | "toCluster",
    label: string,
    valid: boolean,
  ) => {
    const value = current[key];
    const selected = Number.isFinite(value) ? (value as number) : null;
    return (
      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: key === "fromCluster" ? 0 : 12 }}
      >
        <span className="kv__k">{label}</span>
        {hasDirectory ? (
          <select
            value={selected !== null && clusterRows.some((row) => row.clusterId === selected) ? selected : ""}
            onChange={(e) => setParsed(key, e.target.value)}
            style={{ ...selectStyle, borderColor: valid ? "var(--glass-stroke)" : "var(--err-500, #c53030)" }}
          >
            <option value="" disabled>
              select a cluster…
            </option>
            {clusterRows.map((row) => (
              <option key={row.clusterId} value={row.clusterId}>
                {clusterLabel(row.clusterId)} · {row.threshold}-of-{row.size} ·{" "}
                {row.active ? "active" : "inactive"}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_CLUSTER_ID}
            placeholder={key === "fromCluster" ? "1" : "2"}
            value={selected ?? ""}
            onChange={(e) => setParsed(key, e.target.value)}
            style={inputStyle(valid)}
          />
        )}
        {!hasDirectory ? (
          <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
            {directory.notExposed
              ? "Cluster directory is not available from this node yet — enter the cluster id manually."
              : directory.loading
                ? "Loading the live cluster directory…"
                : "No clusters listed — enter the cluster id manually."}
          </span>
        ) : null}
      </label>
    );
  };

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>redelegate inputs</div>

      {clusterPicker("fromCluster", "From cluster (current delegation)", validity.fromOk)}
      {clusterPicker("toCluster", "To cluster (destination)", validity.toOk && validity.routeOk)}

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}>
        <span className="kv__k">Weight to move · {weightLabel}</span>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input
            type="range"
            min={1}
            max={MAX_WEIGHT_BPS}
            step={1}
            value={validity.weightOk ? weightBps : MAX_WEIGHT_BPS}
            onChange={(e) => setParsed("weightBps", e.target.value)}
            style={{ flex: 1, accentColor: "var(--gold, #F2B441)" }}
            aria-label="Weight to move (percent)"
          />
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_WEIGHT_BPS}
            placeholder="10000"
            value={Number.isFinite(current.weightBps) ? current.weightBps : ""}
            onChange={(e) => setParsed("weightBps", e.target.value)}
            style={{ ...inputStyle(validity.weightOk), width: 90 }}
            aria-label="Weight in basis points"
          />
        </div>
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          10,000 basis points = 100% of your delegation in the source cluster. Quick picks:{" "}
          {[2500, 5000, 7500, 10000].map((bps, i) => (
            <button
              key={bps}
              type="button"
              onClick={() => setRedelegateInput({ weightBps: bps })}
              style={{
                background: "none",
                border: "none",
                color: "var(--gold, #F2B441)",
                cursor: "pointer",
                padding: 0,
                fontSize: 10.5,
                marginLeft: i === 0 ? 4 : 8,
              }}
            >
              {bps / 100}%
            </button>
          ))}
        </span>
      </label>

      {!validity.routeOk && validity.fromOk && validity.toOk ? (
        <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--err-300, #fc8181)" }}>
          Destination cluster must differ from the source cluster.
        </p>
      ) : null}
    </div>
  );
}

export function isRedelegateInputComplete(
  input: RedelegateInput | undefined,
): boolean {
  if (!input) return false;
  if (
    !Number.isInteger(input.fromCluster) ||
    input.fromCluster < 0 ||
    input.fromCluster > MAX_CLUSTER_ID
  ) {
    return false;
  }
  if (
    !Number.isInteger(input.toCluster) ||
    input.toCluster < 0 ||
    input.toCluster > MAX_CLUSTER_ID
  ) {
    return false;
  }
  if (input.fromCluster === input.toCluster) return false;
  if (
    !Number.isInteger(input.weightBps) ||
    input.weightBps < 1 ||
    input.weightBps > MAX_WEIGHT_BPS
  ) {
    return false;
  }
  return true;
}
