// Inline form for the operator-callable
// `attestDkgReshare(uint64,bytes,bytes)` node-registry path.

import { useMemo, useState, type CSSProperties } from "react";
import { parseDkgReshareAttestationArtifact } from "../sdk/dkgReshareOps";
import { useOps } from "./OpsContext";
import type { DkgReshareAttestationInput } from "./types";

const MAX_INTENT_ID = (1n << 56n) - 1n;

function normalizeHex(value: string): string {
  const clean = value.trim().replace(/^0x/iu, "");
  return clean ? `0x${clean.toLowerCase()}` : "";
}

function parseDecimal(value: string | undefined): bigint | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  return BigInt(value.trim());
}

function isIntentId(value: string | undefined): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed > 0n && parsed <= MAX_INTENT_ID;
}

function isHexBytes(value: string | undefined, expectedBytes: number): boolean {
  return !!value && new RegExp(`^0x[0-9a-fA-F]{${expectedBytes * 2}}$`, "u").test(value.trim());
}

function blsSignerCount(value: string | undefined): number | null {
  if (!value || !/^0x[0-9a-fA-F]+$/u.test(value.trim())) return null;
  const bytes = (value.trim().length - 2) / 2;
  if (!Number.isInteger(bytes) || bytes % 48 !== 0) return null;
  return bytes / 48;
}

function hasDuplicatePubkey(value: string | undefined): boolean {
  if (!value || !/^0x[0-9a-fA-F]+$/u.test(value.trim())) return false;
  const clean = value.trim().slice(2).toLowerCase();
  const seen = new Set<string>();
  for (let offset = 0; offset < clean.length; offset += 96) {
    const key = clean.slice(offset, offset + 96);
    if (key.length !== 96) return false;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function isBlsPublicKeys(value: string | undefined): boolean {
  const count = blsSignerCount(value);
  return count !== null && count >= 5 && count <= 7 && !hasDuplicatePubkey(value);
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

export function DkgReshareAttestationForm() {
  const { request, setDkgReshareInput } = useOps();
  const [artifactText, setArtifactText] = useState("");
  const [artifactStatus, setArtifactStatus] = useState<string | null>(null);
  const input = request?.dkgReshareInput;
  const validity = useMemo(() => {
    const intentOk = isIntentId(input?.intentId);
    const keysOk = isBlsPublicKeys(input?.blsPublicKeysHex);
    const sigOk = isHexBytes(input?.thresholdSigHex, 96);
    return { intentOk, keysOk, sigOk };
  }, [input?.blsPublicKeysHex, input?.intentId, input?.thresholdSigHex]);

  if (!request || request.kind !== "rotate-keys") return null;

  const current: Partial<DkgReshareAttestationInput> = input ?? {};
  const signerCount = blsSignerCount(current.blsPublicKeysHex);
  const importArtifact = () => {
    try {
      const parsed = parseDkgReshareAttestationArtifact(artifactText);
      setDkgReshareInput({
        intentId: parsed.intentId,
        blsPublicKeysHex: parsed.blsPublicKeysHex,
        thresholdSigHex: parsed.thresholdSigHex,
      });
      setArtifactStatus(
        `Imported ${parsed.signerCount} signer${parsed.signerCount === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      setArtifactStatus((err as Error).message);
    }
  };

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>DKG re-share attestation</div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Ceremony attestation JSON</span>
        <textarea
          placeholder='{"schema_version":"monarch-dkg-reshare-attestation/v1",...}'
          value={artifactText}
          onChange={(e) => {
            setArtifactText(e.target.value);
            setArtifactStatus(null);
          }}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          rows={3}
          style={{ ...inputStyle(true), resize: "vertical" }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={!artifactText.trim()}
            onClick={importArtifact}
          >
            Import JSON
          </button>
          {artifactStatus ? (
            <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>{artifactStatus}</span>
          ) : null}
        </div>
      </label>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Swap intent id</span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="intent id"
          value={current.intentId ?? ""}
          onChange={(e) => setDkgReshareInput({ intentId: e.target.value.trim() })}
          spellCheck={false}
          autoComplete="off"
          style={inputStyle(validity.intentOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          The Rotate intent id generated by submitPendingChange.
        </span>
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Participant BLS pubkeys</span>
        <textarea
          placeholder={`0x${"00".repeat(48 * 5)}`}
          value={current.blsPublicKeysHex ?? ""}
          onChange={(e) => setDkgReshareInput({ blsPublicKeysHex: normalizeHex(e.target.value) })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          rows={4}
          style={{ ...inputStyle(validity.keysOk), resize: "vertical" }}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Concatenated 48-byte BLS pubkeys; 5 to 7 unique signers required.
          {signerCount !== null ? ` Parsed ${signerCount} signer${signerCount === 1 ? "" : "s"}.` : ""}
        </span>
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Threshold signature</span>
        <textarea
          placeholder={`0x${"00".repeat(96)}`}
          value={current.thresholdSigHex ?? ""}
          onChange={(e) => setDkgReshareInput({ thresholdSigHex: normalizeHex(e.target.value) })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          rows={3}
          style={{ ...inputStyle(validity.sigOk), resize: "vertical" }}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          96-byte aggregate BLS-G2 signature over the DKG attestation message.
        </span>
      </label>
    </div>
  );
}

export function isDkgReshareAttestationInputComplete(
  input: DkgReshareAttestationInput | undefined,
): boolean {
  return (
    !!input &&
    isIntentId(input.intentId) &&
    isBlsPublicKeys(input.blsPublicKeysHex) &&
    isHexBytes(input.thresholdSigHex, 96)
  );
}
