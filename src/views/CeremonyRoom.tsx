// Ceremony Room — the live multi-party formCluster lobby.
//
// Ten registered operators meet on a signed "ceremony-{hex}" chat
// channel, claim seats (7 active + 3 standby), see the EXACT terms they
// are signing, publish ML-DSA-65 consents over the locally recomputed
// digest, and hand the assembled roster to the existing Operations
// drawer (preview → auth → execute) for the formCluster submit.
//
// The view owns its OWN listenCeremonyMessages subscription — useChat
// only tails the chat view's active channel. All lobby state is the
// pure `reduceCeremony` fold over the channel's messages; this file is
// presentation + transport calls only.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseLythToLythoshi } from "@monolythium/core-sdk";
import { mergeChatMessage } from "../hooks/useChat";
import { useOps } from "../ops";
import type { ClusterFormInput } from "../ops/types";
import type { ChatInitResult, ChatMessage } from "../sdk/chat";
import { rpc, rpcEndpoint } from "../sdk/client";
import {
  FORM_CLUSTER_ACTIVE_COUNT,
  FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS,
  FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS,
  FORM_CLUSTER_MEMBER_COUNT,
  FORM_CLUSTER_STANDBY_COUNT,
  FORM_CLUSTER_THRESHOLD,
  encodeClusterCharterHex,
  validateClusterCharterHex,
  type DecodedClusterCharter,
} from "../sdk/clusterFormOps";
import {
  CEREMONY_SCHEMA_VERSION,
  CeremonyTransportUnavailableError,
  buildCeremonySnapshotBody,
  buildClusterFormOpRequest,
  canSubmitCeremony,
  ceremonyCharterHashHex,
  ceremonyChatInitialize,
  ceremonyRoster,
  ceremonyRosterPubkeys,
  dialCeremonyPeers,
  exportCeremonyJson,
  fetchCeremonyMessages,
  fetchCeremonySeatChainStatuses,
  formatDigestGroups,
  importCeremonyJson,
  isActiveCeremonyMember,
  listenCeremonyMessages,
  newCeremonyId,
  reduceCeremony,
  sendCeremonyBody,
  signCeremonyConsent,
  subscribeCeremonyChannel,
  type CeremonyConsent,
  type CeremonyImportResult,
  type CeremonyRosterRow,
  type CeremonySeatChainStatus,
  type CeremonySeatDecl,
  type CeremonySeatRef,
  type CeremonyState,
} from "../sdk/ceremony";

// ---- small presentation helpers ---------------------------------------

function normalizeHex(value: string): string {
  const clean = value.trim().replace(/^0x/iu, "").toLowerCase();
  return clean ? `0x${clean}` : "";
}

function compactHex(value: string, head = 12, tail = 8): string {
  if (!value || value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function formatLythoshiAsLyth(lythoshi: string): string {
  try {
    const value = BigInt(lythoshi);
    const unit = 10n ** 18n;
    const whole = value / unit;
    const frac = value % unit;
    if (frac === 0n) return `${whole.toLocaleString()} LYTH`;
    const fracStr = (frac + unit).toString().slice(1, 5).replace(/0+$/u, "");
    return `${whole.toLocaleString()}.${fracStr} LYTH`;
  } catch {
    return `${lythoshi} lythoshi`;
  }
}

function formatCountdown(expiresMs: number, nowMs: number): string {
  const remaining = expiresMs - nowMs;
  if (remaining <= 0) return "expired";
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function consentStatusLabel(consent: CeremonyConsent | null): { label: string; tone: string } {
  if (!consent) return { label: "consent pending", tone: "halo halo--warn" };
  switch (consent.status) {
    case "valid":
      return { label: "consent verified", tone: "halo halo--ok" };
    case "stale-digest":
      return { label: "consent stale (digest changed)", tone: "halo halo--warn" };
    case "invalid-signature":
      return { label: "consent signature INVALID", tone: "halo halo--err" };
    default:
      return { label: "consent without a seat", tone: "halo halo--warn" };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- charter helpers -----------------------------------------------------

const CHARTER_DEFAULT_MEMBER_SHARE_BPS = 1000;
const CHARTER_DEFAULT_DELEGATOR_SHARE_BPS = 5000;
const CHARTER_DEFAULT_EXPIRY_MS = 48 * 3_600_000; // now + 48h

/** Member-declaration order labels: members 0..6 = active, 7..9 = standby. */
function charterSeatLabel(memberIndex: number): string {
  return memberIndex < FORM_CLUSTER_ACTIVE_COUNT
    ? `active ${memberIndex + 1}`
    : `standby ${memberIndex - FORM_CLUSTER_ACTIVE_COUNT + 1}`;
}

function bpsToPct(bps: number, digits = 1): string {
  return `${(bps / 100).toFixed(digits)}%`;
}

function toDatetimeLocalValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDatetimeLocalValue(value: string): number | null {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Decoded charter from the pinned terms — null when absent or malformed
 *  (the reducer refuses malformed charters; this is render defense). */
function decodeTermsCharter(state: CeremonyState): DecodedClusterCharter | null {
  if (!state.terms?.charter) return null;
  try {
    return validateClusterCharterHex(state.terms.charter);
  } catch {
    return null;
  }
}

// ---- seat card ---------------------------------------------------------

function SeatCard(props: {
  row: CeremonyRosterRow;
  isYou: boolean;
  chainStatus: CeremonySeatChainStatus | null;
  canClaim: boolean;
  onClaim: (seat: CeremonySeatRef) => void;
}) {
  const { row, isYou, chainStatus, canClaim, onClaim } = props;
  const seatLabel = `${row.seat.role} ${row.seat.index + 1}`;
  const consent = consentStatusLabel(row.consent);
  return (
    <div
      className="card"
      style={{
        padding: 14,
        background: isYou ? "rgba(242,180,65,0.06)" : "rgba(255,255,255,0.02)",
        border: isYou ? "1px solid rgba(242,180,65,0.45)" : "1px solid rgba(255,255,255,0.08)",
        display: "grid",
        gap: 8,
        alignContent: "start",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="cap">{seatLabel}</span>
        {row.seat.role === "active" ? (
          <span className="halo halo--gold" style={{ fontSize: 10 }}>active</span>
        ) : (
          <span className="halo halo--info" style={{ fontSize: 10 }}>standby</span>
        )}
        {isYou ? <span className="halo halo--gold" style={{ fontSize: 10 }}>YOU</span> : null}
      </div>
      {row.participant ? (
        <>
          <div className="kv">
            <span className="kv__k">Operator id</span>
            <span className="kv__v mono" style={{ fontSize: 11 }}>
              {compactHex(row.participant.operatorIdHex)}
            </span>
          </div>
          <div className="kv">
            <span className="kv__k">Address</span>
            <span className="kv__v mono" style={{ fontSize: 11 }}>
              {compactHex(row.participant.address)}
            </span>
          </div>
          <div className={consent.tone} style={{ alignSelf: "flex-start", fontSize: 10.5 }}>
            <span className="dot" /> {consent.label}
          </div>
          {chainStatus ? (
            chainStatus.error ? (
              <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
                chain check unavailable on this endpoint
              </span>
            ) : (
              <div
                className={chainStatus.bonded ? "halo halo--ok" : "halo halo--err"}
                style={{ alignSelf: "flex-start", fontSize: 10.5 }}
              >
                <span className="dot" />
                {chainStatus.bonded ? "bonded" : "NOT bonded"} · {chainStatus.lifecycleState ?? "—"}
              </div>
            )
          ) : null}
        </>
      ) : (
        <>
          <span style={{ fontSize: 11.5, color: "var(--fg-400)" }}>
            Open seat{row.seat.operator_id ? ` — reserved for ${compactHex(row.seat.operator_id)}` : ""}.
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={!canClaim}
            onClick={() => onClaim({ role: row.seat.role, index: row.seat.index })}
          >
            Claim this seat
          </button>
        </>
      )}
    </div>
  );
}

// ---- terms panel --------------------------------------------------------

function TermsPanel(props: { state: CeremonyState; nowMs: number }) {
  const terms = props.state.terms;
  if (!terms) return null;
  const charter = decodeTermsCharter(props.state);
  const charterExpired = charter !== null && props.nowMs >= charter.expiresMs;
  const perMemberPct = (10_000 / FORM_CLUSTER_MEMBER_COUNT / 100).toFixed(1);
  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", padding: 16, display: "grid", gap: 8 }}>
      <div className="cap">You sign these exact terms</div>
      <div className="kv">
        <span className="kv__k">Topology</span>
        <span className="kv__v mono">
          {FORM_CLUSTER_THRESHOLD}-of-{FORM_CLUSTER_MEMBER_COUNT} · {FORM_CLUSTER_ACTIVE_COUNT} active + {FORM_CLUSTER_STANDBY_COUNT} standby
        </span>
      </div>
      <div className="kv">
        <span className="kv__k">Bond per operator</span>
        <span className="kv__v mono">
          {formatLythoshiAsLyth(terms.bond_lythoshi)} ({terms.bond_lythoshi} lythoshi)
        </span>
      </div>
      <div className="kv">
        <span className="kv__k">Commission</span>
        <span className="kv__v mono">{(terms.commission_bps / 100).toFixed(2)}%</span>
      </div>
      {charter ? (
        <>
          <div className="halo halo--ok" style={{ alignSelf: "flex-start", alignItems: "flex-start", lineHeight: 1.4, fontSize: 11 }}>
            <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
            <span>
              CHARTER (V2) — these economic terms are folded into the consent digest you sign.
              A signature over this charter cannot be replayed under different terms.
            </span>
          </div>
          <div
            style={{
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 8,
              background: "rgba(255,255,255,0.02)",
              padding: 10,
              display: "grid",
              gap: 5,
            }}
          >
            <div className="cap" style={{ fontSize: 10 }}>Per-seat operator-pot shares</div>
            {charter.memberShareBps.map((bps, index) => (
              <div className="kv" key={`share-${index}`}>
                <span className="kv__k">{charterSeatLabel(index)}</span>
                <span className="kv__v mono">
                  {bps} bps = {bpsToPct(bps)}
                </span>
              </div>
            ))}
          </div>
          <div className="kv">
            <span className="kv__k">Delegator share</span>
            <span className="kv__v mono">
              {charter.delegatorShareBps} bps = {bpsToPct(charter.delegatorShareBps)}
            </span>
          </div>
          <div className="kv">
            <span className="kv__k">Charter consent expiry</span>
            <span className="kv__v mono" style={charterExpired ? { color: "var(--err)" } : undefined}>
              {formatCountdown(charter.expiresMs, props.nowMs)} · {new Date(charter.expiresMs).toLocaleString()}
            </span>
          </div>
          {charterExpired ? (
            <div className="halo halo--err" style={{ alignSelf: "flex-start", fontSize: 11 }}>
              <span className="dot" /> The charter's consent expiry has passed — the chain
              rejects this formation. Propose a fresh ceremony.
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="kv">
            <span className="kv__k">Per-member share</span>
            <span className="kv__v mono">{perMemberPct}% each (equal split, protocol default)</span>
          </div>
          <div className="kv">
            <span className="kv__k">Delegator share</span>
            <span className="kv__v mono">50% (protocol default)</span>
          </div>
          <div className="halo halo--warn" style={{ alignSelf: "flex-start", alignItems: "flex-start", lineHeight: 1.4, fontSize: 11 }}>
            <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
            <span>
              No charter: this ceremony signs the V1 digest, which covers the roster and
              threshold only. The cluster gets the protocol-default economics (equal member
              split, 50% delegators); the display terms above bind through the initiator's
              signed proposal envelope — attributable, but not enforced by the chain.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ---- main view -----------------------------------------------------------

export default function CeremonyRoom() {
  const ops = useOps();

  // connection / identity
  const [selfInit, setSelfInit] = useState<ChatInitResult | null>(null);
  const [ceremonyIdInput, setCeremonyIdInput] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [joined, setJoined] = useState<{ channelId: string; cid: string } | null>(null);
  const [joining, setJoining] = useState(false);
  const [transportNotice, setTransportNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // lobby data
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [seatChainStatuses, setSeatChainStatuses] = useState<Record<string, CeremonySeatChainStatus>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());

  // forms
  const [dialAddrs, setDialAddrs] = useState("");
  const [dialStatus, setDialStatus] = useState<string | null>(null);
  const [bondLyth, setBondLyth] = useState("5000");
  const [commissionBps, setCommissionBps] = useState("500");
  const [expiryMinutes, setExpiryMinutes] = useState("120");
  const [pinnedIds, setPinnedIds] = useState("");
  // charter (V2 economic terms) editor
  const [withCharter, setWithCharter] = useState(true);
  const [charterShares, setCharterShares] = useState<string[]>(() =>
    Array.from({ length: FORM_CLUSTER_MEMBER_COUNT }, () =>
      String(CHARTER_DEFAULT_MEMBER_SHARE_BPS),
    ),
  );
  const [charterDelegatorBps, setCharterDelegatorBps] = useState(
    CHARTER_DEFAULT_DELEGATOR_SHARE_BPS,
  );
  const [charterExpiryLocal, setCharterExpiryLocal] = useState(() =>
    toDatetimeLocalValue(Date.now() + CHARTER_DEFAULT_EXPIRY_MS),
  );
  const [busy, setBusy] = useState(false);
  const [consentPublishedAt, setConsentPublishedAt] = useState<number | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  // export / import
  const [exportJson, setExportJson] = useState<string | null>(null);
  const [importJsonText, setImportJsonText] = useState("");
  const [imported, setImported] = useState<CeremonyImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 1-second tick for the expiry countdown.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const state = useMemo(() => reduceCeremony(messages), [messages]);
  const selfAddress = selfInit ? normalizeHex(selfInit.address_hex) : null;
  const selfParticipant = selfAddress
    ? state.participants.find((p) => normalizeHex(p.address) === selfAddress) ?? null
    : null;
  const selfConsent = selfAddress
    ? state.consents.find((c) => normalizeHex(c.address) === selfAddress) ?? null
    : null;
  const isInitiator =
    selfAddress !== null &&
    state.initiatorAddress !== null &&
    normalizeHex(state.initiatorAddress) === selfAddress;
  const roster = useMemo(() => ceremonyRoster(state), [state]);
  const rosterComplete = state.localDigest !== null;
  const expired = state.expiresMs !== null && nowMs >= state.expiresMs;
  const submitVerdict = canSubmitCeremony(state, selfAddress, nowMs);
  const effectiveDigest = state.frozenDigest ?? state.localDigest;
  const termsCharter = useMemo(() => decodeTermsCharter(state), [state]);
  const charterExpired = termsCharter !== null && nowMs >= termsCharter.expiresMs;
  const charterShareSum = useMemo(
    () =>
      charterShares.reduce((sum, raw) => {
        const bps = Number.parseInt(raw.trim(), 10);
        return Number.isInteger(bps) && bps >= 0 ? sum + bps : Number.NaN;
      }, 0),
    [charterShares],
  );

  const handleTransportError = useCallback((err: unknown) => {
    if (err instanceof CeremonyTransportUnavailableError) {
      setTransportNotice(err.message);
    } else {
      setError(errText(err));
    }
  }, []);

  // Live tail + history for the joined ceremony channel (own subscription).
  useEffect(() => {
    if (!joined) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const history = await fetchCeremonyMessages(joined.channelId);
        if (cancelled || !aliveRef.current) return;
        setMessages(history);
        unlisten = await listenCeremonyMessages(joined.channelId, (msg) => {
          if (cancelled || !aliveRef.current) return;
          if (msg.channel_id !== joined.channelId) return;
          setMessages((prev) => mergeChatMessage(prev, msg));
        });
      } catch (err) {
        if (!cancelled && aliveRef.current) handleTransportError(err);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [joined, handleTransportError]);

  // Per-seat lyth_operatorInfo bonded/lifecycle probe.
  const participantIdsKey = state.participants
    .map((p) => p.operatorIdHex)
    .sort()
    .join(",");
  useEffect(() => {
    if (!participantIdsKey) {
      setSeatChainStatuses({});
      return;
    }
    let cancelled = false;
    void fetchCeremonySeatChainStatuses(rpc, participantIdsKey.split(",")).then((statuses) => {
      if (!cancelled && aliveRef.current) setSeatChainStatuses(statuses);
    });
    return () => {
      cancelled = true;
    };
  }, [participantIdsKey]);

  // ---- handlers ----------------------------------------------------------

  const connect = useCallback(
    async (ceremonyId: string) => {
      setError(null);
      setJoining(true);
      try {
        const init = await ceremonyChatInitialize({ rpcEndpoint });
        if (!init) {
          setError(
            "Operator PQM-1 key is not stored yet — add your operator key in Keys before joining a ceremony.",
          );
          return;
        }
        setSelfInit(init);
        const channel = await subscribeCeremonyChannel({
          ceremonyId,
          name: displayName.trim() || undefined,
        });
        setJoined({ channelId: channel.channel_id, cid: ceremonyId });
        setCeremonyIdInput(ceremonyId);
      } catch (err) {
        handleTransportError(err);
      } finally {
        if (aliveRef.current) setJoining(false);
      }
    },
    [displayName, handleTransportError],
  );

  const handleJoinExisting = useCallback(() => {
    const id = ceremonyIdInput.trim().toLowerCase();
    if (!/^[0-9a-f]{4,64}$/u.test(id)) {
      setError("Ceremony id must be 4-64 lowercase hex characters.");
      return;
    }
    void connect(id);
  }, [ceremonyIdInput, connect]);

  const handleStartNew = useCallback(() => {
    void connect(newCeremonyId());
  }, [connect]);

  const handleDial = useCallback(async () => {
    const addrs = dialAddrs
      .split(/[\s,]+/u)
      .map((part) => part.trim())
      .filter(Boolean);
    if (addrs.length === 0) return;
    setDialStatus(null);
    try {
      await dialCeremonyPeers(addrs);
      setDialStatus(`dialed ${addrs.length} peer${addrs.length === 1 ? "" : "s"}`);
    } catch (err) {
      handleTransportError(err);
    }
  }, [dialAddrs, handleTransportError]);

  const send = useCallback(
    async (body: Parameters<typeof sendCeremonyBody>[1]) => {
      if (!joined) return false;
      setBusy(true);
      setError(null);
      try {
        await sendCeremonyBody(joined.channelId, body);
        return true;
      } catch (err) {
        handleTransportError(err);
        return false;
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [joined, handleTransportError],
  );

  const handlePropose = useCallback(async () => {
    if (!joined) return;
    const bondLythoshi = parseLythToLythoshi(bondLyth.trim() || "0");
    if (bondLythoshi === null || bondLythoshi <= 0n) {
      setError("Bond must be a positive LYTH amount.");
      return;
    }
    const commission = Number.parseInt(commissionBps, 10);
    if (!Number.isInteger(commission) || commission < 0 || commission > 10_000) {
      setError("Commission must be 0-10000 bps.");
      return;
    }
    const minutes = Number.parseInt(expiryMinutes, 10);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      setError("Expiry must be a positive number of minutes.");
      return;
    }
    const ids = pinnedIds
      .split(/[\s,]+/u)
      .map((part) => part.trim())
      .filter(Boolean)
      .map(normalizeHex);
    if (ids.length > 0 && ids.length !== FORM_CLUSTER_MEMBER_COUNT) {
      setError(`Pin either no seats or all ${FORM_CLUSTER_MEMBER_COUNT} operator ids (one per line).`);
      return;
    }
    const seats: CeremonySeatDecl[] = [];
    for (let i = 0; i < FORM_CLUSTER_ACTIVE_COUNT; i += 1) {
      seats.push({ role: "active", index: i, operator_id: ids[i] ?? "" });
    }
    for (let i = 0; i < FORM_CLUSTER_STANDBY_COUNT; i += 1) {
      seats.push({
        role: "standby",
        index: i,
        operator_id: ids[FORM_CLUSTER_ACTIVE_COUNT + i] ?? "",
      });
    }

    // Charter (V2 economic terms) — encoded + validated client-side so a
    // charter the chain would reject never reaches the lobby.
    let charterHex = "";
    let charterHash = "";
    if (withCharter) {
      const shares = charterShares.map((raw) => Number.parseInt(raw.trim(), 10));
      if (shares.some((bps) => !Number.isInteger(bps) || bps < 0 || bps > FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS)) {
        setError(`Charter member shares must be whole numbers between 0 and ${FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS} bps.`);
        return;
      }
      const sum = shares.reduce((acc, bps) => acc + bps, 0);
      if (sum !== FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS) {
        setError(`Charter member shares must sum to exactly ${FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS} bps — currently ${sum}.`);
        return;
      }
      if (
        charterDelegatorBps < FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS ||
        charterDelegatorBps > FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS
      ) {
        setError(
          `Charter delegator share must be between ${FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS} bps (protocol floor) and ${FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS} bps.`,
        );
        return;
      }
      const charterExpiresMs = parseDatetimeLocalValue(charterExpiryLocal);
      if (charterExpiresMs === null || charterExpiresMs <= Date.now()) {
        setError("Charter consent expiry must be a valid moment in the future.");
        return;
      }
      try {
        charterHex = encodeClusterCharterHex({
          memberShareBps: shares,
          delegatorShareBps: charterDelegatorBps,
          expiresMs: charterExpiresMs,
        });
        validateClusterCharterHex(charterHex, { nowMs: Date.now() });
        charterHash = ceremonyCharterHashHex(charterHex);
      } catch (err) {
        setError(errText(err));
        return;
      }
    }

    await send({
      v: CEREMONY_SCHEMA_VERSION,
      t: "propose",
      cid: joined.cid,
      seats,
      terms: {
        threshold: FORM_CLUSTER_THRESHOLD,
        bond_lythoshi: bondLythoshi.toString(),
        commission_bps: commission,
        ...(charterHex ? { charter: charterHex } : {}),
        charter_hash: charterHash,
      },
      expires_ms: Date.now() + minutes * 60_000,
    });
  }, [
    joined,
    bondLyth,
    commissionBps,
    expiryMinutes,
    pinnedIds,
    withCharter,
    charterShares,
    charterDelegatorBps,
    charterExpiryLocal,
    send,
  ]);

  const handleClaim = useCallback(
    (seat: CeremonySeatRef) => {
      if (!joined || !state.proposeMsgId) return;
      void send({ t: "join", cid: joined.cid, ref: state.proposeMsgId, seat });
    },
    [joined, state.proposeMsgId, send],
  );

  const handleFreeze = useCallback(() => {
    if (!joined || !state.proposeMsgId || !state.localDigest) return;
    void send({
      t: "freeze",
      cid: joined.cid,
      ref: state.proposeMsgId,
      consent_digest: state.localDigest,
    });
  }, [joined, state.proposeMsgId, state.localDigest, send]);

  const handleSign = useCallback(async () => {
    if (!joined || !state.proposeMsgId) return;
    const rosterKeys = ceremonyRosterPubkeys(state);
    if (!rosterKeys || !effectiveDigest) {
      setError("The roster must be fully claimed before signing.");
      return;
    }
    if (state.digestMismatch) {
      setError("Frozen digest does not match the locally recomputed digest — refusing to sign.");
      return;
    }
    const charterHex = state.terms?.charter ? normalizeHex(state.terms.charter) : undefined;
    if (charterHex) {
      try {
        validateClusterCharterHex(charterHex, { nowMs: Date.now() });
      } catch (err) {
        setError(`Refusing to sign: ${errText(err)}`);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      // With a charter the Rust signer derives + signs the V2 digest
      // (charter committed); the cross-check below recomputes it locally
      // and refuses on any disagreement — same rule as V1.
      const signed = await signCeremonyConsent({
        activePubkeysHex: rosterKeys.activePubkeysHex,
        standbyPubkeysHex: rosterKeys.standbyPubkeysHex,
        charterHex,
      });
      if (normalizeHex(signed.digest_hex) !== normalizeHex(effectiveDigest)) {
        setError(
          "Signer returned a different consent digest than this client recomputed — refusing to publish. Do not proceed until every client agrees on the digest.",
        );
        return;
      }
      const sent = await send({
        t: "consent",
        cid: joined.cid,
        ref: state.proposeMsgId,
        consent_digest: normalizeHex(signed.digest_hex),
        sig: signed.signature_hex,
      });
      if (sent) setConsentPublishedAt(Date.now());
    } catch (err) {
      handleTransportError(err);
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [joined, state, effectiveDigest, send, handleTransportError]);

  const handleResendConsent = useCallback(async () => {
    if (!joined || !state.proposeMsgId || !selfConsent) return;
    const sent = await send({
      t: "consent",
      cid: joined.cid,
      ref: state.proposeMsgId,
      consent_digest: selfConsent.consentDigest,
      sig: selfConsent.sigHex,
    });
    if (sent) setConsentPublishedAt(Date.now());
  }, [joined, state.proposeMsgId, selfConsent, send]);

  const handleWithdraw = useCallback(() => {
    if (!joined || !state.proposeMsgId) return;
    setConfirmWithdraw(false);
    void send({ t: "withdraw", cid: joined.cid, ref: state.proposeMsgId });
  }, [joined, state.proposeMsgId, send]);

  const handleSnapshot = useCallback(() => {
    const body = buildCeremonySnapshotBody(state);
    if (!body) return;
    void send(body);
  }, [state, send]);

  const handleSubmit = useCallback(() => {
    const request = buildClusterFormOpRequest(state);
    if (!request) {
      setError("The ceremony is not ready to submit.");
      return;
    }
    ops.requestOp(request);
  }, [state, ops]);

  const handleExport = useCallback(() => {
    try {
      setExportJson(exportCeremonyJson(state));
    } catch (err) {
      setError(errText(err));
    }
  }, [state]);

  const handleImport = useCallback(() => {
    setImportError(null);
    setImported(null);
    try {
      setImported(importCeremonyJson(importJsonText));
    } catch (err) {
      setImportError(errText(err));
    }
  }, [importJsonText]);

  const handleSubmitImported = useCallback(
    (input: ClusterFormInput, digestHex: string) => {
      const executor = input.charterHex
        ? "formCluster(bytes,bytes,bytes,bytes)"
        : "formCluster(bytes,bytes,bytes)";
      ops.requestOp({
        kind: "cluster-form",
        title: "Form cluster",
        sub: "Submit imported ceremony roster",
        intro: input.charterHex
          ? "Submits a formCluster(bytes,bytes,bytes,bytes) roster with its V2 economics charter, imported from a ceremony JSON export. Every consent signature was verified against the recomputed charter-committing digest before this prefill was offered."
          : "Submits a formCluster(bytes,bytes,bytes) roster imported from a ceremony JSON export. Every consent signature was verified against the recomputed digest before this prefill was offered.",
        icon: "FC",
        risk: "high",
        destructive: true,
        needsPasskey: true,
        confirmLabel: "Sign formation",
        effects: [
          "Validates exactly 7 active and 3 standby ML-DSA-65 consensus pubkeys.",
          "All ten imported consent signatures verified locally before prefill.",
          ...(input.charterHex
            ? ["Encodes the imported 30-byte economics charter — the verified V2 digest commits to these exact terms."]
            : []),
          "Preflights formCluster, then signs with the active operator's PQM-1 mnemonic.",
        ],
        diff: [
          { key: "cluster", label: "Cluster", value: "+ roster proposal (imported)" },
          { key: "digest", label: "Consent digest", value: digestHex },
        ],
        fields: [
          { key: "digest", label: "Consent digest", value: digestHex },
          { key: "executor", label: "Executor", value: executor },
        ],
        clusterFormInput: input,
      });
    },
    [ops],
  );

  const copyDigest = useCallback(() => {
    if (!effectiveDigest) return;
    void navigator.clipboard?.writeText(effectiveDigest).catch(() => {});
  }, [effectiveDigest]);

  // Whether the imported roster contains our ACTIVE pubkey (chain rejects others).
  const importedSelfActive = useMemo(() => {
    if (!imported || !selfInit) return false;
    const selfPubkey = normalizeHex(selfInit.public_key_hex);
    return imported.seats.some(
      (seat) => seat.role === "active" && normalizeHex(seat.pubkey_hex) === selfPubkey,
    );
  }, [imported, selfInit]);

  // ---- render -------------------------------------------------------------

  return (
    <section className="view fade-in">
      <header>
        <h1 className="view__title">Ceremony room</h1>
        <p className="view__subtitle">
          live formCluster lobby · {FORM_CLUSTER_ACTIVE_COUNT} active + {FORM_CLUSTER_STANDBY_COUNT} standby
          operators · {FORM_CLUSTER_THRESHOLD}-of-{FORM_CLUSTER_MEMBER_COUNT} threshold
        </p>
      </header>

      {transportNotice ? (
        <div className="halo halo--warn" style={{ alignSelf: "flex-start", alignItems: "flex-start", lineHeight: 1.4, marginTop: 12 }}>
          <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
          <span>{transportNotice}</span>
        </div>
      ) : null}
      {error ? (
        <div className="halo halo--err" style={{ alignSelf: "flex-start", alignItems: "flex-start", lineHeight: 1.4, marginTop: 12 }}>
          <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
          <span>{error}</span>
        </div>
      ) : null}

      {!joined ? (
        <div className="card card--padded" style={{ marginTop: 16, display: "grid", gap: 12, maxWidth: 640 }}>
          <div className="cap">Join or start a ceremony</div>
          <p style={{ fontSize: 12.5, color: "var(--fg-300)", lineHeight: 1.5, margin: 0 }}>
            A ceremony is a signed lobby where ten registered operators assemble a new cluster.
            Every participant must be a registered operator and should have published chat
            bootstrap peers (Operations → Chat bootstrap peers) so the lobby can mesh.
          </p>
          <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
            <span className="kv__k">Display name (optional)</span>
            <input
              className="mono"
              style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--fg-200)", padding: "8px 9px", borderRadius: 6, fontSize: 12 }}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="lobby label"
            />
          </label>
          <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
            <span className="kv__k">Ceremony id (hex)</span>
            <input
              className="mono"
              style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--fg-200)", padding: "8px 9px", borderRadius: 6, fontSize: 12 }}
              value={ceremonyIdInput}
              onChange={(event) => setCeremonyIdInput(event.target.value)}
              placeholder="paste the id the initiator shared"
              spellCheck={false}
            />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn--primary" disabled={joining || !ceremonyIdInput.trim()} onClick={handleJoinExisting}>
              {joining ? "Joining…" : "Join lobby"}
            </button>
            <button type="button" className="btn btn--ghost" disabled={joining} onClick={handleStartNew}>
              Start new ceremony
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* connection summary */}
          <div className="card card--padded" style={{ marginTop: 16, display: "grid", gap: 8 }}>
            <div className="cap">Lobby</div>
            <div className="kv">
              <span className="kv__k">Ceremony id</span>
              <span className="kv__v mono">{joined.cid}</span>
            </div>
            {selfInit ? (
              <div className="kv">
                <span className="kv__k">Your operator address</span>
                <span className="kv__v mono">{compactHex(selfInit.address_hex, 16, 10)}</span>
              </div>
            ) : null}
            {state.expiresMs !== null ? (
              <div className="kv">
                <span className="kv__k">Expires</span>
                <span className="kv__v mono" style={expired ? { color: "var(--err)" } : undefined}>
                  {formatCountdown(state.expiresMs, nowMs)}
                </span>
              </div>
            ) : null}
            <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <span className="kv__k">Dial lobby peers (libp2p multiaddrs)</span>
              <textarea
                value={dialAddrs}
                onChange={(event) => setDialAddrs(event.target.value)}
                placeholder="/ip4/…/tcp/…/p2p/… — one per line"
                spellCheck={false}
                style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--fg-200)", padding: "8px 9px", fontSize: 11, borderRadius: 6, fontFamily: "var(--font-mono, monospace)", minHeight: 56, resize: "vertical" }}
              />
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void handleDial()}>
                  Dial peers
                </button>
                {dialStatus ? <span style={{ fontSize: 11, color: "var(--fg-400)" }}>{dialStatus}</span> : null}
              </div>
            </label>
          </div>

          {/* propose (no proposal yet) */}
          {!state.proposeMsgId ? (
            <div className="card card--padded" style={{ marginTop: 16, display: "grid", gap: 10, maxWidth: 720 }}>
              <div className="cap">Propose this cluster</div>
              <p style={{ fontSize: 12, color: "var(--fg-300)", lineHeight: 1.5, margin: 0 }}>
                No proposal yet. The first valid proposal pins the seats, the terms, and the
                expiry for everyone in the lobby.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                  <span className="kv__k">Bond (LYTH)</span>
                  <input className="mono" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--fg-200)", padding: "8px 9px", borderRadius: 6, fontSize: 12 }} value={bondLyth} onChange={(event) => setBondLyth(event.target.value)} placeholder="5000" />
                </label>
                <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                  <span className="kv__k">Commission (bps)</span>
                  <input className="mono" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--fg-200)", padding: "8px 9px", borderRadius: 6, fontSize: 12 }} value={commissionBps} onChange={(event) => setCommissionBps(event.target.value)} placeholder="500" />
                </label>
                <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                  <span className="kv__k">Expiry (minutes)</span>
                  <input className="mono" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--fg-200)", padding: "8px 9px", borderRadius: 6, fontSize: 12 }} value={expiryMinutes} onChange={(event) => setExpiryMinutes(event.target.value)} placeholder="120" />
                </label>
              </div>
              <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                <span className="kv__k">Pin seats to operator ids (optional — 10 lines: 7 active then 3 standby)</span>
                <textarea
                  value={pinnedIds}
                  onChange={(event) => setPinnedIds(event.target.value)}
                  placeholder="0x… (leave empty for open seats)"
                  spellCheck={false}
                  style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--fg-200)", padding: "8px 9px", fontSize: 11, borderRadius: 6, fontFamily: "var(--font-mono, monospace)", minHeight: 88, resize: "vertical" }}
                />
              </label>

              {/* charter — V2 economic terms, folded into the signed digest */}
              <div
                style={{
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 8,
                  background: "rgba(255,255,255,0.02)",
                  padding: 12,
                  display: "grid",
                  gap: 10,
                }}
              >
                <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={withCharter}
                    onChange={(event) => setWithCharter(event.target.checked)}
                  />
                  <span className="cap">Charter — economic terms (V2)</span>
                </label>
                <span style={{ fontSize: 11, color: "var(--fg-400)", lineHeight: 1.45 }}>
                  With a charter, the per-seat reward shares, the delegator share, and the
                  consent expiry are folded INTO the consent digest every member signs — the
                  chain enforces them and a signature cannot be replayed under different terms.
                  Without one, the cluster gets the protocol defaults (equal split, 50%
                  delegators) via the V1 digest.
                </span>
                {withCharter ? (
                  <>
                    <div style={{ display: "grid", gap: 6 }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <span className="cap" style={{ fontSize: 10 }}>Per-seat shares (bps of the operator pot)</span>
                        <span
                          className={charterShareSum === FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS ? "halo halo--ok" : "halo halo--err"}
                          style={{ fontSize: 10.5 }}
                        >
                          <span className="dot" />
                          {Number.isNaN(charterShareSum) ? "invalid" : charterShareSum} / {FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS}
                          {charterShareSum === FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS ? "" : " — must sum to exactly 10000"}
                        </span>
                      </div>
                      {charterShares.map((value, index) => {
                        const bps = Number.parseInt(value.trim(), 10);
                        const pct = Number.isInteger(bps) && bps >= 0 ? bpsToPct(bps) : "—";
                        return (
                          <div key={`charter-share-${index}`} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <span className="kv__k" style={{ width: 86, flex: "0 0 auto" }}>
                              {charterSeatLabel(index)}
                            </span>
                            <input
                              className="mono"
                              inputMode="numeric"
                              value={value}
                              onChange={(event) => {
                                const next = [...charterShares];
                                next[index] = event.target.value;
                                setCharterShares(next);
                              }}
                              style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--fg-200)", padding: "6px 8px", borderRadius: 6, fontSize: 12, width: 90 }}
                            />
                            <span className="mono" style={{ fontSize: 11, color: "var(--fg-400)" }}>
                              = {pct}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                      <span className="kv__k">
                        Delegator share — {bpsToPct(charterDelegatorBps)} ({charterDelegatorBps} bps)
                      </span>
                      <input
                        type="range"
                        min={FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS}
                        max={FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS}
                        step={50}
                        value={charterDelegatorBps}
                        onChange={(event) => setCharterDelegatorBps(Number.parseInt(event.target.value, 10))}
                      />
                      <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
                        Protocol floor {bpsToPct(FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS, 0)} — a charter cannot starve delegators below it.
                      </span>
                    </label>
                    <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                      <span className="kv__k">Charter consent expiry (chain rejects execution after this moment)</span>
                      <input
                        type="datetime-local"
                        className="mono"
                        value={charterExpiryLocal}
                        onChange={(event) => setCharterExpiryLocal(event.target.value)}
                        style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--fg-200)", padding: "8px 9px", borderRadius: 6, fontSize: 12, maxWidth: 260 }}
                      />
                    </label>
                  </>
                ) : null}
              </div>

              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void handlePropose()} style={{ justifySelf: "start" }}>
                Publish proposal
              </button>
            </div>
          ) : (
            <>
              {/* terms — shown BEFORE signing */}
              <div style={{ marginTop: 16 }}>
                <TermsPanel state={state} nowMs={nowMs} />
              </div>

              {/* freeze banner */}
              {effectiveDigest ? (
                <div
                  className="card"
                  style={{
                    marginTop: 16,
                    padding: 16,
                    border: state.digestMismatch
                      ? "1px solid rgba(255,138,154,0.5)"
                      : "1px solid rgba(126,227,193,0.35)",
                    background: state.digestMismatch ? "rgba(255,138,154,0.05)" : "rgba(126,227,193,0.04)",
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="cap">
                      {state.frozenDigest ? "Frozen consent digest" : "Consent digest (live)"}
                    </span>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={copyDigest}>
                      Copy
                    </button>
                    {isInitiator && !state.frozenDigest && state.localDigest ? (
                      <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={handleFreeze}>
                        Freeze digest
                      </button>
                    ) : null}
                  </div>
                  <span className="mono" style={{ fontSize: 13, letterSpacing: "0.06em", wordBreak: "break-word" }}>
                    {formatDigestGroups(effectiveDigest)}
                  </span>
                  {state.digestMismatch ? (
                    <div className="halo halo--err" style={{ alignSelf: "flex-start", fontSize: 11 }}>
                      <span className="dot" /> The frozen digest does NOT match this client's local
                      recomputation. Do not sign, do not submit — the roster every client sees is not
                      the same.
                    </div>
                  ) : null}
                  <span style={{ fontSize: 11, color: "var(--fg-400)" }}>
                    Compare these groups out-of-band with the other operators before signing —
                    every client recomputes this digest from the claimed roster locally.
                  </span>
                </div>
              ) : (
                <div className="halo halo--warn" style={{ alignSelf: "flex-start", marginTop: 16 }}>
                  <span className="dot" /> Consent digest appears when all {FORM_CLUSTER_MEMBER_COUNT} seats are claimed.
                </div>
              )}

              {/* roster grid */}
              <div style={{ marginTop: 16 }}>
                <div className="cap" style={{ marginBottom: 8 }}>
                  Roster — {state.participants.length} of {FORM_CLUSTER_MEMBER_COUNT} seats claimed ·{" "}
                  {state.validConsentCount} of {FORM_CLUSTER_MEMBER_COUNT} consents verified
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }}>
                  {roster.map((row) => (
                    <SeatCard
                      key={`${row.seat.role}-${row.seat.index}`}
                      row={row}
                      isYou={
                        !!selfAddress &&
                        !!row.participant &&
                        normalizeHex(row.participant.address) === selfAddress
                      }
                      chainStatus={
                        row.participant ? seatChainStatuses[row.participant.operatorIdHex] ?? null : null
                      }
                      canClaim={!busy && !expired && !!selfInit}
                      onClaim={handleClaim}
                    />
                  ))}
                </div>
              </div>

              {/* sign / withdraw */}
              <div className="card card--padded" style={{ marginTop: 16, display: "grid", gap: 10 }}>
                <div className="cap">Your consent</div>
                {selfParticipant ? (
                  <>
                    <div className="kv">
                      <span className="kv__k">Your seat</span>
                      <span className="kv__v mono">
                        {selfParticipant.seat.role} {selfParticipant.seat.index + 1}
                      </span>
                    </div>
                    <div className="kv">
                      <span className="kv__k">Status</span>
                      <span className="kv__v">
                        {selfConsent
                          ? selfConsent.status === "valid"
                            ? "consent published and verified"
                            : `consent published but ${selfConsent.status.replace("-", " ")}`
                          : "not signed yet"}
                        {consentPublishedAt
                          ? " · published locally — gossip delivery is best-effort, re-send if peers report it missing"
                          : ""}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={busy || !rosterComplete || state.digestMismatch || expired || charterExpired}
                        onClick={() => void handleSign()}
                      >
                        {selfConsent ? "Re-sign current digest" : "Sign consent"}
                      </button>
                      {selfConsent ? (
                        <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void handleResendConsent()}>
                          Re-send consent
                        </button>
                      ) : null}
                      {!confirmWithdraw ? (
                        <button type="button" className="btn btn--danger" disabled={busy} onClick={() => setConfirmWithdraw(true)}>
                          Walk away
                        </button>
                      ) : (
                        <button type="button" className="btn btn--danger" disabled={busy} onClick={handleWithdraw}>
                          Confirm walk away
                        </button>
                      )}
                    </div>
                    {confirmWithdraw ? (
                      <div className="halo halo--warn" style={{ alignSelf: "flex-start", alignItems: "flex-start", lineHeight: 1.45, fontSize: 11 }}>
                        <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
                        <span>
                          {state.submitted
                            ? "formCluster was already submitted — your signature is on-chain and walking away here changes nothing."
                            : "Before submit, walking away frees your seat and your signature dies with any roster change (a new claimant shifts the digest, voiding every collected consent). But a consent signature is a bearer artifact: if the roster re-forms IDENTICALLY, a copy of your old signature would still verify. Walk-away is social, not cryptographic."}
                        </span>
                      </div>
                    ) : null}
                    {!rosterComplete ? (
                      <span style={{ fontSize: 11, color: "var(--fg-400)" }}>
                        Signing unlocks when all {FORM_CLUSTER_MEMBER_COUNT} seats are claimed — you
                        sign the exact roster and terms shown above, nothing else.
                      </span>
                    ) : null}
                    {charterExpired ? (
                      <span style={{ fontSize: 11, color: "var(--err)" }}>
                        The charter's consent expiry has passed — signing and submitting are
                        refused; propose a fresh ceremony.
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span style={{ fontSize: 12, color: "var(--fg-300)" }}>
                    Claim a seat above to take part. Your identity is your verified envelope key —
                    the registered operator consensus key.
                  </span>
                )}
              </div>

              {/* submit */}
              <div className="card card--padded" style={{ marginTop: 16, display: "grid", gap: 10 }}>
                <div className="cap">Submit formCluster</div>
                {state.submitted ? (
                  <div className="halo halo--ok" style={{ alignSelf: "flex-start" }}>
                    <span className="dot" /> submitted — tx {compactHex(state.submitted.txHash, 14, 10)}
                  </div>
                ) : (
                  <>
                    <div className={submitVerdict.allowed ? "halo halo--ok" : "halo halo--warn"} style={{ alignSelf: "flex-start", alignItems: "flex-start", lineHeight: 1.4, fontSize: 11.5 }}>
                      <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
                      <span>
                        {submitVerdict.allowed
                          ? "Ready: 10 verified consents over the agreed digest. Submitting opens the Operations drawer for preview and authorization."
                          : submitVerdict.reason}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={!submitVerdict.allowed || busy}
                      onClick={handleSubmit}
                      style={{ justifySelf: "start" }}
                    >
                      Review &amp; submit in Operations drawer
                    </button>
                    {!isActiveCeremonyMember(state, selfAddress) && state.ready ? (
                      <span style={{ fontSize: 11, color: "var(--fg-400)" }}>
                        The chain only accepts formCluster from an ACTIVE roster member — ask one of
                        the seven active operators to submit, or export the roster below and hand it
                        to them.
                      </span>
                    ) : null}
                  </>
                )}
                {isInitiator ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={handleSnapshot}>
                      Re-broadcast snapshot
                    </button>
                    <span style={{ fontSize: 11, color: "var(--fg-400)" }}>
                      late joiners only see messages sent while subscribed — re-broadcast after
                      someone joins late
                    </span>
                  </div>
                ) : null}
              </div>
            </>
          )}

          {/* export / import fallback */}
          <div className="card card--padded" style={{ marginTop: 16, display: "grid", gap: 10 }}>
            <div className="cap">Offline fallback — export / import</div>
            <p style={{ fontSize: 12, color: "var(--fg-300)", lineHeight: 1.5, margin: 0 }}>
              When the lobby cannot mesh, a ready ceremony can be exported as integrity-hashed
              JSON and handed to an active operator. Import validates every consent signature
              against the recomputed digest before anything is prefilled.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn btn--ghost btn--sm" disabled={!state.ready} onClick={handleExport}>
                Export ready ceremony
              </button>
            </div>
            {exportJson ? (
              <textarea
                readOnly
                value={exportJson}
                style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--fg-200)", padding: "8px 9px", fontSize: 10.5, borderRadius: 6, fontFamily: "var(--font-mono, monospace)", minHeight: 120, resize: "vertical" }}
              />
            ) : null}
            <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <span className="kv__k">Import ceremony JSON</span>
              <textarea
                value={importJsonText}
                onChange={(event) => setImportJsonText(event.target.value)}
                placeholder='{"schema":"monarch-desktop-ceremony-export/v1", …}'
                spellCheck={false}
                style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--fg-200)", padding: "8px 9px", fontSize: 10.5, borderRadius: 6, fontFamily: "var(--font-mono, monospace)", minHeight: 88, resize: "vertical" }}
              />
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" className="btn btn--ghost btn--sm" disabled={!importJsonText.trim()} onClick={handleImport}>
                Validate import
              </button>
              {imported ? (
                <>
                  <span className="halo halo--ok" style={{ fontSize: 10.5 }}>
                    <span className="dot" /> all 10 signatures verified · digest {compactHex(imported.consentDigestHex, 12, 8)}
                  </span>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={!importedSelfActive}
                    onClick={() => handleSubmitImported(imported.input, imported.consentDigestHex)}
                  >
                    Submit imported roster
                  </button>
                  {!importedSelfActive ? (
                    <span style={{ fontSize: 11, color: "var(--fg-400)" }}>
                      your operator key is not an ACTIVE seat in this roster — the chain would
                      reject your submit
                    </span>
                  ) : null}
                </>
              ) : null}
              {importError ? (
                <span className="halo halo--err" style={{ fontSize: 10.5 }}>
                  <span className="dot" /> {importError}
                </span>
              ) : null}
            </div>
          </div>

          {/* reducer warnings (diagnostics) */}
          {state.warnings.length > 0 ? (
            <details style={{ marginTop: 12 }}>
              <summary className="cap" style={{ cursor: "pointer" }}>
                lobby diagnostics ({state.warnings.length})
              </summary>
              <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
                {state.warnings.slice(-20).map((warning, index) => (
                  <span key={`${index}-${warning}`} className="mono" style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
                    {warning}
                  </span>
                ))}
              </div>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}
