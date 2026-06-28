// Inline forms for the L6 open-seat marketplace ops (`seat-apply` /
// `seat-vote-admit`). They prepare and validate the applyForSeat / voteSeatAdmit
// inputs in the drawer, mirroring the CJ-1 cluster-join forms. Execution stays
// fail-closed in the OpsContext flow until the connected runtime accepts the
// signed seat transaction.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  deriveOperatorConsensusPubkeyHex,
  deriveSeatApplicationKeyHex,
  formatLythHex,
  KEYCHAIN_ACCOUNTS,
  keychainGet,
  NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  NODE_REGISTRY_MIN_SELF_BOND_LYTHOSHI,
  NODE_REGISTRY_SEAT_APPLICATION_ESCROW_LYTHOSHI,
} from "../sdk";
import { useOps } from "./OpsContext";
import type { ApplyForSeatInput, VoteSeatAdmitInput } from "./types";

const CONSENSUS_PUBKEY_HEX_CHARS = NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES * 2;
const APP_KEY_HEX_CHARS = 32 * 2;
const MAX_UINT32 = (1n << 32n) - 1n;
// 7-of-10 admission threshold for a full 10-operator cluster.
const CLUSTER_ADMISSION_THRESHOLD = 7;
const CLUSTER_SIZE = 10;
const SEAT_RUNTIME_NOTICE =
  "Submission is signed locally and broadcast to the connected node. A node that has not activated the open-seat primitive rejects the transaction before it is admitted.";
const SELF_BOND_LABEL = `${formatLythHex(`0x${NODE_REGISTRY_MIN_SELF_BOND_LYTHOSHI.toString(16)}`)} LYTH`;
const APPLICATION_ESCROW_LABEL = `${formatLythHex(`0x${NODE_REGISTRY_SEAT_APPLICATION_ESCROW_LYTHOSHI.toString(16)}`)} LYTH`;
const DEFAULT_ESCROW_LYTHOSHI = NODE_REGISTRY_SEAT_APPLICATION_ESCROW_LYTHOSHI.toString();

type LocalConsensusKeyState = {
  status: "checking" | "ready" | "missing" | "error";
  pubkeyHex: string;
  message: string;
};

function normalizeHex(value: string): string {
  const clean = value.trim().replace(/^0x/iu, "");
  return clean ? `0x${clean.toLowerCase()}` : "";
}

function isFixedHex(value: string | undefined, bytes: number): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return trimmed.length === bytes * 2 + 2 && /^0x[0-9a-fA-F]+$/u.test(trimmed);
}

function parseDecimal(value: string | undefined): bigint | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  return BigInt(value.trim());
}

function isUint32Decimal(value: string | undefined): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed >= 0n && parsed <= MAX_UINT32;
}

function isPositiveDecimal(value: string | undefined): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed > 0n;
}

function inputStyle(valid: boolean): CSSProperties {
  return {
    background: "rgba(0,0,0,0.3)",
    border: valid ? "1px solid rgba(255,255,255,0.1)" : "1px solid var(--err-500, #c53030)",
    color: "var(--fg-200)",
    padding: "6px 8px",
    fontSize: 12,
    borderRadius: 6,
    fontFamily: "var(--font-mono, monospace)",
  };
}

function compactHex(value: string, head = 14, tail = 10): string {
  if (!value || value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function useStoredOperatorConsensusPubkeyHex(): LocalConsensusKeyState {
  const [state, setState] = useState<LocalConsensusKeyState>({
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
              "No stored operator mnemonic found. Store it in Keys or paste the consensus pubkey manually.",
          });
          return;
        }
        const pubkeyHex = deriveOperatorConsensusPubkeyHex(mnemonic);
        setState({
          status: "ready",
          pubkeyHex,
          message: "Consensus pubkey prefilled from the stored operator mnemonic.",
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

function SeatDisclosure({ localKey }: { localKey: LocalConsensusKeyState }) {
  const keyTone =
    localKey.status === "ready"
      ? "halo halo--ok"
      : localKey.status === "error"
        ? "halo halo--err"
        : "halo halo--warn";
  const haloStyle: CSSProperties = {
    alignSelf: "flex-start",
    alignItems: "flex-start",
    lineHeight: 1.35,
    maxWidth: "100%",
    whiteSpace: "normal",
  };
  const dotStyle: CSSProperties = { flex: "0 0 auto", marginTop: 4 };
  const textStyle: CSSProperties = { minWidth: 0 };
  return (
    <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
      <div className="halo halo--warn" style={haloStyle}>
        <span className="dot" style={dotStyle} />
        <span style={textStyle}>{SEAT_RUNTIME_NOTICE}</span>
      </div>
      <div className={keyTone} style={haloStyle}>
        <span className="dot" style={dotStyle} />
        <span style={textStyle}>{localKey.message}</span>
      </div>
    </div>
  );
}

function SeatEconomicsPanel({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; value: string; tone?: "ok" | "warn" }[];
}) {
  return (
    <div
      style={{
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
        background: "rgba(255,255,255,0.025)",
        padding: 12,
        margin: "0 0 12px",
      }}
    >
      <div className="cap" style={{ marginBottom: 8 }}>{title}</div>
      <div style={{ display: "grid", gap: 7 }}>
        {rows.map((row) => (
          <div className="kv" key={row.label} style={{ gap: 12 }}>
            <span className="kv__k">{row.label}</span>
            <span
              className="mono"
              style={{
                color:
                  row.tone === "ok"
                    ? "var(--ok)"
                    : row.tone === "warn"
                      ? "var(--warn)"
                      : "var(--fg-300)",
                fontSize: 11,
                minWidth: 0,
                overflowWrap: "anywhere",
                textAlign: "right",
              }}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ApplyForSeatForm() {
  const { request, setSeatApplyInput } = useOps();
  const input = request?.seatApplyInput;
  const localKey = useStoredOperatorConsensusPubkeyHex();
  const current: ApplyForSeatInput =
    request?.kind === "seat-apply" && input
      ? input
      : { clusterId: "", seatId: "", operatorPubkeyHex: "", escrowLythoshi: DEFAULT_ESCROW_LYTHOSHI };

  const validity = useMemo(
    () => ({
      clusterOk: isUint32Decimal(input?.clusterId),
      seatOk: isUint32Decimal(input?.seatId),
      pubkeyOk: isFixedHex(input?.operatorPubkeyHex, NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES),
    }),
    [input?.clusterId, input?.seatId, input?.operatorPubkeyHex],
  );

  const appKeyHex =
    validity.pubkeyOk && current.operatorPubkeyHex
      ? deriveSeatApplicationKeyHex(current.operatorPubkeyHex)
      : "";

  // Prefill the consensus pubkey from the stored mnemonic, and seed the fixed
  // application escrow so the input is complete without manual entry.
  useEffect(() => {
    if (request?.kind !== "seat-apply") return;
    if (localKey.status === "ready" && localKey.pubkeyHex && !(input?.operatorPubkeyHex ?? "").trim()) {
      setSeatApplyInput({ operatorPubkeyHex: localKey.pubkeyHex });
    }
    if (!isPositiveDecimal(input?.escrowLythoshi)) {
      setSeatApplyInput({ escrowLythoshi: DEFAULT_ESCROW_LYTHOSHI });
    }
  }, [
    input?.operatorPubkeyHex,
    input?.escrowLythoshi,
    localKey.pubkeyHex,
    localKey.status,
    request?.kind,
    setSeatApplyInput,
  ]);

  if (!request || request.kind !== "seat-apply") return null;

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>Open-seat application inputs</div>
      <SeatDisclosure localKey={localKey} />
      <SeatEconomicsPanel
        title="What you commit"
        rows={[
          { label: "Application escrow (now)", value: `${APPLICATION_ESCROW_LABEL} · refundable`, tone: "ok" },
          { label: "Self-bond (on admission)", value: `${SELF_BOND_LABEL} · bound when admitted`, tone: "warn" },
          { label: "Admission threshold", value: `${CLUSTER_ADMISSION_THRESHOLD}-of-${CLUSTER_SIZE} cluster vote` },
          { label: "Application key", value: appKeyHex ? compactHex(appKeyHex) : "derives from your consensus pubkey" },
        ]}
      />

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Cluster id</span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="7"
          value={current.clusterId}
          onChange={(e) => setSeatApplyInput({ clusterId: e.target.value.trim() })}
          spellCheck={false}
          autoComplete="off"
          style={inputStyle(validity.clusterOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Decimal uint32 of the advertising cluster.
        </span>
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Seat id</span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="0"
          value={current.seatId}
          onChange={(e) => setSeatApplyInput({ seatId: e.target.value.trim() })}
          spellCheck={false}
          autoComplete="off"
          style={inputStyle(validity.seatOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          The advertised seat id within that cluster.
        </span>
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Operator consensus pubkey</span>
        <input
          type="text"
          inputMode="text"
          placeholder="0x..."
          value={current.operatorPubkeyHex}
          onChange={(e) => setSeatApplyInput({ operatorPubkeyHex: normalizeHex(e.target.value) })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.pubkeyOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Must be exactly {NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES} bytes ({CONSENSUS_PUBKEY_HEX_CHARS} hex chars).
        </span>
      </label>
    </div>
  );
}

export function VoteSeatAdmitForm() {
  const { request, setSeatVoteAdmitInput } = useOps();
  const input = request?.seatVoteAdmitInput;
  const localKey = useStoredOperatorConsensusPubkeyHex();
  const current: VoteSeatAdmitInput =
    request?.kind === "seat-vote-admit" && input
      ? input
      : { clusterId: "", appKeyHex: "", voterPubkeyHex: "" };

  const validity = useMemo(
    () => ({
      clusterOk: isUint32Decimal(input?.clusterId),
      appKeyOk: isFixedHex(input?.appKeyHex, 32),
      voterOk: isFixedHex(input?.voterPubkeyHex, NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES),
    }),
    [input?.clusterId, input?.appKeyHex, input?.voterPubkeyHex],
  );

  useEffect(() => {
    if (request?.kind !== "seat-vote-admit") return;
    if (localKey.status !== "ready" || !localKey.pubkeyHex) return;
    if ((input?.voterPubkeyHex ?? "").trim()) return;
    setSeatVoteAdmitInput({ voterPubkeyHex: localKey.pubkeyHex });
  }, [input?.voterPubkeyHex, localKey.pubkeyHex, localKey.status, request?.kind, setSeatVoteAdmitInput]);

  if (!request || request.kind !== "seat-vote-admit") return null;

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>Open-seat admit-vote inputs</div>
      <SeatDisclosure localKey={localKey} />
      <SeatEconomicsPanel
        title="Admission context"
        rows={[
          { label: "Admission threshold", value: `${CLUSTER_ADMISSION_THRESHOLD}-of-${CLUSTER_SIZE} cluster vote` },
          { label: "Candidate self-bond", value: `${SELF_BOND_LABEL} · bound on the admitting vote`, tone: "warn" },
          { label: "Application key", value: validity.appKeyOk ? compactHex(current.appKeyHex) : "enter the candidate's application key" },
        ]}
      />

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Cluster id</span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="7"
          value={current.clusterId}
          onChange={(e) => setSeatVoteAdmitInput({ clusterId: e.target.value.trim() })}
          spellCheck={false}
          autoComplete="off"
          style={inputStyle(validity.clusterOk)}
        />
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Candidate application key</span>
        <input
          type="text"
          inputMode="text"
          placeholder="0x..."
          value={current.appKeyHex}
          onChange={(e) => setSeatVoteAdmitInput({ appKeyHex: normalizeHex(e.target.value) })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.appKeyOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          The {APP_KEY_HEX_CHARS}-hex-char application key the applicant received (BLAKE3 of their consensus pubkey).
        </span>
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Voter consensus pubkey</span>
        <input
          type="text"
          inputMode="text"
          placeholder="0x..."
          value={current.voterPubkeyHex}
          onChange={(e) => setSeatVoteAdmitInput({ voterPubkeyHex: normalizeHex(e.target.value) })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.voterOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Must be exactly {NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES} bytes ({CONSENSUS_PUBKEY_HEX_CHARS} hex chars).
        </span>
      </label>
    </div>
  );
}

export function isApplyForSeatInputComplete(input: ApplyForSeatInput | undefined): boolean {
  return (
    !!input &&
    isUint32Decimal(input.clusterId) &&
    isUint32Decimal(input.seatId) &&
    isFixedHex(input.operatorPubkeyHex, NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES) &&
    isPositiveDecimal(input.escrowLythoshi)
  );
}

export function isVoteSeatAdmitInputComplete(input: VoteSeatAdmitInput | undefined): boolean {
  return (
    !!input &&
    isUint32Decimal(input.clusterId) &&
    isFixedHex(input.appKeyHex, 32) &&
    isFixedHex(input.voterPubkeyHex, NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES)
  );
}

export const SEAT_FORM_HEX_LENGTHS = {
  consensusPubkey: CONSENSUS_PUBKEY_HEX_CHARS + 2,
  applicationKey: APP_KEY_HEX_CHARS + 2,
} as const;
