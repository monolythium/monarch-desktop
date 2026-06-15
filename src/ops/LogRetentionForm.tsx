// Inline form rendered inside the Operations drawer when the active
// OpRequest.kind is "set-log-retention" or "clean-protocore-logs". It captures
// the protocore log retention bounds (max size in MB + rotated-file count) and
// writes them into `request.logRetentionInput`.

import { useMemo, type CSSProperties } from "react";
import { useOps } from "./OpsContext";
import {
  DEFAULT_LOG_RETENTION,
  LOG_RETENTION_LIMITS,
  isLogRetentionInputComplete,
  type LogRetentionInput,
} from "./types";

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
    width: 120,
  };
}

/** Parse an integer field, returning NaN for empty/non-numeric so the gate
 *  rejects it without coercing to 0. */
function parseIntField(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return Number.NaN;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : Number.NaN;
}

export function LogRetentionForm() {
  const { request, setLogRetentionInput } = useOps();
  const input = request?.logRetentionInput;
  const valid = useMemo(() => isLogRetentionInputComplete(input), [input]);

  if (
    !request ||
    (request.kind !== "set-log-retention" && request.kind !== "clean-protocore-logs")
  ) {
    return null;
  }

  const current: LogRetentionInput = input ?? { ...DEFAULT_LOG_RETENTION };
  const sizeOk =
    Number.isInteger(current.maxMegabytes) &&
    current.maxMegabytes >= LOG_RETENTION_LIMITS.minMegabytes &&
    current.maxMegabytes <= LOG_RETENTION_LIMITS.maxMegabytes;
  const filesOk =
    Number.isInteger(current.maxFiles) &&
    current.maxFiles >= LOG_RETENTION_LIMITS.minFiles &&
    current.maxFiles <= LOG_RETENTION_LIMITS.maxFiles;

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>log retention bounds</div>

      <label
        className="kv"
        style={{ alignItems: "center", justifyContent: "space-between", gap: 12 }}
      >
        <span>
          <span className="kv__k">Max size (MB)</span>
          <span style={{ display: "block", fontSize: 10.5, color: "var(--fg-400)" }}>
            Cap the protocore log at this many megabytes ({LOG_RETENTION_LIMITS.minMegabytes}–
            {LOG_RETENTION_LIMITS.maxMegabytes}).
          </span>
        </span>
        <input
          type="number"
          inputMode="numeric"
          min={LOG_RETENTION_LIMITS.minMegabytes}
          max={LOG_RETENTION_LIMITS.maxMegabytes}
          value={Number.isFinite(current.maxMegabytes) ? current.maxMegabytes : ""}
          onChange={(e) =>
            setLogRetentionInput({ maxMegabytes: parseIntField(e.target.value) })
          }
          style={inputStyle(sizeOk)}
        />
      </label>

      <label
        className="kv"
        style={{
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginTop: 12,
        }}
      >
        <span>
          <span className="kv__k">Rotated files</span>
          <span style={{ display: "block", fontSize: 10.5, color: "var(--fg-400)" }}>
            How many rotated log files to keep ({LOG_RETENTION_LIMITS.minFiles}–
            {LOG_RETENTION_LIMITS.maxFiles}).
          </span>
        </span>
        <input
          type="number"
          inputMode="numeric"
          min={LOG_RETENTION_LIMITS.minFiles}
          max={LOG_RETENTION_LIMITS.maxFiles}
          value={Number.isFinite(current.maxFiles) ? current.maxFiles : ""}
          onChange={(e) => setLogRetentionInput({ maxFiles: parseIntField(e.target.value) })}
          style={inputStyle(filesOk)}
        />
      </label>

      {!valid ? (
        <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--err-300, #fc8181)" }}>
          Enter a whole max size in MB ({LOG_RETENTION_LIMITS.minMegabytes}–
          {LOG_RETENTION_LIMITS.maxMegabytes}) and a rotated-file count (
          {LOG_RETENTION_LIMITS.minFiles}–{LOG_RETENTION_LIMITS.maxFiles}).
        </p>
      ) : null}
    </div>
  );
}
