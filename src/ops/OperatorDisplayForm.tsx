import { useMemo, type CSSProperties } from "react";
import {
  OPERATOR_ALIAS_MAX_BYTES,
  OPERATOR_MONIKER_MAX_BYTES,
  normalizeOperatorDisplay,
  normalizeOperatorDisplayField,
} from "../sdk/operatorDisplayOps";
import { useOps } from "./OpsContext";
import type { OperatorDisplayInput } from "./types";

function normalizePeerId(value: string): string {
  const clean = value.trim().replace(/^0x/iu, "");
  return clean ? `0x${clean.toLowerCase()}` : "";
}

function isPeerIdHex(value: string | undefined): boolean {
  if (!value) return false;
  return /^0x[0-9a-fA-F]{64}$/u.test(value.trim());
}

function displayStatus(
  value: string | undefined,
  maxBytes: number,
  label: string,
): { ok: boolean; message: string } {
  try {
    const bytes = normalizeOperatorDisplayField(value ?? "", maxBytes, label);
    return {
      ok: true,
      message: bytes.length === 0 ? "Leave empty to clear this field." : "Looks good.",
    };
  } catch (err) {
    const message = (err as Error).message;
    return {
      ok: false,
      message: /control characters/iu.test(message)
        ? `${label} contains unsupported characters.`
        : `${label} is too long.`,
    };
  }
}

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

export function OperatorDisplayForm() {
  const { request, setOperatorDisplayInput } = useOps();
  const input = request?.operatorDisplayInput;

  const validity = useMemo(() => {
    const peerIdOk = isPeerIdHex(input?.peerIdHex);
    const moniker = displayStatus(input?.moniker, OPERATOR_MONIKER_MAX_BYTES, "Moniker");
    const alias = displayStatus(input?.alias, OPERATOR_ALIAS_MAX_BYTES, "Alias");
    return { peerIdOk, moniker, alias };
  }, [input?.alias, input?.moniker, input?.peerIdHex]);

  if (!request || request.kind !== "operator-display") return null;

  const current: OperatorDisplayInput = input ?? {
    peerIdHex: "",
    moniker: "",
    alias: "",
  };

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>operator public profile</div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Operator ID</span>
        <input
          type="text"
          inputMode="text"
          placeholder={`0x${"00".repeat(32)}`}
          value={current.peerIdHex}
          onChange={(e) => setOperatorDisplayInput({ peerIdHex: normalizePeerId(e.target.value) })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.peerIdOk, true)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Filled from your operator key when available.
        </span>
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Public name</span>
        <input
          type="text"
          placeholder="Monolythium Operator 01"
          value={current.moniker}
          onChange={(e) => setOperatorDisplayInput({ moniker: e.target.value })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.moniker.ok)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          {validity.moniker.message}
        </span>
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Alias</span>
        <input
          type="text"
          placeholder="operator-01"
          value={current.alias}
          onChange={(e) => setOperatorDisplayInput({ alias: e.target.value })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.alias.ok)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          {validity.alias.message}
        </span>
      </label>
    </div>
  );
}

export function isOperatorDisplayInputComplete(
  input: OperatorDisplayInput | undefined,
): boolean {
  if (!input || !isPeerIdHex(input.peerIdHex)) return false;
  try {
    normalizeOperatorDisplay({ moniker: input.moniker ?? "", alias: input.alias ?? "" });
    return true;
  } catch {
    return false;
  }
}
