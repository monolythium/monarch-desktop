// Cluster charter panel. Shows current reward terms and guides a guarded
// amendment flow: draft terms, collect active-member consents, then hand off
// to Operations for review and signing.

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
  FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS,
  bpsToPct,
  charterSeatLabel,
  defaultMemberShareStrings,
  memberShareStringsFrom,
  memberShareSumIsExact,
  validateCharterDraft,
  CharterDraftError,
} from "../sdk/charterShare";

/** Approximate hours-per-epoch derived from the production cooldown
 *  (~24h over the cooldown epochs). The epoch COUNT is authoritative; the
 *  hours are a clearly-labelled estimate — the real landing is the
 *  on-chain `effectiveEpoch`. */
const APPROX_HOURS_PER_EPOCH = 24 / CHARTER_COOLDOWN_EPOCHS;
const DEFAULT_MEMBER_SHARE_BPS = defaultMemberShareStrings().map((value) =>
  Number.parseInt(value, 10),
);

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
    <div className="charter-share-grid">
      {props.memberShareBps.map((bps, index) => (
        <span className="charter-share-chip" key={`active-share-${index}`}>
          <b>{charterSeatLabel(index)}</b>
          <span>{bpsToPct(bps)}</span>
        </span>
      ))}
      <span className="charter-share-chip charter-share-chip--delegator">
        <b>Delegators</b>
        <span>{bpsToPct(props.delegatorShareBps)}</span>
      </span>
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
  const [editorOpen, setEditorOpen] = useState(false);

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
    setEditorOpen(false);
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
  const activeDelegatorBps = active?.delegatorShareBps ?? CHARTER_DEFAULT_DELEGATOR_SHARE_BPS;
  const activeOperatorPotBps = FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS - activeDelegatorBps;
  const activeMemberShares = active?.memberShareBps ?? DEFAULT_MEMBER_SHARE_BPS;
  const activeTermsLabel = active ? "custom terms" : "protocol default";

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
      setEditorOpen(false);
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
          "Operator key is not stored yet — add your operator key in Keys before signing a charter change.",
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
    setEditorOpen(false);
  }, []);

  // ---- render ----------------------------------------------------------

  return (
    <div className="card card--padded charter-panel">
      <div className="charter-panel__head">
        <div>
          <div className="cap">cluster charter</div>
          <h3>Reward terms</h3>
          <p>
            Current reward split, pending changes, and guarded amendments for {props.clusterLabel}.
          </p>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void refreshReads()}>
          Refresh
        </button>
      </div>

      <div className="charter-summary">
        <div className="charter-term">
          <span>Delegators</span>
          <b>{readsLoaded ? bpsToPct(activeDelegatorBps) : "—"}</b>
          <small>{activeTermsLabel}</small>
        </div>
        <div className="charter-term">
          <span>Operator pot</span>
          <b>{readsLoaded ? bpsToPct(activeOperatorPotBps) : "—"}</b>
          <small>split across {FORM_CLUSTER_MEMBER_COUNT} seats</small>
        </div>
        <div className="charter-term">
          <span>Change approval</span>
          <b>{UPDATE_CHARTER_THRESHOLD}/{FORM_CLUSTER_MEMBER_COUNT}</b>
          <small>{CHARTER_COOLDOWN_EPOCHS}-epoch notice</small>
        </div>
      </div>

      {readError ? (
        <div className="halo halo--warn charter-inline-alert">
          <span className="dot" />
          <span>Could not read charter terms: {readError}</span>
        </div>
      ) : null}

      <details className="charter-details">
        <summary>
          <span>Seat-share detail</span>
          <small>{readsLoaded ? activeTermsLabel : "loading"}</small>
        </summary>
        {!readsLoaded ? (
          <span className="charter-muted">Loading charter terms…</span>
        ) : (
          <CharterShareRows
            memberShareBps={activeMemberShares}
            delegatorShareBps={activeDelegatorBps}
          />
        )}
      </details>

      {pendingActive && pending ? (
        <div className="charter-pending">
          <div>
            <div className="cap">pending change</div>
            <strong>
              Delegators {bpsToPct(pending.delegatorShareBps)} · effective epoch{" "}
              {pending.effectiveEpoch.toString()}
            </strong>
            <span>
              {cooldownEpochsLeft !== null && cooldownEpochsLeft > 0
                ? `${cooldownEpochsLeft} epoch${cooldownEpochsLeft === 1 ? "" : "s"} remaining (~${cooldownHoursLeft}h estimate)`
                : "ready to apply"}
            </span>
          </div>
          <span className="halo halo--gold">
            <span className="dot" /> {pending.signerCount} consents
          </span>
          <details className="charter-details charter-details--nested">
            <summary>
              <span>Pending seat shares</span>
              <small>not in force yet</small>
            </summary>
            <CharterShareRows
              memberShareBps={pending.memberShareBps}
              delegatorShareBps={pending.delegatorShareBps}
            />
          </details>
        </div>
      ) : null}

      <div className="charter-proposal">
        {!proposedCharterHex ? (
          <>
            <div className="charter-proposal__head">
              <div>
                <h4>Change reward terms</h4>
                <p>
                  Draft a new split, collect active-member consents, then review it in Operations.
                </p>
              </div>
              {!editorOpen ? (
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={pendingActive}
                  onClick={() => setEditorOpen(true)}
                >
                  Change terms
                </button>
              ) : null}
            </div>
            {pendingActive ? (
              <div className="halo halo--warn charter-inline-alert">
                <span className="dot" />
                <span>A charter change is already pending. Wait for it to clear before proposing another.</span>
              </div>
            ) : null}
            {editorOpen ? (
              <div className="charter-editor-shell">
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
                <div className="charter-actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={pendingActive || !draftValid || !memberShareSumIsExact(memberShareRows) || delegatorShareBps < FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS}
                    onClick={handleStartProposal}
                  >
                    Start consent collection
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setEditorOpen(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="charter-consent-flow">
            <div className="charter-proposal__head">
              <div>
                <h4>Collect consents</h4>
                <p>Need {UPDATE_CHARTER_THRESHOLD} active members over the same digest.</p>
              </div>
              <span className={readiness.ready ? "halo halo--ok" : "halo halo--warn"}>
                <span className="dot" />
                {readiness.signatureCount}/{UPDATE_CHARTER_THRESHOLD}
              </span>
            </div>

            {proposedDigestHex ? (
              <details className="charter-details" open>
                <summary>
                  <span>Digest to sign</span>
                  <small>share exactly</small>
                </summary>
                <code className="charter-digest">{proposedDigestHex}</code>
                <span className="charter-muted">
                  Each operator should compare this digest before signing.
                </span>
              </details>
            ) : null}

            <div className="charter-actions">
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

            <label className="charter-consent-input">
              <span>Other active-member consents</span>
              <textarea
                value={pastedConsents}
                onChange={(event) => setPastedConsents(event.target.value)}
                placeholder="0x<1952-byte pubkey> 0x<3309-byte signature>"
                spellCheck={false}
              />
              <small>
                One line per member: consensus pubkey, then ML-DSA-65 signature.
              </small>
            </label>

            {readiness.signerPubkeysHex.length > 0 ? (
              <div className="charter-consent-list">
                {readiness.signerPubkeysHex.map((pubkey) => (
                  <span className="charter-consent-chip" key={pubkey}>
                    <b>{compactHex(pubkey)}</b>
                    <small>
                      {normalizeHex(pubkey) === normalizeHex(selfPubkeyHex ?? "") ? "you" : "consent"}
                    </small>
                  </span>
                ))}
              </div>
            ) : null}

            <div className="charter-actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={!readiness.ready}
                onClick={handleSubmit}
              >
                Review in Operations
              </button>
              {!readiness.ready ? (
                <span className="charter-muted">{readiness.reason}</span>
              ) : (
                <span className="charter-muted">
                  Takes effect after the {CHARTER_COOLDOWN_EPOCHS}-epoch notice
                  {currentEpoch !== null ? ` around epoch ${currentEpoch + CHARTER_COOLDOWN_EPOCHS}` : ""}.
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {notice ? (
        <div className="halo halo--info charter-inline-alert">
          <span className="dot" />
          <span>{notice}</span>
        </div>
      ) : null}
      {error ? (
        <div className="halo halo--err charter-inline-alert">
          <span className="dot" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
