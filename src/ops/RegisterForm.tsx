// Inline form rendered inside the Operations drawer when the active
// OpRequest.kind === "operator-register". Captures the inputs the
// chain's `register(...)` precompile call needs and writes them into
// `request.registerInput` via OpsContext.setRegisterInput. The Ops
// flow then reads that payload and posts the signed encrypted tx.
//
// Form discipline:
// - Endpoint: free text, validated as non-empty.
// - Capabilities: bitmask checkboxes mirroring NODE_REGISTRY_CAPABILITIES.
// - BLS pubkey: 48 raw bytes hex (96 hex chars, optional `0x` prefix).
// - BLS PoP: 96 raw bytes hex (192 hex chars, optional `0x` prefix).
// - Bond: LYTH (whole units) — translated to lythoshi via the SDK
//   `parseLythToLythoshi` helper (1 LYTH = 1e18 lythoshi) before sign.

import { useMemo } from "react";
import { parseLythToLythoshi } from "@monolythium/core-sdk";
import { useOps } from "./OpsContext";

const CAPABILITY_OPTIONS: ReadonlyArray<{ label: string; mask: number; hint: string }> = [
  { label: "RPC", mask: 0x0001, hint: "JSON-RPC for wallets + explorers" },
  { label: "Indexer", mask: 0x0002, hint: "Historical receipt + log index" },
  { label: "Broadcaster", mask: 0x0004, hint: "Encrypted-mempool ingress" },
  { label: "Archive", mask: 0x0008, hint: "Pruned state snapshots" },
  { label: "WebSocket", mask: 0x0010, hint: "Subscription stream" },
  { label: "Light client", mask: 0x0020, hint: "Receipt-proof serving" },
  { label: "Oracle writer", mask: 0x0040, hint: "Decentralized oracle write set" },
  { label: "Bridge relay", mask: 0x0080, hint: "Approved route relayer" },
  { label: "Public API", mask: 0x0100, hint: "Public-facing read API" },
];

function stripHexPrefix(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

function isValidHex(s: string, expectedBytes: number): boolean {
  const clean = stripHexPrefix(s.trim());
  if (clean.length !== expectedBytes * 2) return false;
  return /^[0-9a-fA-F]+$/.test(clean);
}

function parseBondLyth(value: string): bigint | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Delegate decimal LYTH → lythoshi conversion to the SDK helper, which
  // owns the canonical 18-decimal scale (1 LYTH = 1e18 lythoshi) and
  // rejects malformed / over-precise input. Surface invalid input as
  // `null` for inline validation rather than the SDK's thrown error.
  try {
    return parseLythToLythoshi(trimmed);
  } catch {
    return null;
  }
}

export function RegisterForm() {
  const { request, setRegisterInput } = useOps();
  const input = request?.registerInput;
  const validity = useMemo(() => {
    const endpointOk = !!input && input.endpoint.trim().length > 0;
    const capsOk = !!input && input.capabilities > 0;
    const pubkeyOk = !!input && isValidHex(input.blsPubkeyHex, 48);
    const popOk = !!input && isValidHex(input.blsPopHex, 96);
    const bondOk =
      !!input &&
      (() => {
        try {
          return BigInt(input.bondLythoshi) > 0n;
        } catch {
          return false;
        }
      })();
    return { endpointOk, capsOk, pubkeyOk, popOk, bondOk };
  }, [input]);

  if (!request || request.kind !== "operator-register") return null;

  const current = input ?? {
    endpoint: "",
    capabilities: 0,
    blsPubkeyHex: "",
    blsPopHex: "",
    bondLythoshi: "0",
  };

  const toggleCap = (mask: number) => {
    const next = (current.capabilities & mask) === mask
      ? current.capabilities & ~mask
      : current.capabilities | mask;
    setRegisterInput({ capabilities: next });
  };

  const onBondChange = (value: string) => {
    const parsed = parseBondLyth(value);
    setRegisterInput({ bondLythoshi: parsed !== null ? parsed.toString() : "0" });
  };

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>register inputs</div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Endpoint</span>
        <input
          type="url"
          placeholder="https://node.example"
          value={current.endpoint}
          onChange={(e) => setRegisterInput({ endpoint: e.target.value })}
          style={{
            background: "rgba(0,0,0,0.3)",
            border: validity.endpointOk
              ? "1px solid rgba(255,255,255,0.1)"
              : "1px solid var(--err-500, #c53030)",
            color: "var(--fg-200)",
            padding: "6px 8px",
            fontSize: 12,
            borderRadius: 6,
            fontFamily: "inherit",
          }}
        />
      </label>

      <div style={{ marginTop: 12 }}>
        <div className="kv__k" style={{ marginBottom: 6 }}>Capabilities</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {CAPABILITY_OPTIONS.map((cap) => {
            const on = (current.capabilities & cap.mask) === cap.mask;
            return (
              <button
                key={cap.mask}
                type="button"
                onClick={() => toggleCap(cap.mask)}
                title={cap.hint}
                style={{
                  fontSize: 11,
                  padding: "4px 8px",
                  borderRadius: 999,
                  border: on ? "1px solid var(--gold-500, #F2B441)" : "1px solid rgba(255,255,255,0.1)",
                  background: on ? "rgba(242,180,65,0.12)" : "rgba(255,255,255,0.02)",
                  color: on ? "var(--gold-300, #F2B441)" : "var(--fg-300)",
                  cursor: "pointer",
                }}
              >
                {cap.label}
              </button>
            );
          })}
        </div>
        {!validity.capsOk ? (
          <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--err-300, #fc8181)" }}>
            Select at least one capability.
          </p>
        ) : null}
      </div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}>
        <span className="kv__k">BLS pubkey (96 hex chars = 48 bytes)</span>
        <input
          type="text"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="0x... (96 hex)"
          value={current.blsPubkeyHex}
          onChange={(e) => setRegisterInput({ blsPubkeyHex: e.target.value })}
          style={{
            background: "rgba(0,0,0,0.3)",
            border: validity.pubkeyOk
              ? "1px solid rgba(255,255,255,0.1)"
              : "1px solid var(--err-500, #c53030)",
            color: "var(--fg-200)",
            padding: "6px 8px",
            fontSize: 11,
            borderRadius: 6,
            fontFamily: "var(--font-mono, monospace)",
          }}
        />
      </label>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}>
        <span className="kv__k">BLS proof-of-possession (192 hex chars = 96 bytes)</span>
        <input
          type="text"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="0x... (192 hex)"
          value={current.blsPopHex}
          onChange={(e) => setRegisterInput({ blsPopHex: e.target.value })}
          style={{
            background: "rgba(0,0,0,0.3)",
            border: validity.popOk
              ? "1px solid rgba(255,255,255,0.1)"
              : "1px solid var(--err-500, #c53030)",
            color: "var(--fg-200)",
            padding: "6px 8px",
            fontSize: 11,
            borderRadius: 6,
            fontFamily: "var(--font-mono, monospace)",
          }}
        />
      </label>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}>
        <span className="kv__k">Bond (LYTH whole units, ≥ 5,000 on testnet)</span>
        <input
          type="text"
          inputMode="decimal"
          placeholder="5000"
          onChange={(e) => onBondChange(e.target.value)}
          style={{
            background: "rgba(0,0,0,0.3)",
            border: validity.bondOk
              ? "1px solid rgba(255,255,255,0.1)"
              : "1px solid var(--err-500, #c53030)",
            color: "var(--fg-200)",
            padding: "6px 8px",
            fontSize: 12,
            borderRadius: 6,
            fontFamily: "inherit",
          }}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          {validity.bondOk
            ? `→ ${current.bondLythoshi} lythoshi`
            : "Enter a positive LYTH amount."}
        </span>
      </label>
    </div>
  );
}

/** Whether all register inputs are non-empty + well-shaped. Used by
 *  the drawer footer to gate the "Authorize & run" button. */
export function isRegisterInputComplete(
  input: import("./types").RegisterInput | undefined,
): boolean {
  if (!input) return false;
  if (input.endpoint.trim().length === 0) return false;
  if (input.capabilities <= 0) return false;
  if (!isValidHex(input.blsPubkeyHex, 48)) return false;
  if (!isValidHex(input.blsPopHex, 96)) return false;
  try {
    if (BigInt(input.bondLythoshi) <= 0n) return false;
  } catch {
    return false;
  }
  return true;
}
