// Charter management — the live-cluster charter AMENDMENT surface.
//
// A formed cluster's economics charter (per-seat operator shares +
// operator/delegator split) is not frozen. 7-of-10 of its CURRENTLY-ACTIVE
// members can consent to a new charter, which the chain applies only after
// a delegator-protective cooldown — the OLD terms stay in force until the
// effective epoch so an ARK delegator who dislikes the new split can
// undelegate first.
//
// This panel reuses the formation charter editor (`CharterEditor`), the
// shared share-model guardrails (`charterShare`), and the same
// consent-signing discipline as the Ceremony Room (the Rust signer
// re-derives the digest; the client cross-checks it and REFUSES on
// mismatch). It hands the assembled amendment to the existing Operations
// drawer (preview → auth → execute) via `requestOp`.
//
// Multi-operator consent: the local operator signs their own consent with
// the keychain key; consents from the other active members are pasted as
// `pubkey:signature` lines (the same offline hand-off the Ceremony Room
// uses). Each pasted consent is shape-checked and de-duplicated; the chain
// re-verifies every signature against the digest at execution.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CharterEditor } from "../components/CharterEditor";
import { useOps } from "../ops";
import { rpc } from "../sdk/client";
import { ceremonyChatInitialize } from "../sdk/ceremony";
import {
  CHARTER_COOLDOWN_EPOCHS,
  UPDATE_CHARTER_THRESHOLD,
  encodeCharterDraftHex,
  readActiveCharter,
  readPendingCharter,
  reduceCharterAmendment,
  signUpdateCharterConsent,
  updateCharterConsentDigestHex,
  FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS,
  FORM_CLUSTER_MEMBER_COUNT,
  type ActiveCharter,
  type CollectedCharterConsent,
  type PendingCharterView,
} from "../sdk/charterAmendmentOps";
import {
  CHARTER_DEFAULT_DELEGATOR_SHARE_BPS,
  bpsToPct,
  charterSeatLabel,
  defaultMemberShareStrings,
  memberShareStringsFrom,
  memberShareSumIsExact,
  validateCharterDraft,
  CharterDraftError,
} from "../sdk/charterShare";

const NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES = 1952;
const UPDATE_CHARTER_SIGNATURE_BYTES = 3309;

/** Approximate hours-per-epoch derived from the production cooldown
 *  (~24h over the cooldown epochs). The epoch COUNT is authoritative; the
 *  hours are a clearly-labelled estimate — the real landing is the
 *  on-chain `effectiveEpoch`. */
const APPROX_HOURS_PER_EPOCH = 24 / CHARTER_COOLDOWN_EPOCHS;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeHex(value: string): string {
  const clean = value.trim().replace(/^0x/iu, "").toLowerCase();
  return clean ? `0x${clean}` : "";
}

function compactHex(value: string, head = 10, tail = 8): string {
  if (!value || value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Parse pasted `pubkey:signature` (or whitespace-separated) consent
 *  lines into collected consents; silently drops blank lines. */
function parsePastedConsents(text: string): CollectedCharterConsent[] {
  const out: CollectedCharterConsent[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/[\s:,]+/u).filter(Boolean);
    if (parts.length < 2) continue;
    out.push({
      signerPubkeyHex: normalizeHex(parts[0] ?? ""),
      signatureHex: normalizeHex(parts[1] ?? ""),
    });
  }
  return out;
}

// ---- active / pending display ------------------------------------------

function CharterShareRows(props: { memberShareBps: readonly number[]; delegatorShareBps: number }) {
  return (
    <div style={{ display: "grid", gap: 5 }}>
      <div className="cap" style={{ fontSize: 10 }}>Per-seat operator-pot shares</div>
      {props.memberShareBps.map((bps, index) => (
        <div className="kv" key={`active-share-${index}`}>
          <span className="kv__k">{charterSeatLabel(index)}</span>
          <span className="kv__v mono">
            {bps} bps = {bpsToPct(bps)}
          </span>
        </div>
      ))}
      <div className="kv">
        <span className="kv__k">Delegator share</span>
        <span className="kv__v mono">
          {props.delegatorShareBps} bps = {bpsToPct(props.delegatorShareBps)}
        </span>
      </div>
    </div>
  );
}

// ---- main panel --------------------------------------------------------

export function CharterPanel(props: { clusterId: number; clusterLabel: string; currentEpoch: number | null }) {
  const { clusterId, currentEpoch } = props;
  const ops = useOps();

  const [active, setActive] = useState<ActiveCharter | null>(null);
  const [pending, setPending] = useState<PendingCharterView | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [readsLoaded, setReadsLoaded] = useState(false);

  // editor state
  const [memberShareRows, setMemberShareRows] = useState<string[]>(() =>
    defaultMemberShareStrings(),
  );
  const [delegatorShareBps, setDelegatorShareBps] = useState(CHARTER_DEFAULT_DELEGATOR_SHARE_BPS);
  const [seededFromActive, setSeededFromActive] = useState(false);

  // signing / collection state
  const [selfPubkeyHex, setSelfPubkeyHex] = useState<string | null>(null);
  const [proposedCharterHex, setProposedCharterHex] = useState<string | null>(null);
  const [consents, setConsents] = useState<CollectedCharterConsent[]>([]);
  const [pastedConsents, setPastedConsents] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Read the active + pending charter for the cluster.
  const refreshReads = useCallback(async () => {
    setReadError(null);
    try {
      const [activeCharter, pendingCharter] = await Promise.all([
        readActiveCharter(rpc, clusterId),
        readPendingCharter(rpc, clusterId).catch(() => null),
      ]);
      if (!aliveRef.current) return;
      setActive(activeCharter);
      setPending(pendingCharter);
      setReadsLoaded(true);
    } catch (err) {
      if (!aliveRef.current) return;
      setReadError(errText(err));
      setReadsLoaded(true);
    }
  }, [clusterId]);

  useEffect(() => {
    setReadsLoaded(false);
    setActive(null);
    setPending(null);
    setSeededFromActive(false);
    void refreshReads();
  }, [refreshReads]);

  // Seed the editor from the active charter once, so a proposal starts
  // from the current terms (operators usually tweak, not rewrite).
  useEffect(() => {
    if (seededFromActive || !readsLoaded) return;
    if (active) {
      setMemberShareRows(memberShareStringsFrom(active.memberShareBps));
      setDelegatorShareBps(active.delegatorShareBps);
    }
    setSeededFromActive(true);
  }, [active, readsLoaded, seededFromActive]);

  const pendingActive = pending?.present ?? false;
  const cooldownEpochsLeft =
    pendingActive && currentEpoch !== null
      ? Math.max(0, Number(pending!.effectiveEpoch) - currentEpoch)
      : null;
  const cooldownHoursLeft =
    cooldownEpochsLeft !== null ? Math.round(cooldownEpochsLeft * APPROX_HOURS_PER_EPOCH) : null;

  const draftValid = useMemo(() => {
    try {
      validateCharterDraft({ memberShareRows, delegatorShareBps });
      return true;
    } catch {
      return false;
    }
  }, [memberShareRows, delegatorShareBps]);

  // Live consent readiness over the local + pasted consents.
  const collectedConsents = useMemo(
    () => [...consents, ...parsePastedConsents(pastedConsents)],
    [consents, pastedConsents],
  );
  const readiness = useMemo(() => reduceCharterAmendment(collectedConsents), [collectedConsents]);
  const selfSigned = useMemo(
    () =>
      selfPubkeyHex
        ? collectedConsents.some((c) => normalizeHex(c.signerPubkeyHex) === normalizeHex(selfPubkeyHex))
        : false,
    [collectedConsents, selfPubkeyHex],
  );

  // ---- handlers --------------------------------------------------------

  /** Propose: encode + pin the charter draft, then derive the digest the
   *  members will sign. A new propose resets any collected consents. */
  const handleStartProposal = useCallback(() => {
    setError(null);
    setNotice(null);
    try {
      const charterHex = encodeCharterDraftHex({ memberShareRows, delegatorShareBps });
      setProposedCharterHex(charterHex);
      setConsents([]);
      setPastedConsents("");
      setNotice(
        "Charter pinned. Now collect 7 active-member consent signatures over the digest below — sign yours, and gather the rest from the other active operators.",
      );
    } catch (err) {
      setError(err instanceof CharterDraftError ? `Charter: ${err.message}` : errText(err));
    }
  }, [memberShareRows, delegatorShareBps]);

  const proposedDigestHex = useMemo(
    () => (proposedCharterHex ? updateCharterConsentDigestHex(clusterId, proposedCharterHex) : null),
    [proposedCharterHex, clusterId],
  );

  /** Sign the local operator's consent (Rust re-derives + signs the
   *  digest; we cross-check the returned digest and REFUSE on mismatch —
   *  same discipline as the Ceremony Room). */
  const handleSignSelf = useCallback(async () => {
    if (!proposedCharterHex || !proposedDigestHex) return;
    setBusy(true);
    setError(null);
    try {
      const init = await ceremonyChatInitialize({ rpcEndpoint: rpc.endpoint });
      const pubkeyHex = init ? normalizeHex(init.public_key_hex) : null;
      if (!pubkeyHex) {
        setError(
          "Operator key is not stored yet — add your operator PQM-1 key in Keys before signing a charter change.",
        );
        return;
      }
      setSelfPubkeyHex(pubkeyHex);
      const signed = await signUpdateCharterConsent({ clusterId, charterHex: proposedCharterHex });
      if (normalizeHex(signed.digest_hex) !== normalizeHex(proposedDigestHex)) {
        setError(
          "Signer returned a different consent digest than this client recomputed — refusing to record the signature. Do not proceed until the digest matches.",
        );
        return;
      }
      setConsents((prev) => {
        const next = prev.filter((c) => normalizeHex(c.signerPubkeyHex) !== pubkeyHex);
        next.push({ signerPubkeyHex: pubkeyHex, signatureHex: normalizeHex(signed.signature_hex) });
        return next;
      });
      setNotice("Your consent is recorded. Collect the rest of the 7 active-member consents.");
    } catch (err) {
      setError(errText(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [proposedCharterHex, proposedDigestHex, clusterId]);

  /** Hand the assembled amendment to the Operations drawer. */
  const handleSubmit = useCallback(() => {
    if (!proposedCharterHex || !proposedDigestHex) return;
    if (!readiness.ready) {
      setError(readiness.reason ?? "Not enough consents yet.");
      return;
    }
    const draft = validateCharterDraft({ memberShareRows, delegatorShareBps });
    const effectiveLabel =
      currentEpoch !== null ? `epoch ${currentEpoch + CHARTER_COOLDOWN_EPOCHS}` : "after the cooldown";
    ops.requestOp({
      kind: "cluster-update-charter",
      title: "Amend cluster charter",
      sub: `updateCharter — cluster ${clusterId}`,
      intro:
        "Submits updateCharter(uint32,bytes,bytes,bytes) for this cluster with the collected active-member consents. The chain enforces the 7-of-10 active-member threshold and applies the new economics only AFTER the delegator-protective cooldown — the current terms stay in force until the effective epoch, so delegators can exit first.",
      technical: `Consent digest ${proposedDigestHex} (domain PROTOCORE_NODE_REGISTRY_CLUSTER_UPDATE_CHARTER_V1). Cooldown ${CHARTER_COOLDOWN_EPOCHS} epochs — new terms land no earlier than ${effectiveLabel}.`,
      icon: "UC",
      risk: "high",
      destructive: true,
      needsPasskey: true,
      confirmLabel: "Sign charter amendment",
      effects: [
        `Encodes the new 30-byte charter: delegators ${bpsToPct(draft.delegatorShareBps)}, operator pot split across the ten seats.`,
        `Carries ${readiness.signatureCount} active-member ML-DSA-65 consents (threshold ${UPDATE_CHARTER_THRESHOLD}-of-${FORM_CLUSTER_MEMBER_COUNT}); every signature verifies over the recomputed digest.`,
        "The chain applies the new terms only after the cooldown — the current terms apply until then, so delegators can undelegate first.",
      ],
      diff: [
        { key: "cluster", label: "Cluster", value: props.clusterLabel },
        {
          key: "delegators",
          label: "Delegator share",
          value: `${active ? bpsToPct(active.delegatorShareBps) : "default"} → ${bpsToPct(draft.delegatorShareBps)}`,
        },
        { key: "effective", label: "Effective", value: effectiveLabel },
        { key: "digest", label: "Consent digest", value: proposedDigestHex },
      ],
      fields: [
        { key: "cluster", label: "Cluster id", value: String(clusterId) },
        { key: "consents", label: "Consents", value: `${readiness.signatureCount} of ${UPDATE_CHARTER_THRESHOLD}` },
        { key: "executor", label: "Executor", value: "updateCharter(uint32,bytes,bytes,bytes)" },
      ],
      clusterUpdateCharterInput: {
        clusterId: String(clusterId),
        charterHex: proposedCharterHex,
        signerPubkeysHex: readiness.signerPubkeysHex,
        signaturesHex: readiness.signaturesHex,
      },
    });
  }, [
    proposedCharterHex,
    proposedDigestHex,
    readiness,
    memberShareRows,
    delegatorShareBps,
    currentEpoch,
    clusterId,
    active,
    ops,
    props.clusterLabel,
  ]);

  const handleResetProposal = useCallback(() => {
    setProposedCharterHex(null);
    setConsents([]);
    setPastedConsents("");
    setNotice(null);
    setError(null);
  }, []);

  // ---- render ----------------------------------------------------------

  return (
    <div className="card card--padded" style={{ display: "grid", gap: 16 }}>
      <div className="card__head" style={{ padding: 0 }}>
        <div>
          <h3>Charter management</h3>
          <div className="sub">
            per-operator shares + operator/delegator split · {UPDATE_CHARTER_THRESHOLD}-of-
            {FORM_CLUSTER_MEMBER_COUNT} active-member consent · {CHARTER_COOLDOWN_EPOCHS}-epoch notice
          </div>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void refreshReads()}>
          Refresh
        </button>
      </div>

      <p style={{ fontSize: 12, color: "var(--fg-300)", lineHeight: 1.5, margin: 0 }}>
        The charter decides how this cluster's block rewards are shared: a slice goes to the
        delegators who staked behind it (the delegator share), and the rest — the operator pot — is
        split across the ten operator seats. A change is NOT instant: it needs {UPDATE_CHARTER_THRESHOLD}{" "}
        of the currently-active operators to sign, and then a {CHARTER_COOLDOWN_EPOCHS}-epoch notice
        period passes before it takes effect, so delegators who don't like the new terms can leave first.
      </p>

      {readError ? (
        <div className="halo halo--warn" style={{ alignSelf: "flex-start", alignItems: "flex-start", lineHeight: 1.4 }}>
          <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
          <span>Charter read unavailable on this endpoint: {readError}</span>
        </div>
      ) : null}

      {/* ACTIVE charter */}
      <div
        style={{
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 8,
          background: "rgba(255,255,255,0.02)",
          padding: 12,
          display: "grid",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="cap">Current terms (in force now)</span>
          <span className="halo halo--ok" style={{ fontSize: 10 }}>
            <span className="dot" /> active
          </span>
        </div>
        {!readsLoaded ? (
          <span style={{ fontSize: 12, color: "var(--fg-400)" }}>loading…</span>
        ) : active ? (
          <CharterShareRows memberShareBps={active.memberShareBps} delegatorShareBps={active.delegatorShareBps} />
        ) : (
          <span style={{ fontSize: 12, color: "var(--fg-400)" }}>
            This cluster runs the protocol-default split (no charter set): equal member shares, 50%
            to delegators.
          </span>
        )}
      </div>

      {/* PENDING amendment + cooldown countdown */}
      {pendingActive && pending ? (
        <div
          style={{
            border: "1px solid rgba(242,180,65,0.45)",
            borderRadius: 8,
            background: "rgba(242,180,65,0.06)",
            padding: 12,
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="cap">Pending change</span>
            <span className="halo halo--gold" style={{ fontSize: 10 }}>
              <span className="dot" />
              {cooldownEpochsLeft !== null && cooldownEpochsLeft > 0
                ? `new terms in ~${cooldownHoursLeft}h`
                : "ready to apply"}
            </span>
          </div>
          <div className="kv">
            <span className="kv__k">Takes effect</span>
            <span className="kv__v mono">
              epoch {pending.effectiveEpoch.toString()}
              {cooldownEpochsLeft !== null
                ? ` · ${cooldownEpochsLeft} epoch${cooldownEpochsLeft === 1 ? "" : "s"} away (~${cooldownHoursLeft}h, estimate)`
                : ""}
            </span>
          </div>
          <div className="kv">
            <span className="kv__k">Recorded consents</span>
            <span className="kv__v mono">{pending.signerCount}</span>
          </div>
          <CharterShareRows memberShareBps={pending.memberShareBps} delegatorShareBps={pending.delegatorShareBps} />
          <div className="halo halo--warn" style={{ alignSelf: "flex-start", alignItems: "flex-start", lineHeight: 1.45, fontSize: 11 }}>
            <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
            <span>
              These NEW terms are not in force yet. The current terms above apply until the effective
              epoch — a delegator who dislikes the new split can undelegate during this window.
            </span>
          </div>
        </div>
      ) : null}

      {/* EDIT + PROPOSE */}
      {!proposedCharterHex ? (
        <div style={{ display: "grid", gap: 12 }}>
          <div className="cap">Propose a charter change</div>
          {pendingActive ? (
            <div className="halo halo--warn" style={{ alignSelf: "flex-start", alignItems: "flex-start", lineHeight: 1.45, fontSize: 11 }}>
              <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
              <span>
                A change is already pending for this cluster. Only one charter change can be in flight
                at a time — wait for the pending one to take effect (or be superseded) before
                proposing another.
              </span>
            </div>
          ) : null}
          <CharterEditor
            memberShareRows={memberShareRows}
            onMemberShareChange={(index, value) => {
              const next = [...memberShareRows];
              next[index] = value;
              setMemberShareRows(next);
            }}
            delegatorShareBps={delegatorShareBps}
            onDelegatorShareChange={setDelegatorShareBps}
            disabled={pendingActive}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={pendingActive || !draftValid || !memberShareSumIsExact(memberShareRows) || delegatorShareBps < FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS}
            onClick={handleStartProposal}
            style={{ justifySelf: "start" }}
          >
            Propose charter change
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="cap">Collect consents</span>
            <span
              className={readiness.ready ? "halo halo--ok" : "halo halo--warn"}
              style={{ fontSize: 10.5 }}
            >
              <span className="dot" />
              {readiness.signatureCount} of {UPDATE_CHARTER_THRESHOLD} active-member consents
            </span>
          </div>

          {proposedDigestHex ? (
            <div
              className="card"
              style={{
                padding: 12,
                border: "1px solid rgba(126,227,193,0.35)",
                background: "rgba(126,227,193,0.04)",
                display: "grid",
                gap: 6,
              }}
            >
              <span className="cap" style={{ fontSize: 10 }}>Consent digest (every signer signs THIS)</span>
              <span className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                {proposedDigestHex}
              </span>
              <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
                Compare this digest out-of-band with the other active operators before signing — each
                client recomputes it from the cluster id and charter bytes locally.
              </span>
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || selfSigned}
              onClick={() => void handleSignSelf()}
            >
              {selfSigned ? "Your consent recorded" : "Sign my consent"}
            </button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={handleResetProposal}>
              Discard proposal
            </button>
          </div>

          <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
            <span className="kv__k">
              Paste other active members' consents (one per line — `pubkey signature`)
            </span>
            <textarea
              value={pastedConsents}
              onChange={(event) => setPastedConsents(event.target.value)}
              placeholder="0x<1952-byte pubkey> 0x<3309-byte signature>"
              spellCheck={false}
              style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--fg-200)", padding: "8px 9px", fontSize: 10.5, borderRadius: 6, fontFamily: "var(--font-mono, monospace)", minHeight: 88, resize: "vertical" }}
            />
            <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
              Only currently-active members can consent. Each line must be a {NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES}-byte
              consensus pubkey and a {UPDATE_CHARTER_SIGNATURE_BYTES}-byte ML-DSA-65 signature over the digest
              above; malformed or duplicate lines are ignored, and the chain re-verifies every
              signature at execution.
            </span>
          </label>

          {/* collected roster */}
          {readiness.signerPubkeysHex.length > 0 ? (
            <div style={{ display: "grid", gap: 4 }}>
              {readiness.signerPubkeysHex.map((pubkey) => (
                <div className="kv" key={pubkey}>
                  <span className="kv__k mono" style={{ fontSize: 10.5 }}>{compactHex(pubkey)}</span>
                  <span className="halo halo--ok" style={{ fontSize: 10 }}>
                    <span className="dot" />
                    {normalizeHex(pubkey) === normalizeHex(selfPubkeyHex ?? "") ? "you" : "consent"}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          <button
            type="button"
            className="btn btn--primary"
            disabled={!readiness.ready}
            onClick={handleSubmit}
            style={{ justifySelf: "start" }}
          >
            Review &amp; submit in Operations drawer
          </button>
          {!readiness.ready ? (
            <span style={{ fontSize: 11, color: "var(--fg-400)" }}>
              {readiness.reason}
            </span>
          ) : (
            <div className="halo halo--info" style={{ alignSelf: "flex-start", alignItems: "flex-start", lineHeight: 1.45, fontSize: 11 }}>
              <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
              <span>
                Once submitted, the change is PENDING — it takes effect after the{" "}
                {CHARTER_COOLDOWN_EPOCHS}-epoch notice period
                {currentEpoch !== null ? ` (around epoch ${currentEpoch + CHARTER_COOLDOWN_EPOCHS})` : ""}. The current terms apply until then, so delegators can exit first.
              </span>
            </div>
          )}
        </div>
      )}

      {notice ? (
        <div className="halo halo--info" style={{ alignSelf: "flex-start", alignItems: "flex-start", lineHeight: 1.4, fontSize: 11 }}>
          <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
          <span>{notice}</span>
        </div>
      ) : null}
      {error ? (
        <div className="halo halo--err" style={{ alignSelf: "flex-start", alignItems: "flex-start", lineHeight: 1.4, fontSize: 11 }}>
          <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
