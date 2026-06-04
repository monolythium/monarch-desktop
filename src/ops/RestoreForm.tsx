// Inline form rendered inside the Operations drawer when the active
// OpRequest.kind === "operator-restore". It captures the 32-byte
// node-registry peer id passed to recoverOperatorNode(bytes32).

import { useMemo, type CSSProperties } from "react";
import { useOps } from "./OpsContext";
import type { RestoreInput } from "./types";

function normalizePeerId(value: string): string {
  const clean = value.trim().replace(/^0x/iu, "");
  return clean ? `0x${clean.toLowerCase()}` : "";
}

function isPeerIdHex(value: string | undefined): boolean {
  if (!value) return false;
  return /^0x[0-9a-fA-F]{64}$/u.test(value.trim());
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

export function RestoreForm() {
  const { request, setRestoreInput } = useOps();
  const input = request?.restoreInput;
  const valid = useMemo(() => isPeerIdHex(input?.peerIdHex), [input?.peerIdHex]);

  if (!request || request.kind !== "operator-restore") return null;

  const current: Partial<RestoreInput> = input ?? {};

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>recovery input</div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Operator peer id</span>
        <input
          type="text"
          inputMode="text"
          placeholder={`0x${"00".repeat(32)}`}
          value={current.peerIdHex ?? ""}
          onChange={(e) => setRestoreInput({ peerIdHex: normalizePeerId(e.target.value) })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(valid)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Required by recoverOperatorNode(bytes32).
        </span>
      </label>
    </div>
  );
}

export function isRestoreInputComplete(input: RestoreInput | undefined): boolean {
  return isPeerIdHex(input?.peerIdHex);
}
