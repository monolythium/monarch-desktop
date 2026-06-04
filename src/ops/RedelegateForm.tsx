// Inline form rendered inside the Operations drawer when the active
// OpRequest.kind === "redelegate". It captures the arguments for the
// delegation precompile's signed `redelegate(fromCluster,toCluster,weightBps)`
// call and writes them into `request.redelegateInput`.

import { useMemo, type CSSProperties } from "react";
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

export function RedelegateForm() {
  const { request, setRedelegateInput } = useOps();
  const input = request?.redelegateInput;
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
  const weightLabel = validity.weightOk
    ? `${((current.weightBps ?? 0) / 100).toFixed(2)}%`
    : "1 to 10000 basis points";

  const setParsed = (key: keyof RedelegateInput, value: string) => {
    const parsed = key === "weightBps" ? parseWeightBps(value) : parseClusterId(value);
    if (parsed === null) {
      setRedelegateInput({ [key]: Number.NaN } as Partial<RedelegateInput>);
      return;
    }
    setRedelegateInput({ [key]: parsed } as Partial<RedelegateInput>);
  };

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>redelegate inputs</div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">From cluster</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_CLUSTER_ID}
          placeholder="1"
          value={Number.isFinite(current.fromCluster) ? current.fromCluster : ""}
          onChange={(e) => setParsed("fromCluster", e.target.value)}
          style={inputStyle(validity.fromOk)}
        />
      </label>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}>
        <span className="kv__k">To cluster</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_CLUSTER_ID}
          placeholder="2"
          value={Number.isFinite(current.toCluster) ? current.toCluster : ""}
          onChange={(e) => setParsed("toCluster", e.target.value)}
          style={inputStyle(validity.toOk && validity.routeOk)}
        />
      </label>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}>
        <span className="kv__k">Weight</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_WEIGHT_BPS}
          placeholder="10000"
          value={Number.isFinite(current.weightBps) ? current.weightBps : ""}
          onChange={(e) => setParsed("weightBps", e.target.value)}
          style={inputStyle(validity.weightOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          {weightLabel}
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
