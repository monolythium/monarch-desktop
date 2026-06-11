// Live diff preview for the Operations drawer. Computes the diff rows
// from the ACTUAL in-flight form values (request.*Input) instead of the
// static catalog placeholder strings, so the operator confirms what they
// really typed (real endpoint, real bond in LYTH, real cluster ids).
//
// Pure and side-effect free — unit-tested in liveDiff.test.ts. Returns
// null when the request kind has no live inputs (or none are set yet);
// the drawer then falls back to the static catalog diff.

import { formatLyth } from "@monolythium/core-sdk";
import { clusterFormProposalSummary } from "./ClusterFormProposalForm";
import type { OpField, OpRequest } from "./types";

function compactHex(value: string, head = 14, tail = 10): string {
  if (!value || value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function lythLabel(lythoshi: string | undefined): string {
  if (!lythoshi) return "—";
  try {
    return formatLyth(BigInt(lythoshi));
  } catch {
    return lythoshi;
  }
}

function clusterTag(id: number | string): string {
  const n = typeof id === "string" ? Number.parseInt(id, 10) : id;
  if (!Number.isFinite(n)) return String(id);
  return `C-${String(Math.trunc(n)).padStart(3, "0")}`;
}

function row(key: string, label: string, value: string): OpField {
  return { key, label, value };
}

/**
 * Diff rows derived from the live form values. Null = no live inputs
 * for this kind → caller falls back to the static catalog diff/fields.
 */
export function liveDiffRows(request: OpRequest): OpField[] | null {
  switch (request.kind) {
    case "operator-register": {
      const input = request.registerInput;
      if (!input) return null;
      const caps = input.capabilities;
      return [
        row("endpoint", "Endpoint", input.endpoint.trim() || "(not set)"),
        row(
          "capabilities",
          "Capabilities",
          caps > 0 ? `0x${caps.toString(16).padStart(4, "0")}` : "(none selected)",
        ),
        row("bond", "Bond", `+ ${lythLabel(input.bondLythoshi)} locked`),
      ];
    }
    case "redelegate": {
      const input = request.redelegateInput;
      if (!input) return null;
      const weight = Number.isFinite(input.weightBps)
        ? `${(input.weightBps / 100).toFixed(2)}%`
        : "(not set)";
      return [
        row(
          "route",
          "Delegation",
          `${Number.isFinite(input.fromCluster) ? clusterTag(input.fromCluster) : "(from?)"} → ${Number.isFinite(input.toCluster) ? clusterTag(input.toCluster) : "(to?)"}`,
        ),
        row("weight", "Weight moved", weight),
      ];
    }
    case "operator-display": {
      const input = request.operatorDisplayInput;
      if (!input) return null;
      return [
        row("peer", "Operator id", input.peerIdHex ? compactHex(input.peerIdHex) : "(not set)"),
        row("moniker", "Moniker", input.moniker.trim() || "(cleared)"),
        row("alias", "Alias", input.alias.trim() || "(cleared)"),
      ];
    }
    case "operator-seal-key": {
      const input = request.operatorSealKeyInput;
      if (!input) return null;
      const ekBytes = Math.floor(input.sealEkHex.replace(/^0x/iu, "").length / 2);
      return [
        row("peer", "Operator id", input.peerIdHex ? compactHex(input.peerIdHex) : "(not set)"),
        row("seal", "Seal EK", ekBytes > 0 ? `+ ${ekBytes.toLocaleString()}-byte public key` : "(not set)"),
      ];
    }
    case "chat-bootstrap-peers": {
      const input = request.chatBootstrapPeersInput;
      if (!input) return null;
      const peers = input.peers.split(/[\s,]+/u).filter(Boolean);
      return [
        row("peer", "Operator id", input.peerIdHex ? compactHex(input.peerIdHex) : "(not set)"),
        row("peers", "Chat peers", peers.length > 0 ? `+ ${peers.length} multiaddr${peers.length === 1 ? "" : "s"}` : "(not set)"),
      ];
    }
    case "cluster-name-register": {
      const input = request.clusterNameInput;
      if (!input) return null;
      return [
        row("cluster", "Cluster", input.clusterId ? clusterTag(input.clusterId) : "(not set)"),
        row("name", "Name", input.name.trim() || "(not set)"),
      ];
    }
    case "cluster-request-join": {
      const input = request.clusterJoinRequestInput;
      if (!input) return null;
      return [
        row("cluster", "Cluster", input.clusterId ? clusterTag(input.clusterId) : "(not set)"),
        row("pubkey", "Your consensus key", input.operatorPubkeyHex ? compactHex(input.operatorPubkeyHex) : "(not set)"),
        row("bond", "Bond attached", lythLabel(input.bondLythoshi)),
      ];
    }
    case "cluster-vote-admit": {
      const input = request.clusterVoteAdmitInput;
      if (!input) return null;
      return [
        row("cluster", "Cluster", input.clusterId ? clusterTag(input.clusterId) : "(not set)"),
        row("candidate", "Candidate", input.operatorIdHex ? compactHex(input.operatorIdHex) : "(not set)"),
        row("vote", "Vote", "+ 1 admit vote from your seat"),
      ];
    }
    case "cluster-resign": {
      const input = request.clusterResignationInput;
      if (!input) return null;
      return [
        row("membership", "Membership", "- your cluster seat (queued)"),
        row("nonce", "Resignation nonce", input.nonce || "(not set)"),
        row("expedite", "Foundation expedite", input.expedite ? "requested" : "off"),
      ];
    }
    case "cluster-form": {
      const input = request.clusterFormInput;
      if (!input) return null;
      const summary = clusterFormProposalSummary(input);
      return [
        row(
          "roster",
          "Roster",
          `${summary.activeCount} active + ${summary.standbyCount} standby (${summary.signatureCount} consents)`,
        ),
        ...(input.charterHex
          ? [
              row(
                "charter",
                "Charter (V2)",
                summary.charter
                  ? `delegators ${(summary.charter.delegatorShareBps / 100).toFixed(1)}% · consent expires ${new Date(summary.charter.expiresMs).toISOString()}`
                  : "(malformed charter)",
              ),
            ]
          : []),
        row(
          "digest",
          "Consent digest",
          summary.consentMessageHex ? compactHex(summary.consentMessageHex, 18, 12) : "(roster incomplete)",
        ),
      ];
    }
    case "rotate-keys": {
      const input = request.dkgReshareInput;
      if (!input) return null;
      const keys = input.consensusPublicKeysHex.split(/[\s,]+/u).filter(Boolean);
      return [
        row("intent", "Rotate intent", input.intentId || "(not set)"),
        row("signers", "Ceremony signers", keys.length > 0 ? String(keys.length) : "(not set)"),
      ];
    }
    case "cluster-accept-invite":
    case "cluster-swap": {
      const input = request.pendingChangeInput;
      if (!input) return null;
      return [
        row("kind", "Pending change", input.kind),
        row("target", "Target key", input.targetPubkeyHex ? compactHex(input.targetPubkeyHex) : "(not set)"),
        row("epoch", "Effective epoch", input.effectiveEpoch || "(not set)"),
        row("intent", "Intent id", input.intentId || "0"),
      ];
    }
    case "freeze-admission": {
      const input = request.freezeAdmissionInput;
      if (!input) return null;
      return [
        row("admission", "Admission", "frozen"),
        row("reason", "Reason hash", input.reasonHashHex ? compactHex(input.reasonHashHex) : "(not set)"),
      ];
    }
    case "emergency-key-rotation": {
      const input = request.emergencyKeyRotationInput;
      if (!input) return null;
      return [
        row("target", "Target key", input.targetPubkeyHex ? compactHex(input.targetPubkeyHex) : "(not set)"),
        row("epoch", "Effective epoch", input.effectiveEpoch || "(not set)"),
        row("intent", "Intent id", input.intentId || "(not set)"),
      ];
    }
    case "operator-restore": {
      const input = request.restoreInput;
      if (!input) return null;
      return [
        row("peer", "Operator id", input.peerIdHex ? compactHex(input.peerIdHex) : "(not set)"),
        row("status", "Status", "+ foundation recovery tx"),
      ];
    }
    case "ota-apply": {
      const input = request.otaApplyInput;
      if (!input) return null;
      return [
        row("image", "Image", input.image.trim() || "(not set)"),
        row("stage", "Stage only", input.stage ? "yes (no reboot now)" : "no (reboots after accept)"),
        row("preserve", "Chain data", "preserved"),
      ];
    }
    default:
      return null;
  }
}
