// Operations drawer — slides in from the right. Stage indicator at top,
// preview / auth / executing / done bodies, sticky footer with primary
// "advance" button (gold-discipline) + ghost cancel.

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
import {
  ClusterJoinRequestForm,
  ClusterVoteAdmitForm,
  isClusterJoinRequestInputComplete,
  isClusterVoteAdmitInputComplete,
} from "./ClusterJoinForms";
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
import { isRegisterInputComplete, RegisterForm } from "./RegisterForm";
import { isRedelegateInputComplete, RedelegateForm } from "./RedelegateForm";
import { isRestoreInputComplete, RestoreForm } from "./RestoreForm";
import type { OpStage } from "./types";

const STAGE_LABEL: Record<OpStage, string> = {
  preview: "Preview",
  auth: "Authorize",
  executing: "Executing",
  done: "Done",
  error: "Error",
};

const STAGE_ORDER: OpStage[] = ["preview", "auth", "executing", "done"];

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

export function OperationsDrawer() {
  const { open, stage, request, result, advance, cancel } = useOps();
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
    restoreNeedsInput ||
    pendingChangeNeedsInput ||
    clusterJoinRequestNeedsInput ||
    clusterVoteAdmitNeedsInput ||
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
        ? "Enter the operator peer id and chat peers first"
        : operatorDisplayNeedsInput
          ? "Enter the operator peer id and valid display fields first"
          : restoreNeedsInput
            ? "Enter the operator peer id first"
            : pendingChangeNeedsInput
              ? "Fill every pending-change input first"
              : clusterJoinRequestNeedsInput
                ? "Fill every CJ-1 join request input first"
                : clusterVoteAdmitNeedsInput
                  ? "Fill every CJ-1 admit vote input first"
                  : clusterFormNeedsInput
                    ? "Fill the 7 active + 3 standby roster and consent signatures first"
                    : dkgReshareNeedsInput
                      ? "Fill every DKG attestation input first"
                      : freezeAdmissionNeedsInput
                        ? "Enter the incident reason hash first"
                        : emergencyKeyRotationNeedsInput
                          ? "Fill every emergency key-rotation input first"
                          : otaApplyNeedsInput
                            ? "Enter the signed image reference first"
                            : undefined;

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
          {request ? <DrawerBody /> : null}
          {!request ? (
            <p style={{ color: "var(--fg-400)", fontSize: 12 }}>
              No operation in flight.
            </p>
          ) : null}
          {result ? (
            <>
              <div
                className={result.ok ? "halo halo--ok" : "halo halo--err"}
                style={{ alignSelf: "flex-start" }}
              >
                <span className="dot" /> {result.message}
              </div>
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
          <button type="button" className="btn btn--ghost btn--sm" onClick={cancel}>
            {stage === "done" || stage === "error" ? "Close" : "Cancel"}
          </button>
          {stage !== "done" && stage !== "error" ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={advance}
              disabled={stage === "executing" || inputBlocked}
              title={inputTitle}
            >
              {stage === "preview"
                ? "Authorize & run"
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

function DrawerBody() {
  const { stage, request } = useOps();
  if (!request) return null;

  if (stage === "preview") {
    return (
      <>
        <p style={{ fontSize: 12.5, color: "var(--fg-300)", lineHeight: 1.55 }}>
          {request.intro}
        </p>
        <div className="drawer__diff">
          <div className="cap">diff preview</div>
          {(request.diff && request.diff.length > 0 ? request.diff : request.fields).map((f) => (
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
        {request.kind === "chat-bootstrap-peers" ? <ChatBootstrapPeersForm /> : null}
        {request.kind === "operator-restore" ? <RestoreForm /> : null}
        {request.kind === "cluster-accept-invite" || request.kind === "cluster-swap" ? (
          <ClusterPendingChangeForm />
        ) : null}
        {request.kind === "cluster-request-join" ? <ClusterJoinRequestForm /> : null}
        {request.kind === "cluster-vote-admit" ? <ClusterVoteAdmitForm /> : null}
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
            ? "Confirm to hand off to the OS keychain. Signing key material never leaves the keychain — Monarch does not re-authenticate it."
            : "Confirm to hand off to the OS keychain for signing."}
        </p>
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
        The host returned an error. Review the message below and retry from
        the source view if needed.
      </p>
    );
  }

  return null;
}
