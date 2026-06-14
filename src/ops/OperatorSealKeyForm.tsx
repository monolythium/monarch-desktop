import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  deriveOperatorConsensusPubkeyHex,
  KEYCHAIN_ACCOUNTS,
  keychainGet,
  operatorPubkeyHash,
  operatorSealEkHexToBytes,
  talosOperatorSealEk,
} from "../sdk";
import { useOps } from "./OpsContext";
import type { OperatorSealKeyInput } from "./types";

type LocalPeerIdState = {
  status: "checking" | "ready" | "missing" | "error";
  peerIdHex: string;
  message: string;
};

function normalizeHex(value: string): string {
  const clean = value.trim().replace(/^0x/iu, "");
  return clean ? `0x${clean.toLowerCase()}` : "";
}

function hexToBytes(value: string, expectedLen: number, label: string): Uint8Array {
  const clean = value.trim().replace(/^0x/iu, "");
  if (clean.length !== expectedLen * 2) {
    throw new Error(`${label}: expected ${expectedLen} bytes`);
  }
  if (!/^[0-9a-fA-F]+$/u.test(clean)) {
    throw new Error(`${label}: invalid hex`);
  }
  const out = new Uint8Array(expectedLen);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function isPeerIdHex(value: string | undefined): boolean {
  if (!value) return false;
  return /^0x[0-9a-fA-F]{64}$/u.test(value.trim());
}

function sealEkStatus(value: string | undefined): { ok: boolean; message: string } {
  try {
    operatorSealEkHexToBytes(value ?? "");
    return { ok: true, message: "Public seal key loaded." };
  } catch (err) {
    void err;
    return { ok: false, message: "Load the public seal key from Monarch OS, or paste it here." };
  }
}

function inputStyle(valid: boolean, mono = true): CSSProperties {
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

function useStoredOperatorPeerIdHex(): LocalPeerIdState {
  const [state, setState] = useState<LocalPeerIdState>({
    status: "checking",
    peerIdHex: "",
    message: "Checking your stored operator key.",
  });

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (cancelled) return;
        if (!mnemonic) {
          setState({
            status: "missing",
            peerIdHex: "",
            message: "No operator key is stored yet.",
          });
          return;
        }
        const pubkeyHex = deriveOperatorConsensusPubkeyHex(mnemonic);
        const pubkey = hexToBytes(pubkeyHex, 1_952, "consensusPubkey");
        const peerIdHex = bytesToHex(operatorPubkeyHash(pubkey));
        setState({
          status: "ready",
          peerIdHex,
          message: "Filled from your stored operator key.",
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          peerIdHex: "",
          message: `Could not read your operator ID: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export function OperatorSealKeyForm() {
  const { request, setOperatorSealKeyInput } = useOps();
  const input = request?.operatorSealKeyInput;
  const localPeerId = useStoredOperatorPeerIdHex();
  const [loadState, setLoadState] = useState<{
    status: "idle" | "loading" | "ready" | "error";
    message: string;
  }>({ status: "idle", message: "" });

  const current: OperatorSealKeyInput = request?.kind === "operator-seal-key" && input
    ? input
    : {
        peerIdHex: "",
        sealEkHex: "",
      };

  const validity = useMemo(() => {
    return {
      peerIdOk: isPeerIdHex(input?.peerIdHex),
      sealEk: sealEkStatus(input?.sealEkHex),
    };
  }, [input?.peerIdHex, input?.sealEkHex]);

  useEffect(() => {
    if (request?.kind !== "operator-seal-key") return;
    if (localPeerId.status !== "ready" || !localPeerId.peerIdHex) return;
    if ((input?.peerIdHex ?? "").trim()) return;
    setOperatorSealKeyInput({ peerIdHex: localPeerId.peerIdHex });
  }, [
    input?.peerIdHex,
    localPeerId.peerIdHex,
    localPeerId.status,
    request?.kind,
    setOperatorSealKeyInput,
  ]);

  if (!request || request.kind !== "operator-seal-key") return null;

  const loadFromTalos = async () => {
    setLoadState({ status: "loading", message: "Reading Monarch OS seal key." });
    try {
      const result = await talosOperatorSealEk();
      setOperatorSealKeyInput({ sealEkHex: result.sealEkHex });
      setLoadState({
        status: "ready",
        message: `Loaded ${result.path} (${result.sha256.slice(0, 12)}...).`,
      });
    } catch (err) {
      setLoadState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>operator seal key</div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Operator ID</span>
        <input
          type="text"
          inputMode="text"
          placeholder={`0x${"00".repeat(32)}`}
          value={current.peerIdHex}
          onChange={(e) => setOperatorSealKeyInput({ peerIdHex: normalizeHex(e.target.value) })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.peerIdOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          {localPeerId.message}
        </span>
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Seal key</span>
        <textarea
          placeholder={`0x${"00".repeat(16)}...`}
          value={current.sealEkHex}
          onChange={(e) => setOperatorSealKeyInput({ sealEkHex: normalizeHex(e.target.value) })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          rows={5}
          style={{ ...inputStyle(validity.sealEk.ok), resize: "vertical" }}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          {validity.sealEk.message}
        </span>
      </label>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void loadFromTalos()}
          disabled={loadState.status === "loading"}
        >
          {loadState.status === "loading" ? "Loading..." : "Load from Monarch OS"}
        </button>
        <span style={{ fontSize: 10.5, color: loadState.status === "error" ? "var(--err-400)" : "var(--fg-400)" }}>
          {loadState.message}
        </span>
      </div>
    </div>
  );
}

export function isOperatorSealKeyInputComplete(
  input: OperatorSealKeyInput | undefined,
): boolean {
  if (!input || !isPeerIdHex(input.peerIdHex)) return false;
  try {
    operatorSealEkHexToBytes(input.sealEkHex);
    return true;
  } catch {
    return false;
  }
}
