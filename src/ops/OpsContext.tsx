// Operations drawer context — every destructive action goes through here.
// The drawer is a dedicated right-side panel (not a modal). State machine:
//   preview  — operator sees the planned diff before any signing
//   auth     — hand-off to the OS keychain for signing (no separate passkey)
//   executing— RPC submitted, awaiting receipt
//   done     — terminal success or error state, ack to dismiss
//
// Monarch OS service verbs route through Talos API mTLS. SSH remains a
// development fallback for plain Linux hosts where the Talos path is
// not available. Browser preview and unsupported verbs never produce
// success receipts; they are blocked until a live control channel exists.
//
// Verbs with dedicated chain/Talos helpers run before `commandFor(op)`;
// verbs that still lack a TPM/ledger/keychain/foundation path stay
// blocked in Tauri instead of falling back to shell execution.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
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
  talosExportProtocoreBackup,
  talosRollback,
  talosServiceAction,
  talosUpgrade,
} from "../sdk";
import { submitChatBootstrapPeers } from "../sdk/chatPeerOps";
import {
  submitRequestClusterJoin,
  submitVoteClusterAdmit,
} from "../sdk/clusterJoinOps";
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
  browserExecutionBlocked,
  clusterFormExecutionBlocked,
  clusterJoinExecutionBlocked,
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
  ClusterFormInput,
  ClusterJoinRequestInput,
  ClusterVoteAdmitInput,
  OtaApplyInput,
  PendingChangeInput,
  RedelegateInput,
  RegisterInput,
  RestoreInput,
} from "./types";

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
  /** Update the pending-change request payload for cluster invite/swap. */
  setPendingChangeInput: (patch: Partial<PendingChangeInput>) => void;
  /** Update the CJ-1 join request payload. */
  setClusterJoinRequestInput: (patch: Partial<ClusterJoinRequestInput>) => void;
  /** Update the CJ-1 admit vote payload. */
  setClusterVoteAdmitInput: (patch: Partial<ClusterVoteAdmitInput>) => void;
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
    setState((prev) => ({
      request: op,
      stage: "preview",
      result: null,
      open: true,
      receipts: prev.receipts,
    }));
  }, []);

  const cancel = useCallback(() => {
    setState((prev) => ({ ...prev, open: false }));
    // Detach request after the slide-out finishes so the body doesn't flash empty.
    window.setTimeout(
      () => setState((prev) => ({ ...initialState, receipts: prev.receipts })),
      360,
    );
  }, []);

  const reset = useCallback(() => {
    setState((prev) => ({ ...initialState, receipts: prev.receipts }));
  }, []);

  const clearReceipts = useCallback(() => {
    setState((prev) => ({ ...prev, receipts: clearOperationReceipts() }));
  }, []);

  const blockBrowserExecution = useCallback((req: OpRequest) => {
    const { result, meta } = browserExecutionBlocked(req);
    settleOperation(req, result, meta);
  }, [settleOperation]);

  const blockClusterJoinExecution = useCallback((req: OpRequest) => {
    const { result, meta } = clusterJoinExecutionBlocked(req);
    settleOperation(req, result, meta);
  }, [settleOperation]);

  const blockClusterFormExecution = useCallback((req: OpRequest) => {
    const { result, meta } = clusterFormExecutionBlocked(req);
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
      // No-session falls back only in the browser preview path. Any
      // other error surfaces verbatim — the operator needs to see why
      // a real host call failed.
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
              message:
                "Operator mnemonic not in keychain. Store it under monarch-desktop/operator:mnemonic first.",
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
              message:
                "Operator mnemonic not in keychain. Store it under monarch-desktop/operator:mnemonic first.",
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
              message:
                "Operator mnemonic not in keychain. Store it under monarch-desktop/operator:mnemonic before submitting setChatBootstrapPeers.",
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
              message:
                "Foundation operations mnemonic not in keychain. Store it in Operator settings before submitting recoverOperatorNode.",
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
              message:
                "Foundation signer mnemonic not in keychain. Store it in Operator settings before submitting submitPendingChange.",
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
              message:
                "Operator mnemonic not in keychain. Store it under monarch-desktop/operator:mnemonic before submitting requestClusterJoin.",
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
              message:
                "Operator mnemonic not in keychain. Store it under monarch-desktop/operator:mnemonic before submitting voteClusterAdmit.",
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
              message:
                "Operator mnemonic not in keychain. Store it under monarch-desktop/operator:mnemonic before submitting attestDkgReshare.",
            },
            { transport: "dkg-reshare-tx" },
          );
          return;
        }
        const res = await submitDkgReshareAttestation({
          rpcUrl: rpcEndpoint,
          mnemonic,
          intentId: input.intentId,
          blsPublicKeysHex: input.blsPublicKeysHex,
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
              message:
                "Foundation signer mnemonic not in keychain. Store it in Operator settings before submitting freezeAdmission.",
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
              message:
                "Foundation signer mnemonic not in keychain. Store it in Operator settings before submitting emergencyKeyRotation.",
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

  const runTalosFlow = useCallback(async (req: OpRequest) => {
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
        blockClusterJoinExecution(req);
      }
      return;
    }
    if (req.kind === "cluster-vote-admit") {
      if (inTauri()) {
        await runClusterVoteAdmitFlow(req);
      } else {
        blockClusterJoinExecution(req);
      }
      return;
    }
    if (req.kind === "cluster-form") {
      blockClusterFormExecution(req);
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
    blockClusterFormExecution,
    blockClusterJoinExecution,
    runChatBootstrapPeersFlow,
    runClusterJoinRequestFlow,
    runClusterVoteAdmitFlow,
    runDkgReshareFlow,
    runEmergencyKeyRotationFlow,
    runExportBackupFlow,
    runFreezeAdmissionFlow,
    runOtaApplyFlow,
    runOtaRollbackFlow,
    runPendingChangeFlow,
    runRedelegateFlow,
    runRegisterFlow,
    runRestoreFlow,
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

  const setClusterFormInput = useCallback(
    (patch: Partial<ClusterFormInput>) => {
      setState((s) => {
        if (!s.request || s.request.kind !== "cluster-form") return s;
        const base: ClusterFormInput = s.request.clusterFormInput ?? {
          activePubkeysHex: "",
          standbyPubkeysHex: "",
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
          blsPublicKeysHex: "",
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
      setPendingChangeInput,
      setClusterJoinRequestInput,
      setClusterVoteAdmitInput,
      setClusterFormInput,
      setDkgReshareInput,
      setFreezeAdmissionInput,
      setEmergencyKeyRotationInput,
      setOtaApplyInput,
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
      setPendingChangeInput,
      setClusterJoinRequestInput,
      setClusterVoteAdmitInput,
      setClusterFormInput,
      setDkgReshareInput,
      setFreezeAdmissionInput,
      setEmergencyKeyRotationInput,
      setOtaApplyInput,
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
