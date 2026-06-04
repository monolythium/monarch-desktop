// Inline forms for foundation incident-response executors.

import { useMemo, type CSSProperties } from "react";
import { NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES } from "../sdk/operatorKeys";
import { useOps } from "./OpsContext";
import type { EmergencyKeyRotationInput, FreezeAdmissionInput } from "./types";

const MAX_INCIDENT_INTENT_ID = (1n << 56n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const CONSENSUS_PUBKEY_HEX_CHARS = NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES * 2;

function normalizeHex(value: string): string {
  const clean = value.trim().replace(/^0x/iu, "");
  return clean ? `0x${clean.toLowerCase()}` : "";
}

function isHash32(value: string | undefined): boolean {
  return !!value && /^0x[0-9a-fA-F]{64}$/u.test(value.trim());
}

function isConsensusPubkey(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return (
    trimmed.length === CONSENSUS_PUBKEY_HEX_CHARS + 2 &&
    /^0x[0-9a-fA-F]+$/u.test(trimmed)
  );
}

function parseDecimal(value: string | undefined): bigint | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  return BigInt(value.trim());
}

function isPositiveUint64(value: string | undefined): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed > 0n && parsed <= MAX_UINT64;
}

function isIntentId(value: string | undefined): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed > 0n && parsed <= MAX_INCIDENT_INTENT_ID;
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

export function FreezeAdmissionForm() {
  const { request, setFreezeAdmissionInput } = useOps();
  const input = request?.freezeAdmissionInput;
  const valid = useMemo(
    () => isHash32(input?.reasonHashHex),
    [input?.reasonHashHex],
  );

  if (!request || request.kind !== "freeze-admission") return null;
  const current: Partial<FreezeAdmissionInput> = input ?? {};

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>incident freeze input</div>
      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Reason hash</span>
        <input
          type="text"
          inputMode="text"
          placeholder={`0x${"00".repeat(32)}`}
          value={current.reasonHashHex ?? ""}
          onChange={(e) =>
            setFreezeAdmissionInput({ reasonHashHex: normalizeHex(e.target.value) })
          }
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(valid)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          32-byte runbook or evidence hash supplied to freezeAdmission.
        </span>
      </label>
    </div>
  );
}

export function EmergencyKeyRotationForm() {
  const { request, setEmergencyKeyRotationInput } = useOps();
  const input = request?.emergencyKeyRotationInput;
  const validity = useMemo(
    () => ({
      pubkey: isConsensusPubkey(input?.targetPubkeyHex),
      epoch: isPositiveUint64(input?.effectiveEpoch),
      intent: isIntentId(input?.intentId),
    }),
    [input?.effectiveEpoch, input?.intentId, input?.targetPubkeyHex],
  );

  if (!request || request.kind !== "emergency-key-rotation") return null;
  const current: Partial<EmergencyKeyRotationInput> = input ?? {};

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>emergency key rotation input</div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Target consensus pubkey</span>
        <input
          type="text"
          inputMode="text"
          placeholder="0x..."
          value={current.targetPubkeyHex ?? ""}
          onChange={(e) =>
            setEmergencyKeyRotationInput({ targetPubkeyHex: normalizeHex(e.target.value) })
          }
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.pubkey)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          {NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES}-byte ML-DSA-65 pubkey queued as a Rotate pending change.
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
          value={current.effectiveEpoch ?? ""}
          onChange={(e) =>
            setEmergencyKeyRotationInput({ effectiveEpoch: e.target.value.trim() })
          }
          spellCheck={false}
          autoComplete="off"
          style={inputStyle(validity.epoch)}
        />
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Intent id</span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="intent id"
          value={current.intentId ?? ""}
          onChange={(e) =>
            setEmergencyKeyRotationInput({ intentId: e.target.value.trim() })
          }
          spellCheck={false}
          autoComplete="off"
          style={inputStyle(validity.intent)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Non-zero id below 2^56; the matching DKG attestation still follows.
        </span>
      </label>
    </div>
  );
}

export function isFreezeAdmissionInputComplete(
  input: FreezeAdmissionInput | undefined,
): boolean {
  return isHash32(input?.reasonHashHex);
}

export function isEmergencyKeyRotationInputComplete(
  input: EmergencyKeyRotationInput | undefined,
): boolean {
  return (
    isConsensusPubkey(input?.targetPubkeyHex) &&
    isPositiveUint64(input?.effectiveEpoch) &&
    isIntentId(input?.intentId)
  );
}
