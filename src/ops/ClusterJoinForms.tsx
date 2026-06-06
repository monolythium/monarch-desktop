// Inline forms for CJ-1 self-service cluster admission. These prepare
// request/vote inputs in Desktop now, while execution stays fail-closed
// until the chain runtime exposes the CJ-1 methods on node-registry.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { parseLythToLythoshi } from "@monolythium/core-sdk";
import {
  CLUSTER_JOIN_REQUEST_TTL_EPOCHS,
  deriveOperatorConsensusPubkeyHex,
  deriveClusterJoinOperatorIdHex,
  encodeGetClusterJoinRequestCalldata,
  KEYCHAIN_ACCOUNTS,
  keychainGet,
  NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  useClusterJoinRequestView,
  useClusterStatus,
} from "../sdk";
import type { ClusterJoinRequestView, RpcSlice } from "../sdk";
import { useOps } from "./OpsContext";
import type { ClusterJoinRequestInput, ClusterVoteAdmitInput } from "./types";

const CONSENSUS_PUBKEY_HEX_CHARS = NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES * 2;
const OPERATOR_ID_HEX_CHARS = 32 * 2;
const MAX_UINT32 = (1n << 32n) - 1n;
const CLUSTER_JOIN_RUNTIME_NOTICE =
  "Submission is guarded by a live CJ-1 view preflight. Current chains that do not expose the request and vote methods fail before signing or broadcast.";

export const CLUSTER_JOIN_SEAL_KEY_REQUIREMENT =
  "Publish the operator LythiumSeal EK before submitting requestClusterJoin; the runtime reads published EKs into live seal rosters after admission.";

type LocalConsensusKeyState = {
  status: "checking" | "ready" | "missing" | "error";
  pubkeyHex: string;
  message: string;
};

export type ClusterJoinStatusPreview = {
  status: "ready" | "incomplete";
  operatorIdHex: string;
  getRequestCalldata: string;
  statusLabel: string;
  voteProgressLabel: string;
  ttlLabel: string;
  bondLabel?: string;
};

function normalizeHex(value: string): string {
  const clean = value.trim().replace(/^0x/iu, "");
  return clean ? `0x${clean.toLowerCase()}` : "";
}

function isFixedHex(value: string | undefined, bytes: number): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return (
    trimmed.length === bytes * 2 + 2 &&
    /^0x[0-9a-fA-F]+$/u.test(trimmed)
  );
}

function parseDecimal(value: string | undefined): bigint | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  return BigInt(value.trim());
}

function isUint32Decimal(value: string | undefined): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed >= 0n && parsed <= MAX_UINT32;
}

function parseUint32Number(value: string | undefined): number | null {
  const parsed = parseDecimal(value);
  if (parsed === null || parsed < 0n || parsed > MAX_UINT32) return null;
  return Number(parsed);
}

function isPositiveDecimal(value: string | undefined): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed > 0n;
}

function parseBondLyth(value: string): bigint | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return parseLythToLythoshi(trimmed);
  } catch {
    return null;
  }
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

function compactHex(value: string, head = 14, tail = 10): string {
  if (!value || value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function clusterJoinTtlLabel(
  request: ClusterJoinRequestView,
  currentEpoch: number | null,
): string {
  if (request.status !== "open") {
    return `request is ${request.status}`;
  }
  const requestEpoch = parseDecimal(request.requestEpoch);
  if (requestEpoch === null) {
    return `opened epoch ${request.requestEpoch}; expires after ${CLUSTER_JOIN_REQUEST_TTL_EPOCHS} epochs`;
  }
  const expiresEpoch = requestEpoch + BigInt(CLUSTER_JOIN_REQUEST_TTL_EPOCHS);
  if (currentEpoch === null) {
    return `opened epoch ${requestEpoch.toString()} · expires epoch ${expiresEpoch.toString()}`;
  }
  const current = BigInt(currentEpoch);
  if (current < requestEpoch) {
    return `opens epoch ${requestEpoch.toString()} · current epoch ${current.toString()} · expires epoch ${expiresEpoch.toString()}`;
  }
  if (current >= expiresEpoch) {
    return `TTL window elapsed at epoch ${expiresEpoch.toString()} · current epoch ${current.toString()}`;
  }
  const remaining = expiresEpoch - current;
  return `opened epoch ${requestEpoch.toString()} · current epoch ${current.toString()} · expires epoch ${expiresEpoch.toString()} · ${remaining.toString()} epoch${remaining === 1n ? "" : "s"} remaining`;
}

export function clusterJoinRequestStatusPreview(
  input: ClusterJoinRequestInput | undefined,
): ClusterJoinStatusPreview {
  const clusterOk = isUint32Decimal(input?.clusterId);
  const pubkeyOk = isFixedHex(input?.operatorPubkeyHex, NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES);
  const operatorIdHex = pubkeyOk && input
    ? deriveClusterJoinOperatorIdHex(input.operatorPubkeyHex)
    : "";
  const getRequestCalldata = clusterOk && input && operatorIdHex
    ? encodeGetClusterJoinRequestCalldata({
        clusterId: input.clusterId,
        operatorIdHex,
      })
    : "";
  const ready = clusterOk && !!operatorIdHex;

  return {
    status: ready ? "ready" : "incomplete",
    operatorIdHex,
    getRequestCalldata,
    statusLabel: ready
      ? "Ready to query getClusterJoinRequest once CJ-1 view calls are live."
      : "Needs a valid cluster id and operator consensus pubkey before request status can be addressed.",
    voteProgressLabel: "Waiting for live getClusterJoinRequest vote_count / snapshot_threshold.",
    ttlLabel: "Waiting for live request epoch + TTL data.",
    bondLabel: isPositiveDecimal(input?.bondLythoshi)
      ? `${input?.bondLythoshi} lythoshi`
      : "Enter a positive bond before signing.",
  };
}

export function clusterVoteAdmitStatusPreview(
  input: ClusterVoteAdmitInput | undefined,
): ClusterJoinStatusPreview {
  const clusterOk = isUint32Decimal(input?.clusterId);
  const operatorOk = isFixedHex(input?.operatorIdHex, 32);
  const getRequestCalldata = clusterOk && operatorOk && input
    ? encodeGetClusterJoinRequestCalldata({
        clusterId: input.clusterId,
        operatorIdHex: input.operatorIdHex,
      })
    : "";
  const ready = clusterOk && operatorOk && isFixedHex(
    input?.voterPubkeyHex,
    NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  );

  return {
    status: ready ? "ready" : "incomplete",
    operatorIdHex: operatorOk && input ? normalizeHex(input.operatorIdHex) : "",
    getRequestCalldata,
    statusLabel: ready
      ? "Ready to query the candidate request before signing once CJ-1 view calls are live."
      : "Needs a valid cluster id, candidate operator id, and voter consensus pubkey.",
    voteProgressLabel: "Waiting for live getClusterJoinRequest vote_count / snapshot_threshold.",
    ttlLabel: "Waiting for live request epoch + TTL data.",
  };
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
            message: "No stored operator mnemonic found. Store it in Keys or paste the consensus pubkey manually.",
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

function ClusterAdmissionDisclosure({ localKey }: { localKey: LocalConsensusKeyState }) {
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
        <span style={textStyle}>
          {CLUSTER_JOIN_SEAL_KEY_REQUIREMENT} {CLUSTER_JOIN_RUNTIME_NOTICE}
        </span>
      </div>
      <div className={keyTone} style={haloStyle}>
        <span className="dot" style={dotStyle} />
        <span style={textStyle}>{localKey.message}</span>
      </div>
    </div>
  );
}

function ClusterJoinStatusPanel({
  title,
  preview,
  live,
  currentEpoch,
}: {
  title: string;
  preview: ClusterJoinStatusPreview;
  live: RpcSlice<ClusterJoinRequestView>;
  currentEpoch: number | null;
}) {
  const liveData = preview.status === "ready" ? live.data : null;
  const liveStatusValue =
    preview.status !== "ready"
      ? preview.statusLabel
      : live.loading
        ? "Reading getClusterJoinRequest..."
        : live.notExposed
          ? "CJ-1 view call is not exposed on the connected chain."
          : live.error
            ? `Read failed: ${live.error}`
            : liveData
              ? liveData.exists
                ? `${liveData.status} · owner ${liveData.owner ? compactHex(liveData.owner, 12, 8) : "unknown"}`
                : "No request found for this cluster/operator pair."
              : preview.statusLabel;
  const liveVoteProgress =
    liveData?.exists
      ? `${liveData.voteCount}/${liveData.snapshotThreshold} votes · ${liveData.snapshotN} snapshot operators`
      : preview.voteProgressLabel;
  const liveTtl =
    liveData?.exists
      ? clusterJoinTtlLabel(liveData, currentEpoch)
      : preview.ttlLabel;
  const liveBond =
    liveData?.exists
      ? `${liveData.bondLythoshi} lythoshi${liveData.sealRosterPending ? " · seal roster pending" : ""}`
      : preview.bondLabel;
  const rows = [
    { label: "Candidate operator id", value: preview.operatorIdHex ? compactHex(preview.operatorIdHex) : "not derived" },
    { label: "Request view calldata", value: preview.getRequestCalldata ? compactHex(preview.getRequestCalldata) : "not addressable yet" },
    { label: "Vote progress", value: liveVoteProgress },
    { label: "TTL", value: liveTtl },
    ...(liveBond ? [{ label: "Bond", value: liveBond }] : []),
    { label: "Status", value: liveStatusValue },
  ];

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
                color: row.label === "Status"
                  ? preview.status === "ready" ? "var(--ok)" : "var(--warn)"
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

export function ClusterJoinRequestForm() {
  const { request, setClusterJoinRequestInput } = useOps();
  const input = request?.clusterJoinRequestInput;
  const localKey = useStoredOperatorConsensusPubkeyHex();
  const current: ClusterJoinRequestInput = request?.kind === "cluster-request-join" && input
    ? input
    : {
        clusterId: "",
        operatorPubkeyHex: "",
        bondLythoshi: "0",
      };
  const preview = clusterJoinRequestStatusPreview(
    request?.kind === "cluster-request-join" ? current : undefined,
  );
  const live = useClusterJoinRequestView(
    preview.status === "ready" ? current.clusterId : null,
    preview.operatorIdHex || null,
  );
  const selectedClusterId = parseUint32Number(current.clusterId);
  const cluster = useClusterStatus(preview.status === "ready" ? selectedClusterId : null);
  const currentEpoch = cluster.data?.epoch ?? null;
  const validity = useMemo(() => {
    const clusterOk = isUint32Decimal(input?.clusterId);
    const pubkeyOk = isFixedHex(input?.operatorPubkeyHex, NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES);
    const bondOk = isPositiveDecimal(input?.bondLythoshi);
    return { clusterOk, pubkeyOk, bondOk };
  }, [input?.bondLythoshi, input?.clusterId, input?.operatorPubkeyHex]);

  useEffect(() => {
    if (request?.kind !== "cluster-request-join") return;
    if (localKey.status !== "ready" || !localKey.pubkeyHex) return;
    if ((input?.operatorPubkeyHex ?? "").trim()) return;
    setClusterJoinRequestInput({ operatorPubkeyHex: localKey.pubkeyHex });
  }, [
    input?.operatorPubkeyHex,
    localKey.pubkeyHex,
    localKey.status,
    request?.kind,
    setClusterJoinRequestInput,
  ]);

  if (!request || request.kind !== "cluster-request-join") return null;

  const onBondChange = (value: string) => {
    const parsed = parseBondLyth(value);
    setClusterJoinRequestInput({ bondLythoshi: parsed !== null ? parsed.toString() : "0" });
  };

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>CJ-1 join request inputs</div>
      <ClusterAdmissionDisclosure localKey={localKey} />
      <ClusterJoinStatusPanel
        title="Request status preview"
        preview={preview}
        live={live}
        currentEpoch={currentEpoch}
      />

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Cluster id</span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="7"
          value={current.clusterId}
          onChange={(e) => setClusterJoinRequestInput({ clusterId: e.target.value.trim() })}
          spellCheck={false}
          autoComplete="off"
          style={inputStyle(validity.clusterOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Decimal uint32 used as requestClusterJoin(clusterId, operatorPubkey).
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
          onChange={(e) => setClusterJoinRequestInput({ operatorPubkeyHex: normalizeHex(e.target.value) })}
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

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Bond (LYTH)</span>
        <input
          type="text"
          inputMode="decimal"
          placeholder="5000"
          onChange={(e) => onBondChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          style={inputStyle(validity.bondOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          {validity.bondOk
            ? `Native value: ${current.bondLythoshi} lythoshi.`
            : "Enter a positive LYTH amount; the chain enforces the minimum."}
        </span>
      </label>
    </div>
  );
}

export function ClusterVoteAdmitForm() {
  const { request, setClusterVoteAdmitInput } = useOps();
  const input = request?.clusterVoteAdmitInput;
  const localKey = useStoredOperatorConsensusPubkeyHex();
  const current: ClusterVoteAdmitInput = request?.kind === "cluster-vote-admit" && input
    ? input
    : {
        clusterId: "",
        operatorIdHex: "",
        voterPubkeyHex: "",
      };
  const preview = clusterVoteAdmitStatusPreview(
    request?.kind === "cluster-vote-admit" ? current : undefined,
  );
  const live = useClusterJoinRequestView(
    preview.status === "ready" ? current.clusterId : null,
    preview.operatorIdHex || null,
  );
  const selectedClusterId = parseUint32Number(current.clusterId);
  const cluster = useClusterStatus(preview.status === "ready" ? selectedClusterId : null);
  const currentEpoch = cluster.data?.epoch ?? null;
  const validity = useMemo(() => {
    const clusterOk = isUint32Decimal(input?.clusterId);
    const operatorOk = isFixedHex(input?.operatorIdHex, 32);
    const voterOk = isFixedHex(input?.voterPubkeyHex, NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES);
    return { clusterOk, operatorOk, voterOk };
  }, [input?.clusterId, input?.operatorIdHex, input?.voterPubkeyHex]);

  useEffect(() => {
    if (request?.kind !== "cluster-vote-admit") return;
    if (localKey.status !== "ready" || !localKey.pubkeyHex) return;
    if ((input?.voterPubkeyHex ?? "").trim()) return;
    setClusterVoteAdmitInput({ voterPubkeyHex: localKey.pubkeyHex });
  }, [
    input?.voterPubkeyHex,
    localKey.pubkeyHex,
    localKey.status,
    request?.kind,
    setClusterVoteAdmitInput,
  ]);

  if (!request || request.kind !== "cluster-vote-admit") return null;

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>CJ-1 admit vote inputs</div>
      <ClusterAdmissionDisclosure localKey={localKey} />
      <ClusterJoinStatusPanel
        title="Candidate request status preview"
        preview={preview}
        live={live}
        currentEpoch={currentEpoch}
      />

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Cluster id</span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="7"
          value={current.clusterId}
          onChange={(e) => setClusterVoteAdmitInput({ clusterId: e.target.value.trim() })}
          spellCheck={false}
          autoComplete="off"
          style={inputStyle(validity.clusterOk)}
        />
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Candidate operator id</span>
        <input
          type="text"
          inputMode="text"
          placeholder="0x..."
          value={current.operatorIdHex}
          onChange={(e) => setClusterVoteAdmitInput({ operatorIdHex: normalizeHex(e.target.value) })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.operatorOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          32-byte operator id, normally blake3(operator consensus pubkey).
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
          onChange={(e) => setClusterVoteAdmitInput({ voterPubkeyHex: normalizeHex(e.target.value) })}
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

export function isClusterJoinRequestInputComplete(
  input: ClusterJoinRequestInput | undefined,
): boolean {
  return (
    !!input &&
    isUint32Decimal(input.clusterId) &&
    isFixedHex(input.operatorPubkeyHex, NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES) &&
    isPositiveDecimal(input.bondLythoshi)
  );
}

export function isClusterVoteAdmitInputComplete(
  input: ClusterVoteAdmitInput | undefined,
): boolean {
  return (
    !!input &&
    isUint32Decimal(input.clusterId) &&
    isFixedHex(input.operatorIdHex, 32) &&
    isFixedHex(input.voterPubkeyHex, NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES)
  );
}

export const CLUSTER_JOIN_FORM_HEX_LENGTHS = {
  consensusPubkey: CONSENSUS_PUBKEY_HEX_CHARS + 2,
  operatorId: OPERATOR_ID_HEX_CHARS + 2,
} as const;
