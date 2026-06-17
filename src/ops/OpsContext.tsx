// Operations drawer context — every sensitive action goes through the same
// review, authorization, execution, and receipt lifecycle.
//
// Monarch OS service verbs route through Talos API mTLS. Actions without a
// signed or native control path are blocked instead of falling back to shell
// execution.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  inTauri,
  isNoSessionError,
  keychainGet,
  KEYCHAIN_ACCOUNTS,
  rpcEndpoint,
  sshExec,
  talosBootstrap,
  talosCleanProtocoreLogs,
  talosExportProtocoreBackup,
  talosGenerateRecoveryNodeConfig,
  talosMaintenanceApply,
  talosOperatorSealEk,
  talosRollback,
  talosServiceAction,
  talosSetLogRetention,
  talosStatus,
  talosUpgrade,
  talosWipeProtocore,
} from "../sdk";
import { validateOperatorMnemonic } from "../sdk/operatorMnemonic";
import {
  awaitNodeReconnect,
  isUpgradeRebooting,
} from "../sdk/talosUpgradeReboot";
import { submitChatBootstrapPeers } from "../sdk/chatPeerOps";
import { submitClusterNameRegistration } from "../sdk/clusterNameOps";
import { submitOperatorDisplay } from "../sdk/operatorDisplayOps";
import { submitOperatorSealKey } from "../sdk/operatorSealKeyOps";
import {
  submitRequestClusterJoin,
  submitVoteClusterAdmit,
} from "../sdk/clusterJoinOps";
import { submitClusterResignation } from "../sdk/clusterResignations";
import { submitFormCluster } from "../sdk/clusterFormOps";
import { submitUpdateCharter } from "../sdk/charterAmendmentOps";
import { submitRedelegate } from "../sdk/delegationOps";
import { submitDkgReshareAttestation } from "../sdk/dkgReshareOps";
import {
  submitEmergencyKeyRotation,
  submitFreezeAdmission,
} from "../sdk/incidentOps";
import { submitPendingChange } from "../sdk/pendingChangeOps";
import { submitRegister } from "../sdk/register";
import { submitRecoverOperatorNode } from "../sdk/recoveryOps";
import { commandFor, talosActionFor } from "./commands";
import {
  MISSING_FOUNDATION_KEY_MESSAGE,
  MISSING_OPERATOR_KEY_MESSAGE,
} from "./errors";
import {
  browserExecutionBlocked,
  unsignedExecutionBlocked,
} from "./executionPolicy";
import {
  appendOperationReceipt,
  clearOperationReceipts,
  createOperationReceipt,
  readOperationReceipts,
  type OperationReceipt,
  type OperationReceiptMeta,
} from "./receipts";
import type {
  OpRequest,
  OpResult,
  OpStage,
  DkgReshareAttestationInput,
  EmergencyKeyRotationInput,
  FreezeAdmissionInput,
  ChatBootstrapPeersInput,
  ClusterNameInput,
  ClusterFormInput,
  ClusterJoinRequestInput,
  ClusterVoteAdmitInput,
  ClusterResignationInput,
  OtaApplyInput,
  LogRetentionInput,
  OperatorDisplayInput,
  OperatorSealKeyInput,
  PendingChangeInput,
  RecoverKeysInput,
  RedelegateInput,
  RegisterInput,
  RestoreInput,
} from "./types";
import { DEFAULT_LOG_RETENTION } from "./types";

type OpsState = {
  request: OpRequest | null;
  stage: OpStage;
  result: OpResult | null;
  open: boolean;
  receipts: OperationReceipt[];
};

type OpsContextValue = OpsState & {
  requestOp: (op: OpRequest) => void;
  advance: () => void;
  cancel: () => void;
  reset: () => void;
  clearReceipts: () => void;
  /** Update the in-flight request's `registerInput` from the
   *  operator-register form. No-ops when no request is open or the
   *  current request isn't `operator-register`. */
  setRegisterInput: (patch: Partial<RegisterInput>) => void;
  /** Update the in-flight request's `redelegateInput` from the
   *  redelegate form. No-ops when no request is open or the current
   *  request isn't `redelegate`. */
  setRedelegateInput: (patch: Partial<RedelegateInput>) => void;
  /** Update the in-flight request's `restoreInput` from the recovery form. */
  setRestoreInput: (patch: Partial<RestoreInput>) => void;
  /** Update the operator chat bootstrap metadata declaration payload. */
  setChatBootstrapPeersInput: (patch: Partial<ChatBootstrapPeersInput>) => void;
  /** Update the operator display metadata declaration payload. */
  setOperatorDisplayInput: (patch: Partial<OperatorDisplayInput>) => void;
  /** Update the operator LythiumSeal EK publication payload. */
  setOperatorSealKeyInput: (patch: Partial<OperatorSealKeyInput>) => void;
  /** Update the cluster-name registration payload. */
  setClusterNameInput: (patch: Partial<ClusterNameInput>) => void;
  /** Update the pending-change request payload for cluster invite/swap. */
  setPendingChangeInput: (patch: Partial<PendingChangeInput>) => void;
  /** Update the CJ-1 join request payload. */
  setClusterJoinRequestInput: (patch: Partial<ClusterJoinRequestInput>) => void;
  /** Update the CJ-1 admit vote payload. */
  setClusterVoteAdmitInput: (patch: Partial<ClusterVoteAdmitInput>) => void;
  /** Update the Q120 cluster resignation payload. */
  setClusterResignationInput: (patch: Partial<ClusterResignationInput>) => void;
  /** Update the cluster-formation roster proposal payload. */
  setClusterFormInput: (patch: Partial<ClusterFormInput>) => void;
  /** Update the DKG re-share attestation payload for rotate-keys. */
  setDkgReshareInput: (patch: Partial<DkgReshareAttestationInput>) => void;
  /** Update the freezeAdmission incident executor payload. */
  setFreezeAdmissionInput: (patch: Partial<FreezeAdmissionInput>) => void;
  /** Update the emergencyKeyRotation incident executor payload. */
  setEmergencyKeyRotationInput: (patch: Partial<EmergencyKeyRotationInput>) => void;
  /** Update the in-flight request's `otaApplyInput` from the OS upgrade form. */
  setOtaApplyInput: (patch: Partial<OtaApplyInput>) => void;
  /** Update the in-flight request's `logRetentionInput` from the log
   *  retention / clean-up form. */
  setLogRetentionInput: (patch: Partial<LogRetentionInput>) => void;
  /** Update the in-flight request's `recoverKeysInput` from the recovery
   *  menu (host/disk/operatorId for the seat-preserving recovery flow). */
  setRecoverKeysInput: (patch: Partial<RecoverKeysInput>) => void;
};

const OpsContext = createContext<OpsContextValue | null>(null);

const initialState: OpsState = {
  request: null,
  stage: "preview",
  result: null,
  open: false,
  receipts: [],
};

/** Trim and clip stdout to a one-line summary for the halo. */
function summarize(output: string, fallback: string): string {
  const trimmed = output.trim();
  if (!trimmed) return fallback;
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed;
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine;
}

export function OpsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OpsState>(() => ({
    ...initialState,
    receipts: readOperationReceipts(),
  }));

  // Guards against re-submitting an in-flight execution: holds the request
  // object whose flow has already been dispatched. A second `advance()` (rapid
  // double-click, the ⌘⇧↵ shortcut racing the button, or a strict-mode double
  // invocation of the `setState` updater) is a no-op so the same op never
  // submits twice — which on register would surface as
  // `duplicate tx already known` / `replace underpriced`.
  const inFlightRef = useRef<OpRequest | null>(null);

  const finishOperation = useCallback(
    (req: OpRequest, result: OpResult, meta: OperationReceiptMeta) => {
      const receipt = createOperationReceipt(req, result, meta);
      setState((s) => {
        if (s.stage !== "executing" || s.request !== req) return s;
        const receipts = appendOperationReceipt(receipt);
        return {
          ...s,
          stage: result.ok ? "done" : "error",
          result: { ...result, receiptId: receipt.id },
          receipts,
        };
      });
    },
    [],
  );

  const settleOperation = useCallback(
    (req: OpRequest, result: OpResult, meta: OperationReceiptMeta) => {
      const complete = () => finishOperation(req, result, meta);
      if (typeof window !== "undefined") {
        window.setTimeout(complete, 0);
      } else {
        queueMicrotask(complete);
      }
    },
    [finishOperation],
  );

  const requestOp = useCallback((op: OpRequest) => {
    inFlightRef.current = null;
    setState((prev) => ({
      request: op,
      stage: "preview",
      result: null,
      open: true,
      receipts: prev.receipts,
    }));
  }, []);

  const cancel = useCallback(() => {
    inFlightRef.current = null;
    setState((prev) => ({ ...prev, open: false }));
    // Detach request after the slide-out finishes so the body doesn't flash empty.
    window.setTimeout(
      () => setState((prev) => ({ ...initialState, receipts: prev.receipts })),
      360,
    );
  }, []);

  const reset = useCallback(() => {
    inFlightRef.current = null;
    setState((prev) => ({ ...initialState, receipts: prev.receipts }));
  }, []);

  const clearReceipts = useCallback(() => {
    setState((prev) => ({ ...prev, receipts: clearOperationReceipts() }));
  }, []);

  const blockBrowserExecution = useCallback((req: OpRequest) => {
    const { result, meta } = browserExecutionBlocked(req);
    settleOperation(req, result, meta);
  }, [settleOperation]);

  const runSshFlow = useCallback(async (req: OpRequest, cmd: string) => {
    try {
      const output = await sshExec(cmd);
      settleOperation(
        req,
        {
          ok: true,
          message: summarize(output, `${req.title} acknowledged.`),
        },
        { transport: "ssh-dev", command: cmd },
      );
    } catch (err) {
      // If the native control channel is unavailable outside the desktop app,
      // report that clearly. Other host errors surface verbatim.
      if (isNoSessionError(err) && !inTauri()) {
        blockBrowserExecution(req);
        return;
      }
      const message = (err as Error)?.message ?? String(err);
      settleOperation(
        req,
        { ok: false, message },
        { transport: "ssh-dev", command: cmd },
      );
    }
  }, [blockBrowserExecution, settleOperation]);

  const runRegisterFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.registerInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "Register form is missing required fields." },
          { transport: "register-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_OPERATOR_KEY_MESSAGE,
            },
            { transport: "register-tx" },
          );
          return;
        }
        const res = await submitRegister({
          rpcUrl: rpcEndpoint,
          mnemonic,
          endpoint: input.endpoint,
          capabilities: input.capabilities,
          bondLythoshi: input.bondLythoshi,
          peerIdHex: input.peerIdHex,
          sppkHashHex: input.sppkHashHex,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Registered peer ${res.peerIdHex.slice(0, 18)}… (tx ${res.txHash.slice(0, 10)}…).`,
            txHash: res.txHash,
          },
          { transport: "register-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(req, { ok: false, message }, { transport: "register-tx" });
      }
    },
    [settleOperation],
  );

  const runRedelegateFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.redelegateInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "Redelegate form is missing required fields." },
          { transport: "redelegate-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_OPERATOR_KEY_MESSAGE,
            },
            { transport: "redelegate-tx" },
          );
          return;
        }
        const res = await submitRedelegate({
          rpcUrl: rpcEndpoint,
          mnemonic,
          fromCluster: input.fromCluster,
          toCluster: input.toCluster,
          weightBps: input.weightBps,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: [
              `Redelegated ${input.weightBps} bps`,
              `from C-${input.fromCluster.toString().padStart(3, "0")}`,
              `to C-${input.toCluster.toString().padStart(3, "0")}`,
              `(tx ${res.txHash.slice(0, 10)}...).`,
            ].join(" "),
            txHash: res.txHash,
          },
          { transport: "redelegate-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(req, { ok: false, message }, { transport: "redelegate-tx" });
      }
    },
    [settleOperation],
  );

  const runChatBootstrapPeersFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.chatBootstrapPeersInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "Chat bootstrap peer form is missing required fields." },
          { transport: "chat-bootstrap-peers-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_OPERATOR_KEY_MESSAGE,
            },
            { transport: "chat-bootstrap-peers-tx" },
          );
          return;
        }
        const res = await submitChatBootstrapPeers({
          rpcUrl: rpcEndpoint,
          mnemonic,
          peerIdHex: input.peerIdHex,
          peers: input.peers,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Published ${res.peerCount} chat bootstrap peer${res.peerCount === 1 ? "" : "s"} for ${res.peerIdHex.slice(0, 18)}... (tx ${res.txHash.slice(0, 10)}...).`,
            txHash: res.txHash,
          },
          { transport: "chat-bootstrap-peers-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "chat-bootstrap-peers-tx" },
        );
      }
    },
    [settleOperation],
  );

  const runOperatorDisplayFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.operatorDisplayInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "Operator display form is missing required fields." },
          { transport: "operator-display-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_OPERATOR_KEY_MESSAGE,
            },
            { transport: "operator-display-tx" },
          );
          return;
        }
        const res = await submitOperatorDisplay({
          rpcUrl: rpcEndpoint,
          mnemonic,
          peerIdHex: input.peerIdHex,
          moniker: input.moniker,
          alias: input.alias,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Published operator display metadata for ${res.peerIdHex.slice(0, 18)}... (tx ${res.txHash.slice(0, 10)}...).`,
            txHash: res.txHash,
          },
          { transport: "operator-display-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "operator-display-tx" },
        );
      }
    },
    [settleOperation],
  );

  const runOperatorSealKeyFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.operatorSealKeyInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "Operator seal key form is missing required fields." },
          { transport: "operator-seal-key-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_OPERATOR_KEY_MESSAGE,
            },
            { transport: "operator-seal-key-tx" },
          );
          return;
        }
        const res = await submitOperatorSealKey({
          rpcUrl: rpcEndpoint,
          mnemonic,
          peerIdHex: input.peerIdHex,
          sealEkHex: input.sealEkHex,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Published operator seal key for ${res.peerIdHex.slice(0, 18)}... (tx ${res.txHash.slice(0, 10)}...).`,
            txHash: res.txHash,
          },
          { transport: "operator-seal-key-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "operator-seal-key-tx" },
        );
      }
    },
    [settleOperation],
  );

  const runClusterNameFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.clusterNameInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "Cluster name form is missing required fields." },
          { transport: "cluster-name-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_OPERATOR_KEY_MESSAGE,
            },
            { transport: "cluster-name-tx" },
          );
          return;
        }
        const res = await submitClusterNameRegistration({
          rpcUrl: rpcEndpoint,
          mnemonic,
          clusterId: input.clusterId,
          name: input.name,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Registered cluster ${res.clusterId} as ${res.name} (tx ${res.txHash.slice(0, 10)}...).`,
            txHash: res.txHash,
          },
          { transport: "cluster-name-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "cluster-name-tx" },
        );
      }
    },
    [settleOperation],
  );

  const runRestoreFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.restoreInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "Restore form is missing the operator peer id." },
          { transport: "foundation-recovery-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.foundationRecoveryMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_FOUNDATION_KEY_MESSAGE,
            },
            { transport: "foundation-recovery-tx" },
          );
          return;
        }
        const res = await submitRecoverOperatorNode({
          rpcUrl: rpcEndpoint,
          foundationMnemonic: mnemonic,
          peerIdHex: input.peerIdHex,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Submitted recoverOperatorNode for ${res.peerIdHex.slice(0, 18)}... (tx ${res.txHash.slice(0, 10)}...).`,
            txHash: res.txHash,
          },
          { transport: "foundation-recovery-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(req, { ok: false, message }, { transport: "foundation-recovery-tx" });
      }
    },
    [settleOperation],
  );

  const runPendingChangeFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.pendingChangeInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "Pending-change form is missing required fields." },
          { transport: "foundation-pending-change-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.foundationRecoveryMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_FOUNDATION_KEY_MESSAGE,
            },
            { transport: "foundation-pending-change-tx" },
          );
          return;
        }
        const res = await submitPendingChange({
          rpcUrl: rpcEndpoint,
          foundationMnemonic: mnemonic,
          kind: input.kind,
          targetPubkeyHex: input.targetPubkeyHex,
          effectiveEpoch: input.effectiveEpoch,
          intentId: input.intentId,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Submitted ${res.kind} pending change for ${res.targetPubkeyHex.slice(0, 18)}... at epoch ${res.effectiveEpoch} (tx ${res.txHash.slice(0, 10)}...).`,
            txHash: res.txHash,
          },
          { transport: "foundation-pending-change-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "foundation-pending-change-tx" },
        );
      }
    },
    [settleOperation],
  );

  const runClusterJoinRequestFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.clusterJoinRequestInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "CJ-1 join request form is missing required fields." },
          { transport: "cluster-join-request-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_OPERATOR_KEY_MESSAGE,
            },
            { transport: "cluster-join-request-tx" },
          );
          return;
        }
        const res = await submitRequestClusterJoin({
          rpcUrl: rpcEndpoint,
          mnemonic,
          clusterId: input.clusterId,
          operatorPubkeyHex: input.operatorPubkeyHex,
          bondLythoshi: input.bondLythoshi,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Submitted requestClusterJoin for cluster ${res.clusterId}, operator ${res.operatorIdHex.slice(0, 18)}... (tx ${res.txHash.slice(0, 10)}...).`,
            txHash: res.txHash,
          },
          { transport: "cluster-join-request-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "cluster-join-request-tx" },
        );
      }
    },
    [settleOperation],
  );

  const runClusterVoteAdmitFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.clusterVoteAdmitInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "CJ-1 admit vote form is missing required fields." },
          { transport: "cluster-vote-admit-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_OPERATOR_KEY_MESSAGE,
            },
            { transport: "cluster-vote-admit-tx" },
          );
          return;
        }
        const res = await submitVoteClusterAdmit({
          rpcUrl: rpcEndpoint,
          mnemonic,
          clusterId: input.clusterId,
          operatorIdHex: input.operatorIdHex,
          voterPubkeyHex: input.voterPubkeyHex,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Submitted voteClusterAdmit for cluster ${res.clusterId}, operator ${res.operatorIdHex.slice(0, 18)}... (tx ${res.txHash.slice(0, 10)}...).`,
            txHash: res.txHash,
          },
          { transport: "cluster-vote-admit-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "cluster-vote-admit-tx" },
        );
      }
    },
    [settleOperation],
  );

  const runClusterResignationFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.clusterResignationInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "Cluster resignation form is missing required fields." },
          { transport: "cluster-resignation-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_OPERATOR_KEY_MESSAGE,
            },
            { transport: "cluster-resignation-tx" },
          );
          return;
        }
        const res = await submitClusterResignation({
          rpcUrl: rpcEndpoint,
          mnemonic,
          nonce: input.nonce,
          expedite: input.expedite,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Submitted cluster resignation nonce ${res.nonce} for operator ${res.operatorPubkeyHex.slice(0, 18)}... (tx ${res.txHash.slice(0, 10)}...).`,
            txHash: res.txHash,
          },
          { transport: "cluster-resignation-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "cluster-resignation-tx" },
        );
      }
    },
    [settleOperation],
  );

  const runClusterFormFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.clusterFormInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "Cluster formation form is missing required fields." },
          { transport: "cluster-form-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_OPERATOR_KEY_MESSAGE,
            },
            { transport: "cluster-form-tx" },
          );
          return;
        }
        const res = await submitFormCluster({
          rpcUrl: rpcEndpoint,
          mnemonic,
          activePubkeysHex: input.activePubkeysHex,
          standbyPubkeysHex: input.standbyPubkeysHex,
          signaturesHex: input.signaturesHex,
          // Optional 30-byte V2 economics charter — present selects the
          // formCluster(bytes,bytes,bytes,bytes) path; absent stays V1.
          charterHex: input.charterHex,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Submitted formCluster with ${res.activeCount} active, ${res.standbyCount} standby, and ${res.signatureCount} consent signatures (tx ${res.txHash.slice(0, 10)}...).`,
            txHash: res.txHash,
          },
          { transport: "cluster-form-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(req, { ok: false, message }, { transport: "cluster-form-tx" });
      }
    },
    [settleOperation],
  );

  const runUpdateCharterFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.clusterUpdateCharterInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "Charter amendment form is missing required fields." },
          { transport: "cluster-update-charter-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            { ok: false, message: MISSING_OPERATOR_KEY_MESSAGE },
            { transport: "cluster-update-charter-tx" },
          );
          return;
        }
        const res = await submitUpdateCharter({
          rpcUrl: rpcEndpoint,
          mnemonic,
          clusterId: Number(input.clusterId),
          charterHex: input.charterHex,
          signerPubkeysHex: input.signerPubkeysHex,
          signaturesHex: input.signaturesHex,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Submitted updateCharter for cluster ${res.clusterId} with ${res.signatureCount} active-member consents (tx ${res.txHash.slice(0, 10)}...). The new terms take effect after the cooldown; the current terms apply until then.`,
            txHash: res.txHash,
          },
          { transport: "cluster-update-charter-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(req, { ok: false, message }, { transport: "cluster-update-charter-tx" });
      }
    },
    [settleOperation],
  );

  const runDkgReshareFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.dkgReshareInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "DKG re-share attestation form is missing required fields." },
          { transport: "dkg-reshare-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_OPERATOR_KEY_MESSAGE,
            },
            { transport: "dkg-reshare-tx" },
          );
          return;
        }
        const res = await submitDkgReshareAttestation({
          rpcUrl: rpcEndpoint,
          mnemonic,
          intentId: input.intentId,
          consensusPublicKeysHex: input.consensusPublicKeysHex,
          thresholdSigHex: input.thresholdSigHex,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Submitted DKG re-share attestation for intent ${res.intentId} with ${res.signerCount} signers (tx ${res.txHash.slice(0, 10)}...).`,
            txHash: res.txHash,
          },
          { transport: "dkg-reshare-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(req, { ok: false, message }, { transport: "dkg-reshare-tx" });
      }
    },
    [settleOperation],
  );

  const runFreezeAdmissionFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.freezeAdmissionInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "Freeze-admission form is missing required fields." },
          { transport: "incident-freeze-admission-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.foundationRecoveryMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_FOUNDATION_KEY_MESSAGE,
            },
            { transport: "incident-freeze-admission-tx" },
          );
          return;
        }
        const res = await submitFreezeAdmission({
          rpcUrl: rpcEndpoint,
          foundationMnemonic: mnemonic,
          reasonHashHex: input.reasonHashHex,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Submitted freezeAdmission for ${res.reasonHashHex.slice(0, 18)}... (tx ${res.txHash.slice(0, 10)}...).`,
            txHash: res.txHash,
          },
          { transport: "incident-freeze-admission-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "incident-freeze-admission-tx" },
        );
      }
    },
    [settleOperation],
  );

  const runEmergencyKeyRotationFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.emergencyKeyRotationInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "Emergency key-rotation form is missing required fields." },
          { transport: "incident-emergency-key-rotation-tx" },
        );
        return;
      }
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.foundationRecoveryMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message: MISSING_FOUNDATION_KEY_MESSAGE,
            },
            { transport: "incident-emergency-key-rotation-tx" },
          );
          return;
        }
        const res = await submitEmergencyKeyRotation({
          rpcUrl: rpcEndpoint,
          foundationMnemonic: mnemonic,
          targetPubkeyHex: input.targetPubkeyHex,
          effectiveEpoch: input.effectiveEpoch,
          intentId: input.intentId,
        });
        settleOperation(
          req,
          {
            ok: true,
            message: `Submitted emergencyKeyRotation for ${res.targetPubkeyHex.slice(0, 18)}... at epoch ${res.effectiveEpoch} (tx ${res.txHash.slice(0, 10)}...).`,
            txHash: res.txHash,
          },
          { transport: "incident-emergency-key-rotation-tx" },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "incident-emergency-key-rotation-tx" },
        );
      }
    },
    [settleOperation],
  );

  const runOtaApplyFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.otaApplyInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "OS upgrade form is missing the signed image reference." },
          { transport: "talos", action: "upgrade" },
        );
        return;
      }
      try {
        const result = await talosUpgrade(input);
        // A Talos image upgrade reboots the node into the new image, so the
        // control connection drops mid-call. The native side detects that
        // post-dispatch drop and reports "rebooting" instead of a hard failure.
        // That is a SUCCESS: the upgrade was accepted; the node is restarting.
        if (isUpgradeRebooting(result.output)) {
          settleOperation(
            req,
            {
              ok: true,
              message:
                "Upgrade dispatched - the node is rebooting into the new image. Monarch will reconnect automatically once it is back; this usually takes a minute or two.",
            },
            {
              transport: "talos",
              action: "upgrade",
              endpoint: result.endpoint,
              nodeAddress: result.nodeAddress,
              command: result.command,
            },
          );
          // Poll the node back via the robust reachability signal so the topbar
          // node chip and node-status reads flip live the moment it returns on
          // the new image. Best-effort and non-blocking — the success above is
          // already recorded; the drawer never waits out the reboot.
          void awaitNodeReconnect(result.endpoint).catch(() => undefined);
          return;
        }
        settleOperation(
          req,
          {
            ok: true,
            message: summarize(result.output, `${req.title} submitted via Talos Upgrade.`),
          },
          {
            transport: "talos",
            action: "upgrade",
            endpoint: result.endpoint,
            nodeAddress: result.nodeAddress,
            command: result.command,
          },
        );
      } catch (err) {
        // A genuine PRE-dispatch failure: the upgrade request never reached the
        // node (couldn't open the control channel, staged-upgrade rejection).
        // The native side only raises here when the request did NOT land, so
        // surfacing "could not reach" is correct.
        const message = (err as Error)?.message ?? String(err);
        settleOperation(req, { ok: false, message }, { transport: "talos", action: "upgrade" });
      }
    },
    [settleOperation],
  );

  const runExportBackupFlow = useCallback(
    async (req: OpRequest) => {
      try {
        const result = await talosExportProtocoreBackup();
        settleOperation(
          req,
          {
            ok: true,
            message: summarize(
              result.output,
              `Exported offline Protocore backup to ${result.archivePath}.`,
            ),
          },
          {
            transport: "talos",
            service: "ext-protocore",
            action: "copy-backup",
            endpoint: result.endpoint,
            nodeAddress: result.nodeAddress,
            command: result.command,
            artifactPath: result.manifestPath,
            artifactSha256: result.manifestSha256,
          },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "talos", service: "ext-protocore", action: "copy-backup" },
        );
      }
    },
    [settleOperation],
  );

  const runOtaRollbackFlow = useCallback(
    async (req: OpRequest) => {
      try {
        const result = await talosRollback();
        settleOperation(
          req,
          {
            ok: true,
            message: summarize(result.output, `${req.title} submitted via Talos Rollback.`),
          },
          {
            transport: "talos",
            action: "rollback",
            endpoint: result.endpoint,
            nodeAddress: result.nodeAddress,
            command: result.command,
          },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(req, { ok: false, message }, { transport: "talos", action: "rollback" });
      }
    },
    [settleOperation],
  );

  const runReprovisionFlow = useCallback(
    async (req: OpRequest) => {
      try {
        const result = await talosWipeProtocore();
        // The Reset wipes EPHEMERAL — which holds the single-node controlplane's
        // etcd data — so after the reboot the machine sits at "booting" until
        // etcd is re-bootstrapped, even though ext-protocore (the chain) serves
        // independently. Follow the reset with an etcd bootstrap so the node
        // returns to "ready", not just chain-serving. Best-effort: the wipe
        // already succeeded; talos_bootstrap retries through the reboot and is
        // idempotent (a no-op if already bootstrapped).
        let bootstrapNote = "";
        try {
          const status = await talosStatus();
          const host = result.nodeAddress || result.endpoint || status.nodeAddress;
          if (host && status.configPath) {
            const boot = await talosBootstrap(host, status.configPath);
            bootstrapNote = ` etcd: ${boot}.`;
          }
        } catch {
          bootstrapNote =
            " (note: the node may need a one-time etcd bootstrap to leave \"booting\" — re-run once it is back, or use Bootstrap node).";
        }
        settleOperation(
          req,
          {
            ok: true,
            message: summarize(
              result.output,
              `${req.title} submitted via Talos Reset (EPHEMERAL). The node wipes its chain data and reboots; it re-resolves cold-start seeds and fast-syncs from a fresh DB.${bootstrapNote}`,
            ),
          },
          {
            transport: "talos",
            action: "reset-ephemeral",
            endpoint: result.endpoint,
            nodeAddress: result.nodeAddress,
            command: result.command,
          },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "talos", action: "reset-ephemeral" },
        );
      }
    },
    [settleOperation],
  );

  // Seat-preserving "Re-provision with existing keys" recovery. Orchestrates the
  // full SEQUENCE: (1) stage the keychain mnemonic into a fresh recovery machine
  // config and apply it with a reboot, (2) wipe EPHEMERAL, (3) bootstrap etcd,
  // (4) wait for the node to come back and re-sync, (5) re-publish the
  // regenerated ML-KEM seal key so sealed-mempool duty resumes. The consensus
  // key is re-derived on first boot from the staged mnemonic via the entrypoint's
  // `gen-operator-keys --from-mnemonic`, so the bonded seat is preserved.
  const runRecoverKeysFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.recoverKeysInput;
      if (!input || !input.host || !input.disk) {
        settleOperation(
          req,
          {
            ok: false,
            message:
              "Recovery is missing the node's host or install disk — connect to your Monarch OS node first.",
          },
          { transport: "talos", action: "recover-keys" },
        );
        return;
      }
      try {
        // Read + validate the operator mnemonic from the OS keychain. Without it
        // there is nothing to re-derive the consensus key from, so fail closed
        // (re-enrolling as a new node would orphan the bonded seat).
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (!mnemonic) {
          settleOperation(
            req,
            {
              ok: false,
              message:
                "No operator mnemonic is saved in this computer's keychain. Import it in Settings → Operator key first, or re-enroll as a new node (which orphans the bonded seat).",
            },
            { transport: "talos", action: "recover-keys" },
          );
          return;
        }
        const check = validateOperatorMnemonic(mnemonic);
        if (!check.ok) {
          settleOperation(
            req,
            {
              ok: false,
              message: `The saved operator mnemonic is not usable for recovery: ${check.text}`,
            },
            { transport: "talos", action: "recover-keys" },
          );
          return;
        }

        // (1) Mint the recovery config (stages the mnemonic via machine.files +
        // the PROTOCORE_OPERATOR_MNEMONIC_FILE env) and apply it with a reboot so
        // the file lands on STATE before the EPHEMERAL wipe.
        const recovery = await talosGenerateRecoveryNodeConfig(
          input.host,
          input.disk,
          mnemonic,
        );
        await talosMaintenanceApply({
          host: input.host,
          configYaml: recovery.configYaml,
          dryRun: false,
          mode: "reboot",
          talosconfigYaml: recovery.talosconfigYaml,
        });

        // (2) Wipe EPHEMERAL so the stale (forked) chain DB + the old sealed key
        // are removed; first-boot keygen then re-derives the same key from the
        // staged mnemonic.
        const wipe = await talosWipeProtocore();

        // (3) Re-bootstrap etcd (the wipe clears it on a single-node controlplane).
        let bootstrapNote = "";
        try {
          const status = await talosStatus();
          const host = wipe.nodeAddress || wipe.endpoint || status.nodeAddress || input.host;
          if (host && status.configPath) {
            const boot = await talosBootstrap(host, status.configPath);
            bootstrapNote = ` etcd: ${boot}.`;
          }
        } catch {
          bootstrapNote =
            " (note: the node may need a one-time etcd bootstrap to leave \"booting\" — use Bootstrap node once it is back).";
        }

        settleOperation(
          req,
          {
            ok: true,
            message: summarize(
              wipe.output,
              `Recovery staged: the node re-derives its consensus key from your keychain mnemonic on first boot, keeping your bonded seat. It wipes the forked data and fast-syncs from a checkpoint.${bootstrapNote} Monarch will re-publish your seal key once it is back and synced.`,
            ),
          },
          {
            transport: "talos",
            action: "recover-keys",
            endpoint: wipe.endpoint,
            nodeAddress: wipe.nodeAddress,
            command: wipe.command,
          },
        );

        // (4) Wait for the node to reboot + re-sync, then (5) re-publish the
        // regenerated seal key. Best-effort and non-blocking: the recovery above
        // is already recorded; this resumes sealed-mempool duty for the operator.
        void (async () => {
          try {
            const back = await awaitNodeReconnect(rpcEndpoint);
            if (!back.reconnected) return;
            const ek = await talosOperatorSealEk().catch(() => null);
            if (!ek || !ek.sealEkHex) return;
            requestOp({
              kind: "operator-seal-key",
              title: "Re-publish seal key",
              sub: "Resume sealed-mempool duty after recovery",
              intro:
                "Re-publishes your public seal key after recovery so your cluster can include you in sealed-mempool duty again. Only your node holds the private half.",
              icon: "SK",
              risk: "medium",
              needsPasskey: true,
              confirmLabel: "Approve seal key",
              fields: [
                { key: "peer-id", label: "Operator ID", value: input.operatorId ?? "your registered operator" },
                { key: "seal-key", label: "Seal key", value: "regenerated public key from your node" },
                { key: "private-key", label: "Private key", value: "stays on your node" },
              ],
              operatorSealKeyInput: input.operatorId
                ? { peerIdHex: input.operatorId, sealEkHex: ek.sealEkHex }
                : undefined,
            });
          } catch {
            // Re-sync timed out or the EK read failed — the operator can
            // re-publish the seal key manually from the Operator view.
          }
        })();
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "talos", action: "recover-keys" },
        );
      }
    },
    [requestOp, settleOperation],
  );

  const runSetLogRetentionFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.logRetentionInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "No retention bounds were provided." },
          { transport: "talos", action: "set-log-retention" },
        );
        return;
      }
      try {
        const result = await talosSetLogRetention(input.maxMegabytes, input.maxFiles);
        settleOperation(
          req,
          {
            ok: true,
            message: summarize(
              result.output,
              `${req.title} applied via Talos ApplyConfiguration. Restart ext-protocore for the new bound to take effect.`,
            ),
          },
          {
            transport: "talos",
            action: "set-log-retention",
            endpoint: result.endpoint,
            nodeAddress: result.nodeAddress,
            command: result.command,
          },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "talos", action: "set-log-retention" },
        );
      }
    },
    [settleOperation],
  );

  const runCleanLogsFlow = useCallback(
    async (req: OpRequest) => {
      const input = req.logRetentionInput;
      if (!input) {
        settleOperation(
          req,
          { ok: false, message: "No retention bounds were provided." },
          { transport: "talos", action: "clean-protocore-logs" },
        );
        return;
      }
      try {
        const result = await talosCleanProtocoreLogs(input.maxMegabytes, input.maxFiles);
        settleOperation(
          req,
          {
            ok: true,
            message: summarize(
              result.output,
              `${req.title}: retention applied and ext-protocore restarted via Talos. Existing bytes are reclaimed by the extension's rotation under the new bound — Talos has no file-truncate RPC.`,
            ),
          },
          {
            transport: "talos",
            action: "clean-protocore-logs",
            endpoint: result.endpoint,
            nodeAddress: result.nodeAddress,
            command: result.command,
          },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(
          req,
          { ok: false, message },
          { transport: "talos", action: "clean-protocore-logs" },
        );
      }
    },
    [settleOperation],
  );

  const runBootstrapFlow = useCallback(
    async (req: OpRequest) => {
      try {
        const status = await talosStatus();
        const host = status.nodeAddress || status.endpoint;
        if (!host || !status.configPath) {
          settleOperation(
            req,
            {
              ok: false,
              message:
                "Connect to your Monarch OS node first (a trusted talosconfig is required to bootstrap it).",
            },
            { transport: "talos", action: "bootstrap" },
          );
          return;
        }
        const boot = await talosBootstrap(host, status.configPath);
        settleOperation(
          req,
          {
            ok: true,
            message: `Talos etcd bootstrap: ${boot}. The node should leave "booting" and report ready shortly; ext-protocore keeps serving chain RPC throughout.`,
          },
          {
            transport: "talos",
            action: "bootstrap",
            endpoint: status.endpoint ?? undefined,
            nodeAddress: status.nodeAddress ?? undefined,
          },
        );
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        settleOperation(req, { ok: false, message }, { transport: "talos", action: "bootstrap" });
      }
    },
    [settleOperation],
  );

  const runTalosFlow = useCallback(async (req: OpRequest) => {
    if (req.kind === "operator-bootstrap") {
      if (inTauri()) {
        await runBootstrapFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "operator-restore") {
      if (inTauri()) {
        await runRestoreFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "operator-register") {
      if (inTauri()) {
        await runRegisterFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "redelegate") {
      if (inTauri()) {
        await runRedelegateFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "chat-bootstrap-peers") {
      if (inTauri()) {
        await runChatBootstrapPeersFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "operator-display") {
      if (inTauri()) {
        await runOperatorDisplayFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "operator-seal-key") {
      if (inTauri()) {
        await runOperatorSealKeyFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "cluster-name-register") {
      if (inTauri()) {
        await runClusterNameFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "cluster-accept-invite" || req.kind === "cluster-swap") {
      if (inTauri()) {
        await runPendingChangeFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "cluster-request-join") {
      if (inTauri()) {
        await runClusterJoinRequestFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "cluster-vote-admit") {
      if (inTauri()) {
        await runClusterVoteAdmitFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "cluster-resign") {
      if (inTauri()) {
        await runClusterResignationFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "cluster-form") {
      if (inTauri()) {
        await runClusterFormFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "cluster-update-charter") {
      if (inTauri()) {
        await runUpdateCharterFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "rotate-keys") {
      if (inTauri()) {
        await runDkgReshareFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "freeze-admission") {
      if (inTauri()) {
        await runFreezeAdmissionFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "emergency-key-rotation") {
      if (inTauri()) {
        await runEmergencyKeyRotationFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "ota-apply") {
      if (inTauri()) {
        await runOtaApplyFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "ota-rollback") {
      if (inTauri()) {
        await runOtaRollbackFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "export-backup") {
      if (inTauri()) {
        await runExportBackupFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "operator-reprovision") {
      if (inTauri()) {
        await runReprovisionFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "operator-recover-keys") {
      if (inTauri()) {
        await runRecoverKeysFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "set-log-retention") {
      if (inTauri()) {
        await runSetLogRetentionFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    if (req.kind === "clean-protocore-logs") {
      if (inTauri()) {
        await runCleanLogsFlow(req);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }
    const action = talosActionFor(req);
    if (!action) {
      const cmd = commandFor(req);
      if (cmd) {
        await runSshFlow(req, cmd);
        return;
      }
      if (inTauri()) {
        const { result, meta } = unsignedExecutionBlocked(req);
        settleOperation(req, result, meta);
      } else {
        blockBrowserExecution(req);
      }
      return;
    }

    try {
      const result = await talosServiceAction(action.service, action.action);
      settleOperation(
        req,
        {
          ok: true,
          message: summarize(result.output, `${req.title} submitted via Talos API.`),
        },
        {
          transport: "talos",
          service: action.service,
          action: action.action,
          endpoint: result.endpoint,
          nodeAddress: result.nodeAddress,
        },
      );
    } catch (err) {
      const cmd = commandFor(req);
      if (cmd && !inTauri()) {
        await runSshFlow(req, cmd);
        return;
      }
      const message = (err as Error)?.message ?? String(err);
      settleOperation(
        req,
        { ok: false, message },
        {
          transport: "talos",
          service: action.service,
          action: action.action,
        },
      );
    }
  }, [
    blockBrowserExecution,
    runClusterFormFlow,
    runUpdateCharterFlow,
    runChatBootstrapPeersFlow,
    runClusterNameFlow,
    runClusterJoinRequestFlow,
    runClusterVoteAdmitFlow,
    runClusterResignationFlow,
    runDkgReshareFlow,
    runEmergencyKeyRotationFlow,
    runExportBackupFlow,
    runFreezeAdmissionFlow,
    runOtaApplyFlow,
    runOtaRollbackFlow,
    runOperatorDisplayFlow,
    runOperatorSealKeyFlow,
    runPendingChangeFlow,
    runBootstrapFlow,
    runCleanLogsFlow,
    runRedelegateFlow,
    runRegisterFlow,
    runReprovisionFlow,
    runRecoverKeysFlow,
    runRestoreFlow,
    runSetLogRetentionFlow,
    runSshFlow,
    settleOperation,
  ]);

  const advance = useCallback(() => {
    setState((prev) => {
      if (!prev.request) return prev;
      switch (prev.stage) {
        case "preview":
          return { ...prev, stage: "auth" };
        case "auth": {
          // Dispatch the flow at most once per request. The ref guard keeps a
          // second advance (double-click / shortcut race / strict-mode double
          // updater) from submitting the same tx twice.
          if (inFlightRef.current === prev.request) return prev;
          inFlightRef.current = prev.request;
          void runTalosFlow(prev.request);
          return { ...prev, stage: "executing" };
        }
        case "executing":
          return prev;
        case "done":
        case "error":
          return prev;
        default:
          return prev;
      }
    });
  }, [runTalosFlow]);

  const setRegisterInput = useCallback(
    (patch: Partial<RegisterInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "operator-register") return s;
        const base: RegisterInput = s.request.registerInput ?? {
          endpoint: "",
          capabilities: 0,
          bondLythoshi: "0",
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, registerInput: next },
        };
      });
    },
    [],
  );

  const setRedelegateInput = useCallback(
    (patch: Partial<RedelegateInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "redelegate") return s;
        const base: RedelegateInput = s.request.redelegateInput ?? {
          fromCluster: Number.NaN,
          toCluster: Number.NaN,
          weightBps: Number.NaN,
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, redelegateInput: next },
        };
      });
    },
    [],
  );

  const setRestoreInput = useCallback(
    (patch: Partial<RestoreInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "operator-restore") return s;
        const base: RestoreInput = s.request.restoreInput ?? {
          peerIdHex: "",
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, restoreInput: next },
        };
      });
    },
    [],
  );

  const setChatBootstrapPeersInput = useCallback(
    (patch: Partial<ChatBootstrapPeersInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "chat-bootstrap-peers") return s;
        const base: ChatBootstrapPeersInput = s.request.chatBootstrapPeersInput ?? {
          peerIdHex: "",
          peers: "",
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, chatBootstrapPeersInput: next },
        };
      });
    },
    [],
  );

  const setOperatorDisplayInput = useCallback(
    (patch: Partial<OperatorDisplayInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "operator-display") return s;
        const base: OperatorDisplayInput = s.request.operatorDisplayInput ?? {
          peerIdHex: "",
          moniker: "",
          alias: "",
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, operatorDisplayInput: next },
        };
      });
    },
    [],
  );

  const setOperatorSealKeyInput = useCallback(
    (patch: Partial<OperatorSealKeyInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "operator-seal-key") return s;
        const base: OperatorSealKeyInput = s.request.operatorSealKeyInput ?? {
          peerIdHex: "",
          sealEkHex: "",
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, operatorSealKeyInput: next },
        };
      });
    },
    [],
  );

  const setClusterNameInput = useCallback(
    (patch: Partial<ClusterNameInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "cluster-name-register") return s;
        const base: ClusterNameInput = s.request.clusterNameInput ?? {
          clusterId: "",
          name: "",
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, clusterNameInput: next },
        };
      });
    },
    [],
  );

  const setPendingChangeInput = useCallback(
    (patch: Partial<PendingChangeInput>) => {
      setState((s) => {
        if (
          !s.request ||
          (s.request.kind !== "cluster-accept-invite" && s.request.kind !== "cluster-swap")
        ) {
          return s;
        }
        const defaultKind = s.request.kind === "cluster-swap" ? "rotate" : "add";
        const base: PendingChangeInput = s.request.pendingChangeInput ?? {
          kind: defaultKind,
          targetPubkeyHex: "",
          effectiveEpoch: "",
          intentId: defaultKind === "rotate" ? "" : "0",
        };
        const next = { ...base, ...patch, kind: patch.kind ?? base.kind };
        return {
          ...s,
          request: { ...s.request, pendingChangeInput: next },
        };
      });
    },
    [],
  );

  const setClusterJoinRequestInput = useCallback(
    (patch: Partial<ClusterJoinRequestInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "cluster-request-join") return s;
        const base: ClusterJoinRequestInput = s.request.clusterJoinRequestInput ?? {
          clusterId: "",
          operatorPubkeyHex: "",
          bondLythoshi: "0",
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, clusterJoinRequestInput: next },
        };
      });
    },
    [],
  );

  const setClusterVoteAdmitInput = useCallback(
    (patch: Partial<ClusterVoteAdmitInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "cluster-vote-admit") return s;
        const base: ClusterVoteAdmitInput = s.request.clusterVoteAdmitInput ?? {
          clusterId: "",
          operatorIdHex: "",
          voterPubkeyHex: "",
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, clusterVoteAdmitInput: next },
        };
      });
    },
    [],
  );

  const setClusterResignationInput = useCallback(
    (patch: Partial<ClusterResignationInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "cluster-resign") return s;
        const base: ClusterResignationInput = s.request.clusterResignationInput ?? {
          clusterId: "",
          nonce: "1",
          expedite: false,
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, clusterResignationInput: next },
        };
      });
    },
    [],
  );

  const setClusterFormInput = useCallback(
    (patch: Partial<ClusterFormInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "cluster-form") return s;
        const base: ClusterFormInput = s.request.clusterFormInput ?? {
          activePubkeysHex: "",
          standbyPubkeysHex: "",
          signaturesHex: "",
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, clusterFormInput: next },
        };
      });
    },
    [],
  );

  const setDkgReshareInput = useCallback(
    (patch: Partial<DkgReshareAttestationInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "rotate-keys") return s;
        const base: DkgReshareAttestationInput = s.request.dkgReshareInput ?? {
          intentId: "",
          consensusPublicKeysHex: "",
          thresholdSigHex: "",
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, dkgReshareInput: next },
        };
      });
    },
    [],
  );

  const setFreezeAdmissionInput = useCallback(
    (patch: Partial<FreezeAdmissionInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "freeze-admission") return s;
        const base: FreezeAdmissionInput = s.request.freezeAdmissionInput ?? {
          reasonHashHex: "",
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, freezeAdmissionInput: next },
        };
      });
    },
    [],
  );

  const setEmergencyKeyRotationInput = useCallback(
    (patch: Partial<EmergencyKeyRotationInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "emergency-key-rotation") return s;
        const base: EmergencyKeyRotationInput = s.request.emergencyKeyRotationInput ?? {
          targetPubkeyHex: "",
          effectiveEpoch: "",
          intentId: "",
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, emergencyKeyRotationInput: next },
        };
      });
    },
    [],
  );

  const setOtaApplyInput = useCallback(
    (patch: Partial<OtaApplyInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "ota-apply") return s;
        const base: OtaApplyInput = s.request.otaApplyInput ?? {
          image: "",
          stage: false,
          rebootMode: "default",
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, otaApplyInput: next },
        };
      });
    },
    [],
  );

  const setLogRetentionInput = useCallback(
    (patch: Partial<LogRetentionInput>) => {
      setState((s) => {
        if (
          !s.request ||
          (s.request.kind !== "set-log-retention" &&
            s.request.kind !== "clean-protocore-logs")
        ) {
          return s;
        }
        const base: LogRetentionInput = s.request.logRetentionInput ?? {
          maxMegabytes: DEFAULT_LOG_RETENTION.maxMegabytes,
          maxFiles: DEFAULT_LOG_RETENTION.maxFiles,
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, logRetentionInput: next },
        };
      });
    },
    [],
  );

  const setRecoverKeysInput = useCallback(
    (patch: Partial<RecoverKeysInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "operator-recover-keys") return s;
        const base: RecoverKeysInput = s.request.recoverKeysInput ?? {
          host: "",
          disk: "",
        };
        const next = { ...base, ...patch };
        return {
          ...s,
          request: { ...s.request, recoverKeysInput: next },
        };
      });
    },
    [],
  );

  const value = useMemo<OpsContextValue>(
    () => ({
      ...state,
      requestOp,
      advance,
      cancel,
      reset,
      clearReceipts,
      setRegisterInput,
      setRedelegateInput,
      setRestoreInput,
      setChatBootstrapPeersInput,
      setOperatorDisplayInput,
      setOperatorSealKeyInput,
      setClusterNameInput,
      setPendingChangeInput,
      setClusterJoinRequestInput,
      setClusterVoteAdmitInput,
      setClusterResignationInput,
      setClusterFormInput,
      setDkgReshareInput,
      setFreezeAdmissionInput,
      setEmergencyKeyRotationInput,
      setOtaApplyInput,
      setLogRetentionInput,
      setRecoverKeysInput,
    }),
    [
      state,
      requestOp,
      advance,
      cancel,
      reset,
      clearReceipts,
      setRegisterInput,
      setRedelegateInput,
      setRestoreInput,
      setChatBootstrapPeersInput,
      setOperatorDisplayInput,
      setOperatorSealKeyInput,
      setClusterNameInput,
      setPendingChangeInput,
      setClusterJoinRequestInput,
      setClusterVoteAdmitInput,
      setClusterResignationInput,
      setClusterFormInput,
      setDkgReshareInput,
      setFreezeAdmissionInput,
      setEmergencyKeyRotationInput,
      setOtaApplyInput,
      setLogRetentionInput,
      setRecoverKeysInput,
    ],
  );

  return <OpsContext.Provider value={value}>{children}</OpsContext.Provider>;
}

export function useOps(): OpsContextValue {
  const ctx = useContext(OpsContext);
  if (!ctx) {
    throw new Error("useOps must be used inside <OpsProvider>");
  }
  return ctx;
}
