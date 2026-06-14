// Operations drawer — the right-side approval flow for operator actions.
// Preconditions, live diffs, typed confirmations, and error translation are
// handled here so every action follows the same review-before-run path.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useOps } from "./OpsContext";
import {
  ChatBootstrapPeersForm,
  isChatBootstrapPeersInputComplete,
} from "./ChatBootstrapPeersForm";
import {
  ClusterPendingChangeForm,
  isPendingChangeInputComplete,
} from "./ClusterPendingChangeForm";
import {
  ClusterFormProposalForm,
  isClusterFormInputComplete,
} from "./ClusterFormProposalForm";
import { ClusterNameForm, isClusterNameInputComplete } from "./ClusterNameForm";
import {
  ClusterJoinRequestForm,
  ClusterVoteAdmitForm,
  isClusterJoinRequestInputComplete,
  isClusterVoteAdmitInputComplete,
} from "./ClusterJoinForms";
import {
  ClusterResignationForm,
  isClusterResignationInputComplete,
} from "./ClusterResignationForm";
import {
  DkgReshareAttestationForm,
  isDkgReshareAttestationInputComplete,
} from "./DkgReshareAttestationForm";
import {
  EmergencyKeyRotationForm,
  FreezeAdmissionForm,
  isEmergencyKeyRotationInputComplete,
  isFreezeAdmissionInputComplete,
} from "./IncidentExecutorForm";
import { isOtaApplyInputComplete, OtaApplyForm } from "./OtaApplyForm";
import {
  isOperatorDisplayInputComplete,
  OperatorDisplayForm,
} from "./OperatorDisplayForm";
import {
  isOperatorSealKeyInputComplete,
  OperatorSealKeyForm,
} from "./OperatorSealKeyForm";
import { isRegisterInputComplete, RegisterForm } from "./RegisterForm";
import { isRedelegateInputComplete, RedelegateForm } from "./RedelegateForm";
import { isRestoreInputComplete, RestoreForm } from "./RestoreForm";
import { OP_CATALOG } from "./catalog";
import { translateOpError } from "./errors";
import { liveDiffRows } from "./liveDiff";
import {
  buildPreflightRows,
  collectPreflightProbes,
  preflightBlocked,
  preflightNeeds,
  type PreflightProbes,
  type PreflightRow,
} from "./preflight";
import type { OpKind, OpRequest, OpStage } from "./types";
import { matchSelfMember, useSelfOperator } from "../hooks/useSelfOperator";
import { DEFAULT_ACTIVE_CLUSTER_ID } from "../sdk/clusterModel";
import { useClusterStatus } from "../sdk/hooks";

const STAGE_LABEL: Record<OpStage, string> = {
  preview: "Preview",
  auth: "Authorize",
  executing: "Executing",
  done: "Done",
  error: "Error",
};

const STAGE_ORDER: OpStage[] = ["preview", "auth", "executing", "done"];

/** Irreversible verbs that require typing the word to confirm. */
export const TYPED_CONFIRMATION: Partial<Record<OpKind, string>> = {
  "cluster-resign": "RESIGN",
  "operator-stop": "STOP",
  "freeze-admission": "FREEZE",
  "emergency-key-rotation": "ROTATE",
  "ota-rollback": "ROLLBACK",
};

function stageClass(target: OpStage, current: OpStage): string {
  if (target === current) return "drawer__step drawer__step--active";
  if (
    STAGE_ORDER.indexOf(target) < STAGE_ORDER.indexOf(current) ||
    current === "done"
  ) {
    return "drawer__step drawer__step--done";
  }
  return "drawer__step";
}

function requestNeedsPreflight(kind: OpKind): boolean {
  const needs = preflightNeeds(kind);
  return (
    needs.operatorKey ||
    needs.foundationKey ||
    needs.registration ||
    needs.balance ||
    needs.sealEk ||
    needs.service
  );
}

function usePreflight(
  request: OpRequest | null,
  open: boolean,
  stage: OpStage,
): { rows: PreflightRow[]; checking: boolean; blocked: boolean } {
  const kind = request?.kind ?? null;
  const [probes, setProbes] = useState<PreflightProbes | null>(null);

  useEffect(() => {
    setProbes(null);
    if (!open || !kind || !requestNeedsPreflight(kind)) return;
    let cancelled = false;
    void collectPreflightProbes(kind).then((collected) => {
      if (!cancelled) setProbes(collected);
    });
    return () => {
      cancelled = true;
    };
  }, [open, kind]);

  return useMemo(() => {
    if (!request || !kind || !requestNeedsPreflight(kind)) {
      return { rows: [], checking: false, blocked: false };
    }
    if (!probes) return { rows: [], checking: true, blocked: false };
    const rows = buildPreflightRows(request, probes);
    return {
      rows,
      checking: false,
      blocked: stage === "preview" || stage === "auth" ? preflightBlocked(rows) : false,
    };
  }, [request, kind, probes, stage]);
}

function PreflightStrip({
  rows,
  checking,
}: {
  rows: PreflightRow[];
  checking: boolean;
}) {
  const navigate = useNavigate();
  const { cancel } = useOps();

  if (checking) {
    return (
      <div className="card" style={{ background: "rgba(255,255,255,0.02)" }}>
        <div className="cap" style={{ marginBottom: 6 }}>preflight checks</div>
        <div className="halo halo--info" style={{ alignSelf: "flex-start" }}>
          <span className="dot dot--pulse" /> Checking preconditions…
        </div>
      </div>
    );
  }
  if (rows.length === 0) return null;

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)" }}>
      <div className="cap" style={{ marginBottom: 6 }}>preflight checks</div>
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((row) => (
          <div
            key={row.id}
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr auto",
              gap: 10,
              alignItems: "center",
            }}
          >
            <span
              className={
                row.status === "ok"
                  ? "halo halo--ok"
                  : row.status === "fail"
                    ? "halo halo--err"
                    : "halo halo--warn"
              }
            >
              <span className="dot" />
              {row.status === "ok" ? "ok" : row.status === "fail" ? "blocked" : "unknown"}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: "var(--fg-100)" }}>{row.label}</div>
              <div style={{ fontSize: 11, color: "var(--fg-400)", overflowWrap: "anywhere" }}>
                {row.detail}
              </div>
            </div>
            {row.fixRoute ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  cancel();
                  navigate(row.fixRoute as string);
                }}
              >
                {row.fixLabel ?? "Fix"}
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Live quorum-impact line for service stop/restart verbs. */
function QuorumImpact({ kind }: { kind: OpKind }) {
  const self = useSelfOperator();
  const cluster = useClusterStatus(self.clusterId ?? DEFAULT_ACTIVE_CLUSTER_ID);
  const data = cluster.data;
  if (kind !== "operator-stop" && kind !== "operator-restart") return null;
  if (!data) {
    return (
      <div className="halo halo--warn" style={{ alignSelf: "flex-start" }}>
        <span className="dot" /> Cluster status is unavailable — verify quorum impact manually before
        taking your node offline.
      </div>
    );
  }
  const live = data.members.filter((member) => member.state !== "jail").length;
  const selfSeat = matchSelfMember(data.members, self.operatorId);
  const counted = selfSeat !== null;
  const after = Math.max(live - 1, 0);
  const holds = after >= data.threshold;
  const verb = kind === "operator-stop" ? "Stopping" : "Restarting";
  return (
    <div
      className={holds ? "halo halo--ok" : "halo halo--err"}
      style={{ alignSelf: "flex-start", whiteSpace: "normal", lineHeight: 1.4 }}
    >
      <span className="dot" />
      <span>
        {verb} leaves {after} of {data.size} operators live (threshold {data.threshold}) — quorum{" "}
        {holds ? "holds" : "AT RISK"}
        {counted ? "" : " · note: your seat was not matched in this cluster, so the impact is an estimate"}
        .
      </span>
    </div>
  );
}

export function OperationsDrawer() {
  const { open, stage, request, result, advance, cancel } = useOps();
  const navigate = useNavigate();
  const self = useSelfOperator();
  const preflight = usePreflight(request, open, stage);
  const [confirmText, setConfirmText] = useState("");
  const [copiedFundingAddress, setCopiedFundingAddress] = useState(false);
  const fundingCopyTimer = useRef<number | null>(null);

  // Reset typed confirmation whenever the verb or stage changes.
  const requestKind = request?.kind ?? null;
  useEffect(() => {
    setConfirmText("");
    setCopiedFundingAddress(false);
  }, [requestKind, stage, open]);

  useEffect(
    () => () => {
      if (fundingCopyTimer.current !== null) window.clearTimeout(fundingCopyTimer.current);
    },
    [],
  );

  const typedWord = requestKind ? TYPED_CONFIRMATION[requestKind] : undefined;
  const typedBlocked =
    stage === "auth" && !!typedWord && confirmText.trim().toUpperCase() !== typedWord;
  const registerNeedsInput =
    request?.kind === "operator-register" &&
    stage === "preview" &&
    !isRegisterInputComplete(request.registerInput);
  const redelegateNeedsInput =
    request?.kind === "redelegate" &&
    stage === "preview" &&
    !isRedelegateInputComplete(request.redelegateInput);
  const chatBootstrapPeersNeedsInput =
    request?.kind === "chat-bootstrap-peers" &&
    stage === "preview" &&
    !isChatBootstrapPeersInputComplete(request.chatBootstrapPeersInput);
  const operatorDisplayNeedsInput =
    request?.kind === "operator-display" &&
    stage === "preview" &&
    !isOperatorDisplayInputComplete(request.operatorDisplayInput);
  const operatorSealKeyNeedsInput =
    request?.kind === "operator-seal-key" &&
    stage === "preview" &&
    !isOperatorSealKeyInputComplete(request.operatorSealKeyInput);
  const clusterNameNeedsInput =
    request?.kind === "cluster-name-register" &&
    stage === "preview" &&
    !isClusterNameInputComplete(request.clusterNameInput);
  const otaApplyNeedsInput =
    request?.kind === "ota-apply" &&
    stage === "preview" &&
    !isOtaApplyInputComplete(request.otaApplyInput);
  const restoreNeedsInput =
    request?.kind === "operator-restore" &&
    stage === "preview" &&
    !isRestoreInputComplete(request.restoreInput);
  const pendingChangeNeedsInput =
    (request?.kind === "cluster-accept-invite" || request?.kind === "cluster-swap") &&
    stage === "preview" &&
    !isPendingChangeInputComplete(request.kind, request.pendingChangeInput);
  const clusterJoinRequestNeedsInput =
    request?.kind === "cluster-request-join" &&
    stage === "preview" &&
    !isClusterJoinRequestInputComplete(request.clusterJoinRequestInput);
  const clusterVoteAdmitNeedsInput =
    request?.kind === "cluster-vote-admit" &&
    stage === "preview" &&
    !isClusterVoteAdmitInputComplete(request.clusterVoteAdmitInput);
  const clusterResignationNeedsInput =
    request?.kind === "cluster-resign" &&
    stage === "preview" &&
    !isClusterResignationInputComplete(request.clusterResignationInput);
  const clusterFormNeedsInput =
    request?.kind === "cluster-form" &&
    stage === "preview" &&
    !isClusterFormInputComplete(request.clusterFormInput);
  const dkgReshareNeedsInput =
    request?.kind === "rotate-keys" &&
    stage === "preview" &&
    !isDkgReshareAttestationInputComplete(request.dkgReshareInput);
  const freezeAdmissionNeedsInput =
    request?.kind === "freeze-admission" &&
    stage === "preview" &&
    !isFreezeAdmissionInputComplete(request.freezeAdmissionInput);
  const emergencyKeyRotationNeedsInput =
    request?.kind === "emergency-key-rotation" &&
    stage === "preview" &&
    !isEmergencyKeyRotationInputComplete(request.emergencyKeyRotationInput);
  const inputBlocked =
    registerNeedsInput ||
    redelegateNeedsInput ||
    chatBootstrapPeersNeedsInput ||
    operatorDisplayNeedsInput ||
    operatorSealKeyNeedsInput ||
    clusterNameNeedsInput ||
    restoreNeedsInput ||
    pendingChangeNeedsInput ||
    clusterJoinRequestNeedsInput ||
    clusterVoteAdmitNeedsInput ||
    clusterResignationNeedsInput ||
    clusterFormNeedsInput ||
    dkgReshareNeedsInput ||
    freezeAdmissionNeedsInput ||
    emergencyKeyRotationNeedsInput ||
    otaApplyNeedsInput;
  const inputTitle = registerNeedsInput
    ? "Fill every register input first"
    : redelegateNeedsInput
      ? "Fill every redelegate input first"
      : chatBootstrapPeersNeedsInput
        ? "Enter the operator ID and chat peers first"
        : operatorDisplayNeedsInput
          ? "Enter the operator ID and valid profile fields first"
          : operatorSealKeyNeedsInput
            ? "Enter the operator ID and public seal key first"
            : clusterNameNeedsInput
              ? "Enter a cluster id and valid cluster name first"
              : restoreNeedsInput
                ? "Enter the operator peer id first"
                : pendingChangeNeedsInput
                  ? "Fill every pending-change input first"
                  : clusterJoinRequestNeedsInput
                    ? "Fill the join request details first"
                    : clusterVoteAdmitNeedsInput
                      ? "Fill the admission vote details first"
                      : clusterResignationNeedsInput
                        ? "Enter a valid resignation nonce first"
                        : clusterFormNeedsInput
                          ? "Fill the 7 active + 3 standby roster and consent signatures first"
                          : dkgReshareNeedsInput
                            ? "Fill the key ceremony output first"
                            : freezeAdmissionNeedsInput
                              ? "Enter the incident reason hash first"
                              : emergencyKeyRotationNeedsInput
                                ? "Fill every emergency key-rotation input first"
                                : otaApplyNeedsInput
                                  ? "Enter the signed image reference first"
                                  : preflight.blocked
                                    ? "Resolve the failing preflight checks first"
                                    : typedBlocked
                                      ? `Type ${typedWord} to confirm`
                                      : undefined;
  const advanceDisabled =
    stage === "executing" || inputBlocked || preflight.blocked || typedBlocked;

  // ⌘⇧↵ confirms the current stage (matches the footer hint); esc is
  // already handled by the shell-level listener.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key !== "Enter") return;
      if (advanceDisabled || stage === "done" || stage === "error") return;
      e.preventDefault();
      advance();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, advanceDisabled, stage, advance]);

  const translatedError =
    result && !result.ok
      ? translateOpError(result.message, request?.kind ?? "operator-restart")
      : null;
  const fundingAddress =
    translatedError?.nextStepRoute === "/wallets" && self.status === "ready"
      ? self.address
      : null;

  return (
    <>
      <div
        className={open ? "drawer-mask is-open" : "drawer-mask"}
        onClick={cancel}
        aria-hidden
      />
      <aside
        className={open ? "drawer is-open" : "drawer"}
        role="dialog"
        aria-modal="true"
        aria-label={request?.title ?? "Operation"}
      >
        <header className="drawer__head">
          <div className="drawer__icon" aria-hidden>
            {request?.icon ?? "OP"}
          </div>
          <div>
            <h2>{request?.title ?? "Operation"}</h2>
            <div className="sub">{request?.sub ?? "—"}</div>
            {request ? (
              <span className={`risk risk--${request.risk ?? (request.destructive ? "high" : "low")}`}>
                {request.risk ?? (request.destructive ? "high" : "low")} risk
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="drawer__close"
            onClick={cancel}
            aria-label="Close drawer"
          >
            ×
          </button>
        </header>

        <div className="drawer__steps" aria-label="Operation progress">
          {STAGE_ORDER.map((s, i) => (
            <div key={s} style={{ display: "contents" }}>
              <div className={stageClass(s, stage)}>
                <span className="dot" />
                <span>{STAGE_LABEL[s]}</span>
              </div>
              {i < STAGE_ORDER.length - 1 ? <div className="drawer__sep" /> : null}
            </div>
          ))}
        </div>

        <div className="drawer__body">
          {request ? (
            <DrawerBody
              preflight={preflight}
              typedWord={typedWord}
              confirmText={confirmText}
              setConfirmText={setConfirmText}
            />
          ) : null}
          {!request ? (
            <p style={{ color: "var(--fg-400)", fontSize: 12 }}>
              No operation in flight.
            </p>
          ) : null}
          {result ? (
            <>
              <div
                className={result.ok ? "halo halo--ok" : "halo halo--err"}
                style={{ alignSelf: "flex-start", whiteSpace: "normal", lineHeight: 1.4 }}
              >
                <span className="dot" /> {translatedError ? translatedError.friendly : result.message}
              </div>
              {translatedError ? (
                <>
                  {fundingAddress ? (
                    <div className="drawer__funding-address">
                      <div>
                        <div className="cap">operator wallet address</div>
                        <div className="mono">{fundingAddress}</div>
                      </div>
                      <button
                        type="button"
                        className={
                          copiedFundingAddress ? "copy-btn copy-btn--copied" : "copy-btn"
                        }
                        onClick={() => {
                          void navigator.clipboard?.writeText(fundingAddress);
                          setCopiedFundingAddress(true);
                          if (fundingCopyTimer.current !== null) {
                            window.clearTimeout(fundingCopyTimer.current);
                          }
                          fundingCopyTimer.current = window.setTimeout(
                            () => setCopiedFundingAddress(false),
                            1200,
                          );
                        }}
                        aria-label="Copy operator wallet address"
                      >
                        {copiedFundingAddress ? "✓" : "CP"}
                      </button>
                    </div>
                  ) : null}
                  {translatedError.nextStepRoute ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      style={{ alignSelf: "flex-start" }}
                      onClick={() => {
                        cancel();
                        navigate(translatedError.nextStepRoute as string);
                      }}
                    >
                      {translatedError.nextStepLabel ?? "Fix it"} →
                    </button>
                  ) : null}
                  {translatedError.raw !== translatedError.friendly ? (
                    <details style={{ fontSize: 11, color: "var(--fg-400)" }}>
                      <summary style={{ cursor: "pointer" }}>host message</summary>
                      <code style={{ overflowWrap: "anywhere", display: "block", marginTop: 6 }}>
                        {translatedError.raw}
                      </code>
                    </details>
                  ) : null}
                </>
              ) : null}
              {result.receiptId ? (
                <div className="drawer__receipt">
                  <div className="cap">receipt</div>
                  <code>{result.receiptId}</code>
                  {result.txHash ? <span className="mono">{result.txHash}</span> : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <footer className="drawer__foot">
          <span style={{ marginRight: "auto" }} />
          <button type="button" className="btn btn--ghost btn--sm" onClick={cancel}>
            {stage === "done" || stage === "error" ? "Close" : "Cancel"}
          </button>
          {stage !== "done" && stage !== "error" ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={advance}
              disabled={advanceDisabled}
              title={inputTitle}
            >
              {stage === "preview"
                ? request?.kind === "operator-register"
                  ? "Continue to signing"
                  : "Authorize & run"
                : stage === "auth"
                  ? request?.confirmLabel ?? "Sign & emit"
                  : "Working…"}
            </button>
          ) : null}
        </footer>
      </aside>
    </>
  );
}

function DrawerBody({
  preflight,
  typedWord,
  confirmText,
  setConfirmText,
}: {
  preflight: { rows: PreflightRow[]; checking: boolean; blocked: boolean };
  typedWord: string | undefined;
  confirmText: string;
  setConfirmText: (value: string) => void;
}) {
  const { stage, request } = useOps();
  if (!request) return null;

  const technical =
    request.technical ?? OP_CATALOG.find((entry) => entry.kind === request.kind)?.technical;

  if (stage === "preview") {
    const live = liveDiffRows(request);
    const diffRows =
      live ?? (request.diff && request.diff.length > 0 ? request.diff : request.fields);
    return (
      <>
        <p style={{ fontSize: 12.5, color: "var(--fg-300)", lineHeight: 1.55 }}>
          {request.intro}
        </p>
        {technical ? (
          <details style={{ fontSize: 11.5, color: "var(--fg-400)", lineHeight: 1.5 }}>
            <summary style={{ cursor: "pointer" }}>technical details</summary>
            <p style={{ margin: "6px 0 0" }}>{technical}</p>
          </details>
        ) : null}
        <PreflightStrip rows={preflight.rows} checking={preflight.checking} />
        <QuorumImpact kind={request.kind} />
        <div className="drawer__diff">
          <div className="cap">{live ? "diff preview · live form values" : "diff preview"}</div>
          {diffRows.map((f) => (
            <div className="drawer__diff-row" key={f.key}>
              <span>+</span>
              <b>{f.label}</b>
              <code>{f.value}</code>
            </div>
          ))}
        </div>
        <div className="drawer__effects">
          <div className="cap">what will happen</div>
          {(request.effects && request.effects.length > 0
            ? request.effects
            : ["Request is queued for explicit approval.", "No host mutation occurs during preview."]).map((effect) => (
            <div className="drawer__effect" key={effect}>
              <span className="dot" />
              <span>{effect}</span>
            </div>
          ))}
        </div>
        <div className="card" style={{ background: "rgba(255,255,255,0.02)" }}>
          {request.fields.map((f) => (
            <div className="kv" key={f.key}>
              <span className="kv__k">{f.label}</span>
              <span className="kv__v mono">{f.value}</span>
            </div>
          ))}
          {request.fields.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--fg-400)", margin: 0 }}>
              No additional inputs required.
            </p>
          ) : null}
        </div>
        {request.kind === "operator-register" ? <RegisterForm /> : null}
        {request.kind === "redelegate" ? <RedelegateForm /> : null}
        {request.kind === "operator-display" ? <OperatorDisplayForm /> : null}
        {request.kind === "operator-seal-key" ? <OperatorSealKeyForm /> : null}
        {request.kind === "chat-bootstrap-peers" ? <ChatBootstrapPeersForm /> : null}
        {request.kind === "cluster-name-register" ? <ClusterNameForm /> : null}
        {request.kind === "operator-restore" ? <RestoreForm /> : null}
        {request.kind === "cluster-accept-invite" || request.kind === "cluster-swap" ? (
          <ClusterPendingChangeForm />
        ) : null}
        {request.kind === "cluster-request-join" ? <ClusterJoinRequestForm /> : null}
        {request.kind === "cluster-vote-admit" ? <ClusterVoteAdmitForm /> : null}
        {request.kind === "cluster-resign" ? <ClusterResignationForm /> : null}
        {request.kind === "cluster-form" ? <ClusterFormProposalForm /> : null}
        {request.kind === "rotate-keys" ? <DkgReshareAttestationForm /> : null}
        {request.kind === "freeze-admission" ? <FreezeAdmissionForm /> : null}
        {request.kind === "emergency-key-rotation" ? (
          <EmergencyKeyRotationForm />
        ) : null}
        {request.kind === "ota-apply" ? <OtaApplyForm /> : null}
        {request.destructive ? (
          <div className="halo halo--warn" style={{ alignSelf: "flex-start" }}>
            <span className="dot" /> Destructive — review every field
          </div>
        ) : null}
      </>
    );
  }

  if (stage === "auth") {
    return (
      <>
        <p style={{ fontSize: 12.5, color: "var(--fg-300)" }}>
          {request.needsPasskey
            ? "Please confirm to hand off to the OS keychain. Signing key material never leaves the keychain — Monarch does not re-authenticate it."
            : "Please confirm to hand off to the OS keychain for signing."}
        </p>
        <QuorumImpact kind={request.kind} />
        {typedWord ? (
          <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
            <span className="kv__k">
              This cannot be undone — type {typedWord} to enable the confirm button
            </span>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={typedWord}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              className="mono"
              style={{
                background: "rgba(0,0,0,0.3)",
                border:
                  confirmText.trim().toUpperCase() === typedWord
                    ? "1px solid var(--ok, #3aa76d)"
                    : "1px solid var(--err-500, #c53030)",
                color: "var(--fg-100)",
                padding: "8px 10px",
                fontSize: 13,
                borderRadius: 6,
                letterSpacing: "0.12em",
              }}
            />
          </label>
        ) : null}
        <div
          className="halo halo--info"
          style={{ alignSelf: "flex-start" }}
        >
          <span className="dot" /> Awaiting operator approval
        </div>
        <div className="keychain-progress" aria-hidden>
          <span />
        </div>
      </>
    );
  }

  if (stage === "executing") {
    return (
      <>
        <p style={{ fontSize: 12.5, color: "var(--fg-300)" }}>
          Submitting to the node and watching for a receipt…
        </p>
        <div className="halo halo--gold" style={{ alignSelf: "flex-start" }}>
          <span className="dot dot--pulse" /> Broadcasting
        </div>
      </>
    );
  }

  if (stage === "done") {
    return (
      <p style={{ fontSize: 12.5, color: "var(--fg-200)" }}>
        Operation acknowledged. The drawer can be safely dismissed.
      </p>
    );
  }

  if (stage === "error") {
    return (
      <p style={{ fontSize: 12.5, color: "var(--fg-200)" }}>
        The operation did not complete. The summary below explains what happened and what to do
        next. The original host message is available below if needed.
      </p>
    );
  }

  return null;
}
