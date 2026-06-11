// Inline form for the Q120 voluntary cluster resignation
// (`Tx::ClusterResignation`, kind 0x05). The resigning operator signs the
// native frame with the PQM-1-derived ML-DSA-65 consensus key; the runtime
// resolves the operator's cluster from on-chain membership, so the cluster
// id is display-only context and is NOT part of the signed payload. The
// only signed inputs are the operator-local resignation nonce and the
// foundation-expedite flag (the executor still enforces the authority).

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  deriveOperatorConsensusPubkeyHex,
  KEYCHAIN_ACCOUNTS,
  keychainGet,
  operatorPubkeyHash,
  useClusterResignations,
} from "../sdk";
import { useOps } from "./OpsContext";
import type { ClusterResignationInput } from "./types";

function pubkeyHexToOperatorIdHex(pubkeyHex: string): string {
  const clean = pubkeyHex.startsWith("0x") ? pubkeyHex.slice(2) : pubkeyHex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  let out = "0x";
  for (const b of operatorPubkeyHash(bytes)) out += b.toString(16).padStart(2, "0");
  return out;
}

const MAX_UINT64 = (1n << 64n) - 1n;

type LocalOperatorKeyState = {
  status: "checking" | "ready" | "missing" | "error";
  pubkeyHex: string;
  message: string;
};

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

function compactHex(value: string, head = 14, tail = 10): string {
  if (!value || value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function parseDecimal(value: string | undefined): bigint | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  return BigInt(value.trim());
}

/** Resignation nonce is a `u64` strictly greater than 0 — the runtime
 *  rejects any nonce that is not strictly greater than the operator's last
 *  accepted one, and the CLI defaults to 1. */
function isValidNonce(value: string | undefined): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed > 0n && parsed <= MAX_UINT64;
}

/** Cluster id is optional context. Empty is allowed; if present it must be a
 *  plain non-negative decimal so the preview reads cleanly. */
function isValidClusterContext(value: string | undefined): boolean {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return true;
  return /^\d+$/u.test(trimmed);
}

function useStoredOperatorPubkeyHex(): LocalOperatorKeyState {
  const [state, setState] = useState<LocalOperatorKeyState>({
    status: "checking",
    pubkeyHex: "",
    message: "Checking the stored operator mnemonic for a local consensus key.",
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
            pubkeyHex: "",
            message:
              "No stored operator mnemonic found. Store it under monarch-desktop/operator:mnemonic before signing the resignation.",
          });
          return;
        }
        const pubkeyHex = deriveOperatorConsensusPubkeyHex(mnemonic);
        setState({
          status: "ready",
          pubkeyHex,
          message: "Resignation will be signed by the stored operator consensus key.",
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          pubkeyHex: "",
          message: `Could not derive the local consensus pubkey: ${err instanceof Error ? err.message : String(err)}`,
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

export function ClusterResignationForm() {
  const { request, setClusterResignationInput } = useOps();
  const input = request?.clusterResignationInput;
  const localKey = useStoredOperatorPubkeyHex();
  const resignations = useClusterResignations(null, "all");

  // Nonce prefill: find this operator's highest accepted on-chain
  // resignation nonce and suggest last+1, so the operator never has to
  // reason about "strictly greater than the last accepted nonce".
  const lastAcceptedNonce = useMemo(() => {
    if (localKey.status !== "ready" || !localKey.pubkeyHex) return null;
    const rows = resignations.data?.rows ?? [];
    if (rows.length === 0) return resignations.data ? 0n : null;
    const selfId = pubkeyHexToOperatorIdHex(localKey.pubkeyHex).toLowerCase();
    let max = 0n;
    for (const row of rows) {
      const rowId = row.operator.toLowerCase().slice(0, 66); // leading 32 bytes of the member ref
      if (rowId === selfId && row.nonce > max) max = row.nonce;
    }
    return max;
  }, [localKey.pubkeyHex, localKey.status, resignations.data]);

  const isResign = request?.kind === "cluster-resign";
  const currentNonce = input?.nonce;
  useEffect(() => {
    if (!isResign || lastAcceptedNonce === null || lastAcceptedNonce === 0n) return;
    // Only auto-bump the untouched default; never overwrite an operator-typed value.
    if (currentNonce !== undefined && currentNonce !== "" && currentNonce !== "1") return;
    setClusterResignationInput({ nonce: (lastAcceptedNonce + 1n).toString() });
  }, [isResign, lastAcceptedNonce, currentNonce, setClusterResignationInput]);

  const validity = useMemo(
    () => ({
      nonce: isValidNonce(input?.nonce),
      cluster: isValidClusterContext(input?.clusterId),
    }),
    [input?.clusterId, input?.nonce],
  );

  if (!request || request.kind !== "cluster-resign") return null;

  const current: ClusterResignationInput = input ?? {
    clusterId: "",
    nonce: "1",
    expedite: false,
  };

  const keyTone =
    localKey.status === "ready"
      ? "halo halo--ok"
      : localKey.status === "error"
        ? "halo halo--err"
        : "halo halo--warn";

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>cluster resignation (Q120)</div>

      <div className={keyTone} style={{ alignSelf: "flex-start", marginBottom: 12 }}>
        <span className="dot" />{" "}
        {localKey.message}
        {localKey.status === "ready" && localKey.pubkeyHex
          ? ` (${compactHex(localKey.pubkeyHex)})`
          : ""}
      </div>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}
      >
        <span className="kv__k">Cluster id (context)</span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="optional"
          value={current.clusterId}
          onChange={(e) => setClusterResignationInput({ clusterId: e.target.value.trim() })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.cluster, true)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Display only — the chain resolves your cluster from on-chain membership; the cluster id is not part of the signed frame.
        </span>
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Resignation nonce</span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="1"
          value={current.nonce}
          onChange={(e) => setClusterResignationInput({ nonce: e.target.value.trim() })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.nonce, true)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          {lastAcceptedNonce !== null
            ? `Your last accepted on-chain resignation nonce is ${lastAcceptedNonce.toString()} — the next one must be greater (prefilled).`
            : validity.nonce
              ? "Operator-local u64; must be strictly greater than your last accepted resignation nonce."
              : "Enter a u64 greater than 0 (and greater than your last accepted resignation nonce)."}
        </span>
      </label>

      <label
        className="kv"
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginTop: 12,
        }}
      >
        <input
          type="checkbox"
          checked={current.expedite}
          onChange={(e) => setClusterResignationInput({ expedite: e.target.checked })}
        />
        <span className="kv__k" style={{ margin: 0 }}>
          Request foundation expedite
        </span>
      </label>
      <span style={{ fontSize: 10.5, color: "var(--fg-400)", display: "block", marginTop: 4 }}>
        Sets the EXPEDITE_REQUESTED flag (0x01). The executor only honours it when the tx is co-authorised by the foundation multi-sig; otherwise the standard delay applies.
      </span>

      <div className="halo halo--warn" style={{ alignSelf: "flex-start", marginTop: 12 }}>
        <span className="dot" /> Signs and submits Tx::ClusterResignation from the stored operator mnemonic. After the resignation delay your slot is freed and the bond-refund window opens.
      </div>
    </div>
  );
}

export function isClusterResignationInputComplete(
  input: ClusterResignationInput | undefined,
): boolean {
  return !!input && isValidNonce(input.nonce) && isValidClusterContext(input.clusterId);
}
