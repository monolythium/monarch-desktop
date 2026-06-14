// Inline form rendered inside the Operations drawer when the active
// OpRequest.kind === "operator-register". Captures the inputs the
// chain's `register(...)` precompile call needs and writes them into
// `request.registerInput` via OpsContext.setRegisterInput. The Ops
// flow then reads that payload and posts the signed encrypted tx.
//
// Form discipline:
// - Endpoint: free text, validated as non-empty.
// - Capabilities: bitmask checkboxes mirroring NODE_REGISTRY_CAPABILITIES.
// - Consensus pubkey + possession proof: derived from the PQM-1 mnemonic
//   at authorization time.
// - Bond: LYTH (whole units) — translated to lythoshi via the SDK
//   `parseLythToLythoshi` helper (1 LYTH = 1e18 lythoshi) before sign.
//   HARD-validated against the 5,000 LYTH testnet minimum.
// - Dummy-proofing: derives the funding address from the stored key,
//   reads the live balance, and checks for an existing registration so
//   the operator sees problems before signing, not after.

import { useEffect, useMemo, useState } from "react";
import { formatLyth, parseLythToLythoshi } from "@monolythium/core-sdk";
import { pqm1MnemonicToAddress } from "@monolythium/core-sdk/crypto";
import {
  KEYCHAIN_ACCOUNTS,
  deriveOperatorConsensusPubkeyHex,
  inTauri,
  keychainGet,
  normalizeNodeEndpoint,
  operatorPubkeyHash,
  probeNodeEndpoint,
  type NodeProbeResult,
} from "../sdk";
import { rpc } from "../sdk/client";
import { MIN_REGISTER_BOND_LYTH, MIN_REGISTER_BOND_LYTHOSHI } from "../sdk/onboarding";
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

type WalletProbe = {
  status: "checking" | "ready" | "no-key" | "unavailable";
  address: string | null;
  balanceLythoshi: bigint | null;
  alreadyRegistered: boolean | null;
};

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | null;
  const msg = (e?.message ?? "").toLowerCase();
  return e?.code === -32090 || msg.includes("not found") || msg.includes("unknown operator");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Live wallet context for the register flow: derived funding address,
 *  native balance, and an existing-registration check. */
function useRegisterWalletProbe(): WalletProbe {
  const [probe, setProbe] = useState<WalletProbe>({
    status: "checking",
    address: null,
    balanceLythoshi: null,
    alreadyRegistered: null,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!inTauri()) {
        if (!cancelled) {
          setProbe({ status: "unavailable", address: null, balanceLythoshi: null, alreadyRegistered: null });
        }
        return;
      }
      let address: string | null = null;
      let operatorIdHex: string | null = null;
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (cancelled) return;
        if (!mnemonic) {
          setProbe({ status: "no-key", address: null, balanceLythoshi: null, alreadyRegistered: null });
          return;
        }
        // Derive in this scope only — the cleartext is dropped right after.
        address = pqm1MnemonicToAddress(mnemonic);
        operatorIdHex = bytesToHex(operatorPubkeyHash(hexToBytes(deriveOperatorConsensusPubkeyHex(mnemonic))));
      } catch {
        if (!cancelled) {
          setProbe({ status: "unavailable", address: null, balanceLythoshi: null, alreadyRegistered: null });
        }
        return;
      }

      let balanceLythoshi: bigint | null = null;
      let alreadyRegistered: boolean | null = null;
      await Promise.all([
        rpc
          .ethGetBalance(address)
          .then((result) => {
            balanceLythoshi = BigInt(result.value);
          })
          .catch(() => undefined),
        rpc
          .lythOperatorInfo(operatorIdHex)
          .then(() => {
            alreadyRegistered = true;
          })
          .catch((err: unknown) => {
            alreadyRegistered = isNotFound(err) ? false : null;
          }),
      ]);
      if (cancelled) return;
      setProbe({ status: "ready", address, balanceLythoshi, alreadyRegistered });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return probe;
}

export function RegisterForm() {
  const { request, setRegisterInput } = useOps();
  const input = request?.registerInput;
  const [bondLyth, setBondLyth] = useState("");
  const [endpointProbe, setEndpointProbe] = useState<{
    status: "idle" | "testing" | "ok" | "err";
    message: string;
    result: NodeProbeResult | null;
  }>({ status: "idle", message: "", result: null });
  const wallet = useRegisterWalletProbe();
  const validity = useMemo(() => {
    const endpointOk = !!input && input.endpoint.trim().length > 0;
    const capsOk = !!input && input.capabilities > 0;
    const bondOk =
      !!input &&
      (() => {
        try {
          return BigInt(input.bondLythoshi) >= MIN_REGISTER_BOND_LYTHOSHI;
        } catch {
          return false;
        }
      })();
    return { endpointOk, capsOk, bondOk };
  }, [input]);

  if (!request || request.kind !== "operator-register") return null;

  const current = input ?? {
    endpoint: "",
    capabilities: 0,
    bondLythoshi: "0",
  };

  const testEndpoint = async () => {
    setEndpointProbe({ status: "testing", message: "Testing endpoint…", result: null });
    let normalized: string;
    try {
      normalized = normalizeNodeEndpoint(current.endpoint);
      setRegisterInput({ endpoint: normalized });
    } catch (err) {
      setEndpointProbe({
        status: "err",
        message: (err as Error)?.message ?? String(err),
        result: null,
      });
      return;
    }
    const probe = await probeNodeEndpoint(normalized);
    if (probe.outcome === "ok") {
      setEndpointProbe({
        status: "ok",
        message: `Endpoint reachable${probe.chainId ? ` · chain ${probe.chainId}` : ""}`,
        result: probe,
      });
      return;
    }
    setEndpointProbe({
      status: "err",
      message:
        probe.outcome === "wrong-chain"
          ? `Endpoint responds, but on the wrong chain${probe.chainId ? ` (${probe.chainId})` : ""}.`
          : probe.error ?? "Endpoint did not respond to the live probe.",
      result: probe,
    });
  };

  const toggleCap = (mask: number) => {
    const next = (current.capabilities & mask) === mask
      ? current.capabilities & ~mask
      : current.capabilities | mask;
    setRegisterInput({ capabilities: next });
  };

  const onBondChange = (value: string) => {
    setBondLyth(value);
    const parsed = parseBondLyth(value);
    setRegisterInput({ bondLythoshi: parsed !== null ? parsed.toString() : "0" });
  };

  let bondLythoshi = 0n;
  try {
    bondLythoshi = BigInt(current.bondLythoshi);
  } catch {
    bondLythoshi = 0n;
  }
  const balanceCovers =
    wallet.balanceLythoshi !== null && validity.bondOk
      ? wallet.balanceLythoshi >= bondLythoshi
      : null;

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>register inputs</div>

      {wallet.status === "no-key" ? (
        <div className="halo halo--err" style={{ alignSelf: "flex-start", marginBottom: 10, whiteSpace: "normal" }}>
          <span className="dot" /> No operator key stored — save or generate your 24-word operator
          mnemonic on the Keys page before registering.
        </div>
      ) : null}
      {wallet.alreadyRegistered === true ? (
        <div className="halo halo--err" style={{ alignSelf: "flex-start", marginBottom: 10, whiteSpace: "normal" }}>
          <span className="dot" /> This operator key is already registered on-chain — a second
          register would be rejected. Use Set operator name or Publish seal key to update metadata.
        </div>
      ) : null}
      {wallet.address ? (
        <div
          style={{
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            background: "rgba(255,255,255,0.025)",
            padding: 12,
            marginBottom: 12,
            display: "grid",
            gap: 7,
          }}
        >
          <div className="kv" style={{ gap: 12 }}>
            <span className="kv__k">Funding address (yours)</span>
            <span
              className="mono"
              style={{ fontSize: 11, overflowWrap: "anywhere", textAlign: "right", minWidth: 0 }}
            >
              {wallet.address}
              <button
                type="button"
                className="copy-btn"
                style={{ marginLeft: 8 }}
                onClick={() => void navigator.clipboard?.writeText(wallet.address ?? "")}
                aria-label="Copy funding address"
              >
                CP
              </button>
            </span>
          </div>
          <div className="kv" style={{ gap: 12 }}>
            <span className="kv__k">Live balance</span>
            <span
              className="mono"
              style={{
                fontSize: 11,
                textAlign: "right",
                color:
                  balanceCovers === false
                    ? "var(--err-300, #fc8181)"
                    : balanceCovers === true
                      ? "var(--ok)"
                      : "var(--fg-300)",
              }}
            >
              {wallet.balanceLythoshi !== null
                ? `${formatLyth(wallet.balanceLythoshi)}${balanceCovers === false ? " — does not cover the bond" : ""}`
                : "not readable on this endpoint"}
            </span>
          </div>
          <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
            The bond is paid from this address. Send LYTH here if the balance does not cover the
            bond plus fees.
          </span>
        </div>
      ) : null}

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Endpoint</span>
        <div className="register-endpoint-row">
          <input
            type="url"
            placeholder="https://node.example"
            value={current.endpoint}
            onChange={(e) => {
              setRegisterInput({ endpoint: e.target.value });
              setEndpointProbe({ status: "idle", message: "", result: null });
            }}
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
              minWidth: 0,
              flex: 1,
            }}
          />
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void testEndpoint()}
            disabled={endpointProbe.status === "testing" || current.endpoint.trim().length === 0}
          >
            {endpointProbe.status === "testing" ? "Testing…" : "Test endpoint"}
          </button>
        </div>
        {endpointProbe.status !== "idle" ? (
          <span
            className={`halo halo--${
              endpointProbe.status === "ok"
                ? "ok"
                : endpointProbe.status === "testing"
                  ? "info"
                  : "err"
            }`}
            style={{ alignSelf: "flex-start", whiteSpace: "normal" }}
          >
            <span className={endpointProbe.status === "testing" ? "dot dot--pulse" : "dot"} />
            {endpointProbe.message}
          </span>
        ) : null}
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

      <div className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}>
        <span className="kv__k">Consensus key</span>
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Derived from the operator PQM-1 mnemonic; Desktop signs the possession proof during authorization.
        </span>
      </div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}>
        <span className="kv__k">Bond (LYTH whole units, ≥ {MIN_REGISTER_BOND_LYTH.toLocaleString()} on testnet)</span>
        <input
          type="text"
          inputMode="decimal"
          placeholder="5000"
          value={bondLyth}
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
            : `Enter at least ${MIN_REGISTER_BOND_LYTH.toLocaleString()} LYTH — the chain rejects anything below the minimum bond.`}
        </span>
      </label>
    </div>
  );
}

/** Whether all register inputs are non-empty + well-shaped (bond hard-
 *  validated against the 5,000 LYTH testnet minimum). Used by the
 *  drawer footer to gate the "Authorize & run" button. */
export function isRegisterInputComplete(
  input: import("./types").RegisterInput | undefined,
): boolean {
  if (!input) return false;
  if (input.endpoint.trim().length === 0) return false;
  if (input.capabilities <= 0) return false;
  try {
    if (BigInt(input.bondLythoshi) < MIN_REGISTER_BOND_LYTHOSHI) return false;
  } catch {
    return false;
  }
  return true;
}
