import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  KEYCHAIN_ACCOUNTS,
  MONARCH_ACTIVE_OPERATOR_SEATS,
  MONARCH_CLUSTER_SIZE,
  MONARCH_CLUSTER_THRESHOLD,
  MONARCH_STANDBY_OPERATOR_SEATS,
  NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  FORM_CLUSTER_SIGNATURE_BYTES,
  FORM_CLUSTER_MEMBER_COUNT,
  deriveOperatorConsensusPubkeyHex,
  formClusterConsentMessageHex,
  keychainGet,
  operatorPubkeyHash,
  useProviderDirectory,
} from "../sdk";
import { useOps } from "./OpsContext";
import type { ClusterFormInput } from "./types";

const CONSENSUS_PUBKEY_HEX_CHARS = NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES * 2;

export const CLUSTER_FORM_RUNTIME_NOTICE =
  "Submits formCluster(bytes,bytes,bytes) on compatible runtimes. Requires ten ML-DSA-65 consent signatures in roster order and a published LythiumSeal EK for every proposed operator.";

export type ClusterFormRosterRole = "active" | "standby";

export type ClusterFormRosterEntry = {
  role: ClusterFormRosterRole;
  index: number;
  pubkeyHex: string;
  operatorIdHex: string;
};

export type ClusterFormProposalSummary = {
  activeCount: number;
  standbyCount: number;
  totalCount: number;
  invalidActiveCount: number;
  invalidStandbyCount: number;
  signatureCount: number;
  invalidSignatureCount: number;
  duplicateCount: number;
  consentMessageHex: string | null;
  ready: boolean;
  blockers: string[];
  roster: ClusterFormRosterEntry[];
};

function normalizeHex(value: string): string {
  const clean = value.trim().replace(/^0x/iu, "");
  return clean ? `0x${clean.toLowerCase()}` : "";
}

function isFixedConsensusPubkeyHex(value: string): boolean {
  return (
    value.length === CONSENSUS_PUBKEY_HEX_CHARS + 2 &&
    /^0x[0-9a-f]+$/u.test(value)
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function compactHex(value: string, head = 14, tail = 10): string {
  if (!value || value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function parseClusterFormPubkeys(value: string): string[] {
  return value
    .split(/[\s,]+/u)
    .map(normalizeHex)
    .filter(Boolean);
}

export function parseClusterFormSignatures(value: string): string[] {
  return value
    .split(/[\s,]+/u)
    .map(normalizeHex)
    .filter(Boolean);
}

function operatorIdForPubkeyHex(pubkeyHex: string): string {
  return bytesToHex(operatorPubkeyHash(hexToBytes(pubkeyHex)));
}

function duplicateOverflowCount(values: string[]): number {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let duplicates = 0;
  for (const count of counts.values()) {
    if (count > 1) duplicates += count - 1;
  }
  return duplicates;
}

function rosterEntries(
  role: ClusterFormRosterRole,
  values: string[],
): ClusterFormRosterEntry[] {
  return values
    .filter(isFixedConsensusPubkeyHex)
    .map((pubkeyHex, index) => ({
      role,
      index,
      pubkeyHex,
      operatorIdHex: operatorIdForPubkeyHex(pubkeyHex),
    }));
}

export function clusterFormProposalSummary(
  input: ClusterFormInput | undefined,
): ClusterFormProposalSummary {
  const active = parseClusterFormPubkeys(input?.activePubkeysHex ?? "");
  const standby = parseClusterFormPubkeys(input?.standbyPubkeysHex ?? "");
  const signatures = parseClusterFormSignatures(input?.signaturesHex ?? "");
  const invalidActiveCount = active.filter((value) => !isFixedConsensusPubkeyHex(value)).length;
  const invalidStandbyCount = standby.filter((value) => !isFixedConsensusPubkeyHex(value)).length;
  const invalidSignatureCount = signatures.filter(
    (value) =>
      value.length !== FORM_CLUSTER_SIGNATURE_BYTES * 2 + 2 || !/^0x[0-9a-f]+$/u.test(value),
  ).length;
  const duplicateCount = duplicateOverflowCount([...active, ...standby]);
  const blockers: string[] = [];

  if (active.length !== MONARCH_ACTIVE_OPERATOR_SEATS) {
    blockers.push(`expected ${MONARCH_ACTIVE_OPERATOR_SEATS} active operator pubkeys`);
  }
  if (standby.length !== MONARCH_STANDBY_OPERATOR_SEATS) {
    blockers.push(`expected ${MONARCH_STANDBY_OPERATOR_SEATS} standby operator pubkeys`);
  }
  if (invalidActiveCount + invalidStandbyCount > 0) {
    blockers.push(`all pubkeys must be ${NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES} byte ML-DSA-65 consensus keys`);
  }
  if (duplicateCount > 0) {
    blockers.push("active and standby rosters must not reuse a consensus pubkey");
  }
  if (signatures.length !== FORM_CLUSTER_MEMBER_COUNT) {
    blockers.push(`expected ${FORM_CLUSTER_MEMBER_COUNT} roster consent signatures`);
  }
  if (invalidSignatureCount > 0) {
    blockers.push(`all consent signatures must be ${FORM_CLUSTER_SIGNATURE_BYTES} byte ML-DSA-65 signatures`);
  }

  let consentMessageHex: string | null = null;
  if (
    active.length === MONARCH_ACTIVE_OPERATOR_SEATS &&
    standby.length === MONARCH_STANDBY_OPERATOR_SEATS &&
    invalidActiveCount + invalidStandbyCount === 0 &&
    duplicateCount === 0
  ) {
    consentMessageHex = formClusterConsentMessageHex({
      activePubkeysHex: active.join("\n"),
      standbyPubkeysHex: standby.join("\n"),
    });
  }

  return {
    activeCount: active.length,
    standbyCount: standby.length,
    totalCount: active.length + standby.length,
    invalidActiveCount,
    invalidStandbyCount,
    signatureCount: signatures.length,
    invalidSignatureCount,
    duplicateCount,
    consentMessageHex,
    ready: blockers.length === 0,
    blockers,
    roster: [
      ...rosterEntries("active", active),
      ...rosterEntries("standby", standby),
    ],
  };
}

export function isClusterFormInputComplete(input: ClusterFormInput | undefined): boolean {
  return clusterFormProposalSummary(input).ready;
}

function inputStyle(valid: boolean): CSSProperties {
  return {
    background: "rgba(0,0,0,0.3)",
    border: valid
      ? "1px solid rgba(255,255,255,0.1)"
      : "1px solid var(--err-500, #c53030)",
    color: "var(--fg-200)",
    padding: "8px 9px",
    fontSize: 11,
    borderRadius: 6,
    fontFamily: "var(--font-mono, monospace)",
    lineHeight: 1.45,
    minHeight: 128,
    resize: "vertical",
  };
}

function summaryTone(ok: boolean): string {
  return ok ? "halo halo--ok" : "halo halo--warn";
}

type SeatRole = "active" | "standby";

function seatArray(joined: string, count: number): string[] {
  const parsed = parseClusterFormPubkeys(joined);
  const seats = parsed.slice(0, count);
  while (seats.length < count) seats.push("");
  return seats;
}

/** Local stored-key probe so the operator can drop their own key into a seat. */
function useStoredSelfPubkey(): string {
  const [pubkey, setPubkey] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (cancelled || !mnemonic) return;
        setPubkey(deriveOperatorConsensusPubkeyHex(mnemonic));
      } catch {
        // Browser preview / keychain unavailable: no prefill.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return pubkey;
}

export function ClusterFormProposalForm() {
  const { request, setClusterFormInput } = useOps();
  const input = request?.clusterFormInput;
  const current: ClusterFormInput = request?.kind === "cluster-form" && input
    ? input
    : { activePubkeysHex: "", standbyPubkeysHex: "", signaturesHex: "" };
  const summary = useMemo(() => clusterFormProposalSummary(current), [current]);
  const [mode, setMode] = useState<"builder" | "bulk">(() =>
    // If a bulk payload was prefilled (ceremony export / paste), open in
    // bulk mode so nothing the operator pasted is hidden.
    parseClusterFormPubkeys(current.activePubkeysHex).length > 0 ||
    parseClusterFormPubkeys(current.standbyPubkeysHex).length > 0
      ? "bulk"
      : "builder",
  );
  const [activeSeats, setActiveSeats] = useState<string[]>(() =>
    seatArray(current.activePubkeysHex, MONARCH_ACTIVE_OPERATOR_SEATS),
  );
  const [standbySeats, setStandbySeats] = useState<string[]>(() =>
    seatArray(current.standbyPubkeysHex, MONARCH_STANDBY_OPERATOR_SEATS),
  );
  const providers = useProviderDirectory(0, null, 100);
  const selfPubkey = useStoredSelfPubkey();
  const registeredIds = useMemo(() => {
    const set = new Set<string>();
    for (const row of providers.data ?? []) set.add(row.peerId.toLowerCase());
    return set;
  }, [providers.data]);

  const activeOk =
    summary.activeCount === MONARCH_ACTIVE_OPERATOR_SEATS &&
    summary.invalidActiveCount === 0 &&
    summary.duplicateCount === 0;
  const standbyOk =
    summary.standbyCount === MONARCH_STANDBY_OPERATOR_SEATS &&
    summary.invalidStandbyCount === 0 &&
    summary.duplicateCount === 0;
  const signaturesOk =
    summary.signatureCount === FORM_CLUSTER_MEMBER_COUNT &&
    summary.invalidSignatureCount === 0;

  if (!request || request.kind !== "cluster-form") return null;

  const writeSeats = (nextActive: string[], nextStandby: string[]) => {
    setActiveSeats(nextActive);
    setStandbySeats(nextStandby);
    setClusterFormInput({
      activePubkeysHex: nextActive.map(normalizeHex).filter(Boolean).join("\n"),
      standbyPubkeysHex: nextStandby.map(normalizeHex).filter(Boolean).join("\n"),
    });
  };

  const setSeat = (role: SeatRole, index: number, value: string) => {
    if (role === "active") {
      const next = [...activeSeats];
      next[index] = value;
      writeSeats(next, standbySeats);
    } else {
      const next = [...standbySeats];
      next[index] = value;
      writeSeats(activeSeats, next);
    }
  };

  const selfNormalized = normalizeHex(selfPubkey);
  const selfAlreadySeated =
    !!selfNormalized &&
    [...activeSeats, ...standbySeats].some((seat) => normalizeHex(seat) === selfNormalized);

  const seatRow = (role: SeatRole, index: number, value: string) => {
    const normalized = normalizeHex(value);
    const filled = normalized.length > 0;
    const valid = filled && isFixedConsensusPubkeyHex(normalized);
    const operatorId = valid ? operatorIdForPubkeyHex(normalized) : "";
    const registered =
      valid && registeredIds.size > 0 ? registeredIds.has(operatorId.toLowerCase()) : null;
    const isSelf = valid && !!selfNormalized && normalized === selfNormalized;
    return (
      <div key={`${role}-${index}`} style={{ display: "grid", gap: 4 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="kv__k" style={{ width: 86, flex: "0 0 auto" }}>
            {role} {index + 1}
            {isSelf ? (
              <span className="halo halo--gold" style={{ marginLeft: 6, fontSize: 9 }}>YOU</span>
            ) : null}
          </span>
          <input
            type="text"
            placeholder={`0x… ${NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES}-byte consensus pubkey`}
            value={value}
            onChange={(event) => setSeat(role, index, event.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            style={{
              ...inputStyle(!filled || valid),
              minHeight: 0,
              resize: "none",
              flex: 1,
              padding: "6px 8px",
            }}
          />
          {!filled && selfNormalized && !selfAlreadySeated ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setSeat(role, index, selfNormalized)}
              title="Fill this seat with your own consensus pubkey (derived from the stored mnemonic)"
            >
              Use my key
            </button>
          ) : null}
        </div>
        {valid ? (
          <span className="mono" style={{ fontSize: 10, color: "var(--fg-400)", paddingLeft: 94 }}>
            id {compactHex(operatorId, 12, 8)}
            {registered === true
              ? " · registered ✓"
              : registered === false
                ? " · NOT in the provider directory — this operator must register first"
                : ""}
          </span>
        ) : filled ? (
          <span style={{ fontSize: 10, color: "var(--err-300, #fc8181)", paddingLeft: 94 }}>
            not a {NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES}-byte consensus pubkey
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>Cluster formation roster</div>
      <div className="halo halo--warn" style={{ alignSelf: "flex-start", alignItems: "flex-start", lineHeight: 1.35, marginBottom: 12 }}>
        <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
        <span>{CLUSTER_FORM_RUNTIME_NOTICE}</span>
      </div>

      <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
        <div className={summaryTone(summary.ready)} style={{ alignSelf: "flex-start" }}>
          <span className="dot" /> {summary.ready ? "Roster proposal is structurally valid." : "Roster proposal needs attention."}
        </div>
        <div className="kv">
          <span className="kv__k">Topology</span>
          <span className="kv__v mono">
            {MONARCH_CLUSTER_THRESHOLD}-of-{MONARCH_CLUSTER_SIZE} · {MONARCH_ACTIVE_OPERATOR_SEATS} active + {MONARCH_STANDBY_OPERATOR_SEATS} standby
          </span>
        </div>
        <div className="kv">
          <span className="kv__k">Provided</span>
          <span className="kv__v mono">
            {summary.activeCount} active · {summary.standbyCount} standby · {summary.totalCount} total · {summary.signatureCount} signatures
          </span>
        </div>
        {summary.consentMessageHex ? (
          <div className="kv">
            <span className="kv__k">Consent digest</span>
            <span className="kv__v mono">{compactHex(summary.consentMessageHex, 18, 12)}</span>
          </div>
        ) : null}
        {summary.blockers.length > 0 ? (
          <div style={{ display: "grid", gap: 6 }}>
            {summary.blockers.map((blocker) => (
              <div className="drawer__effect" key={blocker}>
                <span className="dot" />
                <span>{blocker}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="segmented" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className={mode === "builder" ? "is-on" : ""}
          onClick={() => {
            setActiveSeats(seatArray(current.activePubkeysHex, MONARCH_ACTIVE_OPERATOR_SEATS));
            setStandbySeats(seatArray(current.standbyPubkeysHex, MONARCH_STANDBY_OPERATOR_SEATS));
            setMode("builder");
          }}
        >
          Roster builder
        </button>
        <button
          type="button"
          className={mode === "bulk" ? "is-on" : ""}
          onClick={() => setMode("bulk")}
        >
          Bulk paste (advanced)
        </button>
      </div>

      {mode === "builder" ? (
        <div style={{ display: "grid", gap: 10 }}>
          <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
            Paste one consensus pubkey per seat (each member shares theirs — the ceremony room
            automates this). Seats are checked live against the on-chain provider directory
            {providers.notExposed ? " (directory not exposed on this endpoint)" : ""}.
          </span>
          {activeSeats.map((seat, index) => seatRow("active", index, seat))}
          <div style={{ borderTop: "1px solid var(--glass-stroke)", margin: "2px 0" }} />
          {standbySeats.map((seat, index) => seatRow("standby", index, seat))}
        </div>
      ) : (
        <>
          <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
            <span className="kv__k">Active operator consensus pubkeys</span>
            <textarea
              placeholder="0x..."
              value={current.activePubkeysHex}
              onChange={(event) => setClusterFormInput({ activePubkeysHex: event.target.value })}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              style={inputStyle(activeOk)}
            />
            <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
              One {NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES} byte ML-DSA-65 consensus pubkey per line; exactly {MONARCH_ACTIVE_OPERATOR_SEATS} active seats.
            </span>
          </label>

          <label
            className="kv"
            style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
          >
            <span className="kv__k">Standby operator consensus pubkeys</span>
            <textarea
              placeholder="0x..."
              value={current.standbyPubkeysHex}
              onChange={(event) => setClusterFormInput({ standbyPubkeysHex: event.target.value })}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              style={inputStyle(standbyOk)}
            />
            <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
              Exactly {MONARCH_STANDBY_OPERATOR_SEATS} standby pubkeys; duplicates across active and standby are rejected.
            </span>
          </label>
        </>
      )}

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Roster consent signatures</span>
        <textarea
          placeholder="0x..."
          value={current.signaturesHex}
          onChange={(event) => setClusterFormInput({ signaturesHex: event.target.value })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(signaturesOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Exactly {FORM_CLUSTER_MEMBER_COUNT} signatures over the consent digest, active roster first,
          then standby roster. The ceremony room collects these automatically.
        </span>
      </label>

      {summary.roster.length > 0 ? (
        <div
          style={{
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            background: "rgba(255,255,255,0.025)",
            padding: 12,
            marginTop: 12,
          }}
        >
          <div className="cap" style={{ marginBottom: 8 }}>Derived operator ids</div>
          <div style={{ display: "grid", gap: 7 }}>
            {summary.roster.slice(0, MONARCH_CLUSTER_SIZE).map((entry) => (
              <div className="kv" key={`${entry.role}-${entry.index}`}>
                <span className="kv__k">{entry.role} {entry.index + 1}</span>
                <span className="mono" style={{ color: "var(--fg-300)", fontSize: 11 }}>
                  {compactHex(entry.operatorIdHex)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const CLUSTER_FORM_HEX_LENGTHS = {
  consensusPubkey: CONSENSUS_PUBKEY_HEX_CHARS + 2,
  consentSignature: FORM_CLUSTER_SIGNATURE_BYTES * 2 + 2,
} as const;
