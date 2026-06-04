// Inline form rendered for foundation-coordinated cluster admission /
// slot-swap operations. It captures the node-registry pending-change
// calldata fields and stores them on the active OpRequest.

import { useMemo, type CSSProperties } from "react";
import { useOps } from "./OpsContext";
import type { OpKind, PendingChangeInput } from "./types";

const MAX_PENDING_CHANGE_INTENT_ID = (1n << 56n) - 1n;

function normalizeHex(value: string): string {
  const clean = value.trim().replace(/^0x/iu, "");
  return clean ? `0x${clean.toLowerCase()}` : "";
}

function isBlsPubkeyHex(value: string | undefined): boolean {
  return !!value && /^0x[0-9a-fA-F]{96}$/u.test(value.trim());
}

function parseDecimal(value: string | undefined): bigint | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  return BigInt(value.trim());
}

function isPositiveUint64(value: string | undefined): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed > 0n && parsed <= (1n << 64n) - 1n;
}

function isRotateIntentId(value: string | undefined): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed > 0n && parsed <= MAX_PENDING_CHANGE_INTENT_ID;
}

function isZeroIntentId(value: string | undefined): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed === 0n;
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

export function pendingChangeKindForOp(kind: OpKind): PendingChangeInput["kind"] | null {
  switch (kind) {
    case "cluster-accept-invite":
      return "add";
    case "cluster-swap":
      return "rotate";
    default:
      return null;
  }
}

export function ClusterPendingChangeForm() {
  const { request, setPendingChangeInput } = useOps();
  const pendingKind = request ? pendingChangeKindForOp(request.kind) : null;
  const input = request?.pendingChangeInput;
  const validity = useMemo(() => {
    const blsPubkeyOk = isBlsPubkeyHex(input?.targetPubkeyHex);
    const effectiveEpochOk = isPositiveUint64(input?.effectiveEpoch);
    const intentIdOk =
      pendingKind === "rotate"
        ? isRotateIntentId(input?.intentId)
        : isZeroIntentId(input?.intentId ?? "0");
    return { blsPubkeyOk, effectiveEpochOk, intentIdOk };
  }, [input?.effectiveEpoch, input?.intentId, input?.targetPubkeyHex, pendingKind]);

  if (!request || !pendingKind) return null;

  const current: PendingChangeInput = input ?? {
    kind: pendingKind,
    targetPubkeyHex: "",
    effectiveEpoch: "",
    intentId: pendingKind === "rotate" ? "" : "0",
  };

  const setField = (patch: Partial<PendingChangeInput>) => {
    setPendingChangeInput({ kind: pendingKind, ...patch });
  };

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>
        {pendingKind === "rotate" ? "cluster swap pending-change" : "cluster invite pending-change"}
      </div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Target BLS pubkey</span>
        <input
          type="text"
          inputMode="text"
          placeholder={`0x${"00".repeat(48)}`}
          value={current.targetPubkeyHex}
          onChange={(e) => setField({ targetPubkeyHex: normalizeHex(e.target.value) })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.blsPubkeyOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          48-byte compressed BLS-G1 pubkey carried in submitPendingChange.
        </span>
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Effective epoch</span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="epoch"
          value={current.effectiveEpoch}
          onChange={(e) => setField({ effectiveEpoch: e.target.value.trim() })}
          spellCheck={false}
          autoComplete="off"
          style={inputStyle(validity.effectiveEpochOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Must be a future epoch; the chain rejects zero or current/past epochs.
        </span>
      </label>

      {pendingKind === "rotate" ? (
        <label
          className="kv"
          style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
        >
          <span className="kv__k">Swap intent id</span>
          <input
            type="text"
            inputMode="numeric"
            placeholder="intent id"
            value={current.intentId}
            onChange={(e) => setField({ intentId: e.target.value.trim() })}
            spellCheck={false}
            autoComplete="off"
            style={inputStyle(validity.intentIdOk)}
          />
          <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
            Rotate pending changes require a non-zero id below 2^56.
          </span>
        </label>
      ) : null}
    </div>
  );
}

export function isPendingChangeInputComplete(
  opKind: OpKind | undefined,
  input: PendingChangeInput | undefined,
): boolean {
  if (!opKind || !input) return false;
  const pendingKind = pendingChangeKindForOp(opKind);
  if (!pendingKind || input.kind !== pendingKind) return false;
  return (
    isBlsPubkeyHex(input.targetPubkeyHex) &&
    isPositiveUint64(input.effectiveEpoch) &&
    (pendingKind === "rotate"
      ? isRotateIntentId(input.intentId)
      : isZeroIntentId(input.intentId))
  );
}
