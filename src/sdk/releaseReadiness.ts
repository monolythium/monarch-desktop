import type { ChatChannel, ChatInitResult, ChatMessage } from "./chat";
import type {
  ProtocoreReadiness,
  TalosConfigInfo,
  TalosStatus,
} from "./bridge";
import type { ReleaseAttestationStatus } from "./releaseAttestation";
import { isAuditReadyOperationReceipt, type OperationReceipt } from "../ops/receipts";

export type ReleaseGateId =
  | "talos-identity"
  | "protocore-readiness"
  | "release-attestation"
  | "operation-receipts"
  | "chat-exchange";

export type ReleaseGate = {
  id: ReleaseGateId;
  ok: boolean;
  summary: string;
  evidence: string[];
};

export type ReleaseChatEvidence = {
  init: ChatInitResult | null;
  channels: ChatChannel[];
  activeChannelId: string | null;
  messages: ChatMessage[];
  bootstrapPeers: string[];
  requireBootstrapPeers?: boolean;
  membership: ReleaseChatMembershipEvidence | null;
};

export type ReleaseChatMembershipProofSource = "lyth_clusterStatus+lyth_operatorInfo";

export type ReleaseChatMembershipProof = {
  source: ReleaseChatMembershipProofSource;
  clusterId: number;
  senderAddress: string;
  operatorId: string;
  chainAddress: string;
  chainAddressHex: string;
};

export type ReleaseChatMembershipEvidence = {
  source: ReleaseChatMembershipProofSource;
  clusterId: number;
  checkedAt: string;
  membersChecked: number;
  proofs: ReleaseChatMembershipProof[];
};

export type DesktopReleaseReadinessInput = {
  expectedChainId?: number;
  expectedRpcEndpoint?: string;
  talosStatus: TalosStatus | null;
  talosConfig: TalosConfigInfo | null;
  protocore: ProtocoreReadiness | null;
  releaseAttestation: ReleaseAttestationStatus | null;
  operationReceipts: OperationReceipt[];
  requiredOperationActions?: Array<"start" | "stop" | "restart">;
  chat: ReleaseChatEvidence | null;
};

export type DesktopReleaseReadinessReport = {
  ok: boolean;
  gates: ReleaseGate[];
  blockers: ReleaseGate[];
};

const DEFAULT_CHAIN_ID = 69420;
const DEFAULT_REQUIRED_ACTIONS: Array<"start" | "stop" | "restart"> = ["restart"];
const TALOS_CERT_MIN_VALIDITY_DAYS = 14;

export function desktopReleaseReadiness(
  input: DesktopReleaseReadinessInput,
): DesktopReleaseReadinessReport {
  const gates = [
    talosIdentityGate(input),
    protocoreReadinessGate(input),
    releaseAttestationGate(input.releaseAttestation),
    operationReceiptGate(input),
    chatExchangeGate(input),
  ];
  return {
    ok: gates.every((gate) => gate.ok),
    gates,
    blockers: gates.filter((gate) => !gate.ok),
  };
}

function talosIdentityGate(input: DesktopReleaseReadinessInput): ReleaseGate {
  const config = input.talosConfig;
  const status = input.talosStatus;
  const evidence: string[] = [];
  if (!config) {
    return fail("talos-identity", "Talos config has not been inspected.", evidence);
  }

  evidence.push(`ca-pin=${config.caPinStatus}`);
  evidence.push(`endpoint=${config.endpoint}`);
  if (status) {
    evidence.push(`reachable=${status.reachable}`);
    evidence.push(`status-endpoint=${status.endpoint ?? "unknown"}`);
  }

  const invalidCerts = config.certificates.filter((cert) => cert.expired || cert.notYetValid);
  const missingExpiryHorizon = config.certificates.filter((cert) =>
    !Number.isFinite(cert.expiresInDays),
  );
  const expiringCerts = config.certificates.filter((cert) =>
    !cert.expired &&
    !cert.notYetValid &&
    Number.isFinite(cert.expiresInDays) &&
    cert.expiresInDays < TALOS_CERT_MIN_VALIDITY_DAYS,
  );
  const endpointInContext =
    config.endpoints.includes(config.endpoint) || config.nodes.includes(config.endpoint);
  const statusEndpointMatches =
    !status?.endpoint || sameEndpoint(status.endpoint, config.endpoint);

  if (config.caPinStatus !== "matched") {
    return fail("talos-identity", "Trusted Talos CA pin is not matched.", evidence);
  }
  if (config.certificates.length === 0) {
    return fail("talos-identity", "Talos config exposes no certificates to validate.", evidence);
  }
  if (invalidCerts.length > 0) {
    return fail(
      "talos-identity",
      `Talos config has ${invalidCerts.length} expired or not-yet-valid certificate(s).`,
      evidence,
    );
  }
  if (missingExpiryHorizon.length > 0) {
    return fail(
      "talos-identity",
      "Talos config has certificate(s) without expiry-horizon evidence.",
      evidence,
    );
  }
  if (expiringCerts.length > 0) {
    return fail(
      "talos-identity",
      `Talos config has ${expiringCerts.length} certificate(s) inside the ${TALOS_CERT_MIN_VALIDITY_DAYS}-day rotation window.`,
      evidence,
    );
  }
  if (!endpointInContext) {
    return fail("talos-identity", "Selected Talos endpoint is outside the active context.", evidence);
  }
  if (status && (!status.reachable || !statusEndpointMatches)) {
    return fail("talos-identity", "Talos status is unreachable or points at another endpoint.", evidence);
  }
  return pass("talos-identity", "Talos CA pin, endpoint, and certificates are valid.", evidence);
}

function protocoreReadinessGate(input: DesktopReleaseReadinessInput): ReleaseGate {
  const readiness = input.protocore;
  const expectedChainId = input.expectedChainId ?? DEFAULT_CHAIN_ID;
  const evidence: string[] = [];
  if (!readiness) {
    return fail("protocore-readiness", "Protocore readiness has not been checked.", evidence);
  }

  evidence.push(`state=${readiness.displayState}`);
  evidence.push(`severity=${readiness.severity}`);
  evidence.push(`chain=${readiness.chainId ?? "unknown"}`);
  evidence.push(`block=${readiness.blockNumber ?? "unknown"}`);
  evidence.push(`listening=${readiness.listening}`);
  evidence.push(`syncing=${readiness.syncing}`);

  if (readiness.service?.id !== "ext-protocore" || readiness.service.severity !== "ok") {
    return fail("protocore-readiness", "Talos service ext-protocore is not healthy.", evidence);
  }
  if (readiness.displayState !== "serving-rpc" || readiness.severity !== "ok") {
    return fail("protocore-readiness", "Protocore is not serving RPC in a healthy state.", evidence);
  }
  if (readiness.chainId !== expectedChainId) {
    return fail("protocore-readiness", `Protocore chain id is not ${expectedChainId}.`, evidence);
  }
  if (typeof readiness.blockNumber !== "number" || readiness.blockNumber < 0) {
    return fail("protocore-readiness", "Protocore block number is unavailable.", evidence);
  }
  if (!readiness.clientVersion) {
    return fail("protocore-readiness", "Protocore client version is unavailable.", evidence);
  }
  if (readiness.listening !== true) {
    return fail("protocore-readiness", "Protocore P2P listener is not confirmed.", evidence);
  }
  if (readiness.syncing !== false) {
    return fail("protocore-readiness", "Protocore has not reported eth_syncing=false.", evidence);
  }
  return pass("protocore-readiness", "Protocore service and RPC readiness are healthy.", evidence);
}

function releaseAttestationGate(
  status: ReleaseAttestationStatus | null,
): ReleaseGate {
  const evidence = status ? [`status=${status.text}`, status.title] : [];
  if (!status) {
    return fail("release-attestation", "Release digest attestation has not been evaluated.", evidence);
  }
  if (!status.className.includes("halo--ok") || !/matched/i.test(status.text)) {
    return fail("release-attestation", "Live runtime digest does not match the expected release digest.", evidence);
  }
  return pass("release-attestation", "Live runtime digest matches the expected release digest.", evidence);
}

function operationReceiptGate(input: DesktopReleaseReadinessInput): ReleaseGate {
  const required = input.requiredOperationActions ?? DEFAULT_REQUIRED_ACTIONS;
  const evidence = input.operationReceipts.map((receipt) =>
    `${receipt.kind}:${receipt.status}:${receipt.transport}:${receipt.service ?? "none"}:${receipt.action ?? "none"}:${receipt.auditPayloadHash ?? "no-audit-hash"}`,
  );

  const missing = required.filter((action) => {
    const kind = opKindForAction(action);
    return !input.operationReceipts.some((receipt) =>
      receipt.kind === kind &&
      receipt.status === "ok" &&
      receipt.transport === "talos" &&
      receipt.service === "ext-protocore" &&
      receipt.action === action &&
      Boolean(receipt.endpoint) &&
      Boolean(receipt.nodeAddress) &&
      isAuditReadyOperationReceipt(receipt),
    );
  });

  if (missing.length > 0) {
    return fail(
      "operation-receipts",
      `Missing audit-ready successful Talos receipt(s) for: ${missing.join(", ")}.`,
      evidence,
    );
  }
  return pass("operation-receipts", "Required Talos operations produced terminal receipts.", evidence);
}

function chatExchangeGate(input: DesktopReleaseReadinessInput): ReleaseGate {
  const chat = input.chat;
  const expectedRpcEndpoint = input.expectedRpcEndpoint;
  const evidence: string[] = [];
  if (!chat) {
    return fail("chat-exchange", "Chat evidence has not been collected.", evidence);
  }

  evidence.push(`bootstrap-peers=${chat.bootstrapPeers.length}`);
  evidence.push(`channels=${chat.channels.length}`);
  evidence.push(`messages=${chat.messages.length}`);

  const active = chat.channels.find((channel) => channel.channel_id === chat.activeChannelId);
  const requireBootstrapPeers = chat.requireBootstrapPeers ?? true;
  const activeVerifiedMessages = chat.messages.filter((message) =>
    isSignedActiveChatMessage(message, active),
  );
  const distinctSenders = new Set(activeVerifiedMessages.map((message) =>
    normalizeHex(message.sender_address),
  ));
  const ownSenders = new Set(activeVerifiedMessages
    .filter((message) => message.from_me)
    .map((message) => normalizeHex(message.sender_address)));
  const peerSenders = new Set(activeVerifiedMessages
    .filter((message) => message.from_me === false)
    .map((message) => normalizeHex(message.sender_address)));
  const allActiveAndVerified = chat.messages.every((message) =>
    isSignedActiveChatMessage(message, active),
  );
  const localAddress = chat.init?.address_hex ? normalizeHex(chat.init.address_hex) : "";
  const perspectiveMatchesIdentity = Boolean(localAddress) && activeVerifiedMessages.every((message) =>
    (normalizeHex(message.sender_address) === localAddress) === message.from_me,
  );

  evidence.push(`verified-active-messages=${activeVerifiedMessages.length}`);
  evidence.push(`verified-senders=${distinctSenders.size}`);
  evidence.push(`own-senders=${ownSenders.size}`);
  evidence.push(`peer-senders=${peerSenders.size}`);
  evidence.push(`membership-source=${chat.membership?.source ?? "missing"}`);
  evidence.push(`membership-proofs=${chat.membership?.proofs.length ?? 0}`);

  if (!chat.init?.address_hex || !chat.init.public_key_hex) {
    return fail("chat-exchange", "Chat identity has not initialized.", evidence);
  }
  if (expectedRpcEndpoint && !sameEndpoint(chat.init.rpc_endpoint, expectedRpcEndpoint)) {
    return fail("chat-exchange", "Chat initialized against a different RPC endpoint.", evidence);
  }
  if (requireBootstrapPeers && chat.bootstrapPeers.length === 0) {
    return fail("chat-exchange", "Chat bootstrap peers are not configured.", evidence);
  }
  if (!isSubscribedClusterChannel(active)) {
    return fail("chat-exchange", "No subscribed active cluster channel is selected.", evidence);
  }
  if (!allActiveAndVerified) {
    return fail("chat-exchange", "Chat history contains stale, unsigned, or unverified messages.", evidence);
  }
  if (activeVerifiedMessages.length < 2) {
    return fail("chat-exchange", "Chat has not proved a two-party signed exchange.", evidence);
  }
  if (distinctSenders.size < 2) {
    return fail("chat-exchange", "Chat has not proved two distinct signed operator identities.", evidence);
  }
  if (ownSenders.size === 0 || peerSenders.size === 0) {
    return fail("chat-exchange", "Chat has not proved both local and peer signed messages.", evidence);
  }
  if (!perspectiveMatchesIdentity) {
    return fail("chat-exchange", "Chat message perspective does not match the initialized identity.", evidence);
  }
  if (!chat.membership) {
    return fail(
      "chat-exchange",
      "Chat sender membership has not been proven against the cluster registry.",
      evidence,
    );
  }
  if (!chatMembershipCoversSenders(chat.membership, active, distinctSenders)) {
    return fail(
      "chat-exchange",
      "Chat sender membership proof does not cover every signed sender.",
      evidence,
    );
  }
  return pass("chat-exchange", "Chat initialized and recorded a verified two-party exchange.", evidence);
}

function chatMembershipCoversSenders(
  membership: ReleaseChatMembershipEvidence,
  active: ChatChannel | undefined,
  senders: Set<string>,
): boolean {
  if (!active || membership.source !== "lyth_clusterStatus+lyth_operatorInfo") return false;
  if (membership.clusterId !== active.cluster_id) return false;
  if (!membership.checkedAt || Number.isNaN(Date.parse(membership.checkedAt))) return false;
  if (!Number.isFinite(membership.membersChecked) || membership.membersChecked < senders.size) {
    return false;
  }

  const covered = new Set<string>();
  for (const proof of membership.proofs) {
    if (proof.source !== membership.source || proof.clusterId !== active.cluster_id) continue;
    if (!isHexBytes(proof.operatorId, 32)) continue;
    const sender = normalizeHex(proof.senderAddress);
    const chainAddress = normalizeHex(proof.chainAddressHex);
    if (!isAddressHex(sender) || !isAddressHex(chainAddress) || sender !== chainAddress) continue;
    covered.add(sender);
  }

  for (const sender of senders) {
    if (!covered.has(sender)) return false;
  }
  return true;
}

function isSubscribedClusterChannel(channel: ChatChannel | undefined): boolean {
  return Boolean(
    channel?.subscribed &&
    channel.kind === "cluster" &&
    Number.isFinite(channel.cluster_id) &&
    channel.channel_id === clusterChannelId(channel.cluster_id),
  );
}

function clusterChannelId(clusterId: number): string {
  return `cluster-${clusterId}`;
}

function isSignedActiveChatMessage(
  message: ChatMessage,
  active: ChatChannel | undefined,
): boolean {
  return Boolean(
    active &&
    message.channel_id === active.channel_id &&
    message.cluster_id === active.cluster_id &&
    message.verified &&
    isHexBytes(message.msg_id, 32) &&
    isHexBytes(message.signature_hex) &&
    isHexBytes(message.sender_pubkey_hex) &&
    isHexBytes(message.nonce_hex) &&
    isAddressHex(message.sender_address) &&
    message.body.trim().length > 0 &&
    Number.isFinite(message.timestamp_ms) &&
    typeof message.from_me === "boolean",
  );
}

function isAddressHex(value: string): boolean {
  return /^[0-9a-f]{40}$/u.test(normalizeHex(value));
}

function isHexBytes(value: string, byteLength?: number): boolean {
  const hex = normalizeHex(value);
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(hex)) return false;
  return typeof byteLength === "number" ? hex.length === byteLength * 2 : true;
}

function normalizeHex(value: string): string {
  return value.trim().replace(/^0x/iu, "").toLowerCase();
}

function opKindForAction(action: "start" | "stop" | "restart") {
  switch (action) {
    case "start":
      return "operator-start";
    case "stop":
      return "operator-stop";
    case "restart":
      return "operator-restart";
  }
}

function sameEndpoint(a: string, b: string): boolean {
  return trimEndpoint(a) === trimEndpoint(b);
}

function trimEndpoint(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function pass(id: ReleaseGateId, summary: string, evidence: string[]): ReleaseGate {
  return { id, ok: true, summary, evidence };
}

function fail(id: ReleaseGateId, summary: string, evidence: string[]): ReleaseGate {
  return { id, ok: false, summary, evidence };
}
