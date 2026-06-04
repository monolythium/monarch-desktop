// Inline form rendered inside the Operations drawer when the active
// OpRequest.kind === "ota-apply". It captures the Talos image reference
// for the Upgrade RPC and writes it into `request.otaApplyInput`.

import { useMemo, type CSSProperties } from "react";
import { useOps } from "./OpsContext";
import type { OtaApplyInput, OtaRebootMode } from "./types";

const IMAGE_MAX_LEN = 512;
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{1,511}$/u;
const SHA256_DIGEST_REF = /@sha256:[0-9a-fA-F]{64}$/u;

export function isValidUpgradeImage(image: string | undefined): boolean {
  const value = image?.trim() ?? "";
  if (value.length < 2 || value.length > IMAGE_MAX_LEN) return false;
  if (!IMAGE_REF.test(value)) return false;
  if (value.includes("..")) return false;
  if (!value.includes("/")) return false;
  if (value.includes("@sha256:")) return SHA256_DIGEST_REF.test(value);
  return (value.split("/").pop() ?? "").includes(":");
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

export function OtaApplyForm() {
  const { request, setOtaApplyInput } = useOps();
  const input = request?.otaApplyInput;
  const imageOk = useMemo(() => isValidUpgradeImage(input?.image), [input?.image]);

  if (!request || request.kind !== "ota-apply") return null;

  const current: OtaApplyInput = input ?? {
    image: "",
    stage: false,
    rebootMode: "default",
  };

  const setRebootMode = (value: string) => {
    const rebootMode: OtaRebootMode = value === "powercycle" ? "powercycle" : "default";
    setOtaApplyInput({ rebootMode });
  };

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>os upgrade inputs</div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Signed image reference</span>
        <input
          type="text"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="ghcr.io/monolythium/monarch-os:2026.06.01"
          value={current.image}
          onChange={(e) => setOtaApplyInput({ image: e.target.value })}
          style={inputStyle(imageOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Registry image with a tag or sha256 digest. Whitespace and bare names are rejected.
        </span>
      </label>

      <label
        className="kv"
        style={{ alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12 }}
      >
        <span>
          <span className="kv__k">Stage only</span>
          <span style={{ display: "block", fontSize: 10.5, color: "var(--fg-400)" }}>
            Download and prepare without immediate reboot when Talos supports staging.
          </span>
        </span>
        <input
          type="checkbox"
          checked={current.stage}
          onChange={(e) => setOtaApplyInput({ stage: e.target.checked })}
        />
      </label>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}>
        <span className="kv__k">Reboot mode</span>
        <select
          value={current.rebootMode}
          onChange={(e) => setRebootMode(e.target.value)}
          style={inputStyle(true)}
        >
          <option value="default">Default</option>
          <option value="powercycle">Powercycle</option>
        </select>
      </label>

      {!imageOk ? (
        <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--err-300, #fc8181)" }}>
          Enter the exact signed release image reference from the upgrade readiness output.
        </p>
      ) : null}
    </div>
  );
}

export function isOtaApplyInputComplete(input: OtaApplyInput | undefined): boolean {
  if (!input) return false;
  if (!isValidUpgradeImage(input.image)) return false;
  return input.rebootMode === "default" || input.rebootMode === "powercycle";
}
