import {
  normalizeAddressHex,
  type ClusterStatusResponse,
  type OperatorInfoResponse,
  type RuntimeProvenanceResponse,
} from "@monolythium/core-sdk";
import { makeRpcClient } from "./rpcTransport";
import type { OperationReceipt } from "../ops/receipts";
import { createOperationReceipt, readOperationReceipts } from "../ops/receipts";
import {
  chatGetChannels,
  chatGetMessages,
  chatInitialize,
  chatSendMessage,
  chatSubscribeChannel,
  KEYCHAIN_ACCOUNTS,
  keychainGet,
  keychainSet,
  rpcCallJson,
  rpcRuntimeProvenance,
  talosConnect,
  talosConfigInfo,
  talosProtocoreReadiness,
  talosServiceAction,
  talosStatus,
  talosTrustConfig,
} from "./bridge";
import type { ChatChannel, ChatMessage } from "./chat";
import { resolveChatBootstrapPeersForCluster } from "./chatConfig";
import { rpc, rpcEndpoint } from "./client";
import { releaseAttestationStatus } from "./releaseAttestation";
import type {
  DesktopReleaseReadinessInput,
  ReleaseChatMembershipEvidence,
} from "./releaseReadiness";

export type MonarchE2eReadinessOptions = {
  expectedChainId?: number;
  expectedRpcEndpoint?: string;
  protocoreRpcEndpoint?: string;
  expectedDigest?: string;
  talosEndpoint?: string;
  talosConfigPath?: string;
  trustTalosConfig?: boolean;
  operatorMnemonic?: string;
  chatBootstrapPeers?: string[];
  clusterId?: number;
  clusterName?: string;
  chatBody?: string;
  sendChatMessage?: boolean;
  executeRestart?: boolean;
  requireBootstrapPeers?: boolean;
};

export async function collectMonarchE2eReadiness(
  rawOptions?: unknown,
): Promise<DesktopReleaseReadinessInput> {
  const options = parseOptions(rawOptions);
  const endpoint = options.expectedRpcEndpoint ?? rpcEndpoint;
  const protocoreEndpoint = options.protocoreRpcEndpoint ?? endpoint;
  await bootstrapE2eState(options);

  const [status, config, protocore] = await Promise.all([
    talosStatus().catch(() => null),
    talosConfigInfo().catch(() => null),
    talosProtocoreReadiness(protocoreEndpoint).catch(() => null),
  ]);

  const [expectedDigest, provenance] = await Promise.all([
    resolveExpectedDigest(options),
    readRuntimeProvenance(endpoint).catch(() => null),
  ]);

  const releaseAttestation = releaseAttestationStatus({
    expectedDigest,
    service: protocore?.service ?? null,
    provenance,
    provenanceLoading: false,
    provenanceError: provenance ? null : "lyth_runtimeProvenance was unavailable during e2e collection.",
    provenanceNotExposed: provenance === null,
    rpcEndpoint: endpoint,
  });

  // Prove chat before service operations. A restart can briefly leave the
  // isolated smoke node without synced cluster registry data.
  const chat = await collectChatEvidence(options, endpoint);
  const operationReceipts = await collectOperationReceipts(options);

  return {
    expectedChainId: options.expectedChainId ?? 69420,
    expectedRpcEndpoint: endpoint,
    talosStatus: status,
    talosConfig: config,
    protocore,
    releaseAttestation,
    operationReceipts,
    requiredOperationActions: ["restart"],
    chat,
  };
}

async function bootstrapE2eState(options: MonarchE2eReadinessOptions): Promise<void> {
  if (options.operatorMnemonic) {
    await keychainSet(KEYCHAIN_ACCOUNTS.operatorMnemonic, options.operatorMnemonic);
  }
  if (options.expectedDigest) {
    await keychainSet(KEYCHAIN_ACCOUNTS.protocoreExpectedDigest, options.expectedDigest);
  }
  if (!options.talosConfigPath) return;

  let endpoint = options.talosEndpoint;
  if (!endpoint) {
    const info = await talosConfigInfo({ configPath: options.talosConfigPath });
    endpoint = info.endpoint;
  }
  if (options.trustTalosConfig) {
    await talosTrustConfig({
      endpoint,
      configPath: options.talosConfigPath,
    });
  }
  await talosConnect({
    endpoint,
    configPath: options.talosConfigPath,
  });
}

async function resolveExpectedDigest(options: MonarchE2eReadinessOptions): Promise<string> {
  if (options.expectedDigest) return options.expectedDigest;
  return await keychainGet(KEYCHAIN_ACCOUNTS.protocoreExpectedDigest).catch(() => "") ?? "";
}

async function readRuntimeProvenance(endpoint: string): Promise<RuntimeProvenanceResponse | null> {
  try {
    const bridged = await rpcRuntimeProvenance(endpoint);
    if (bridged?.runtime) return bridged;
  } catch {
    // Browser/test fallback below keeps the collector usable without Tauri IPC.
  }

  try {
    const client = trimEndpoint(endpoint) === trimEndpoint(rpcEndpoint)
      ? rpc
      : makeRpcClient(endpoint);
    return await client.lythRuntimeProvenance();
  } catch {
    return null;
  }
}

async function collectOperationReceipts(
  options: MonarchE2eReadinessOptions,
): Promise<OperationReceipt[]> {
  const existing = readOperationReceipts();
  if (options.executeRestart === false) return existing;

  try {
    const result = await talosServiceAction("ext-protocore", "restart");
    const receipt = createOperationReceipt(
      {
        kind: "operator-restart",
        title: "Graceful restart",
        sub: "Cycle ext-protocore",
        intro: "Restart the service through Talos API.",
        fields: [],
      },
      { ok: true, message: result.output.trim() || "ext-protocore restart submitted via Talos API." },
      {
        transport: "talos",
        service: "ext-protocore",
        action: "restart",
        endpoint: result.endpoint,
        nodeAddress: result.nodeAddress,
      },
    );
    return [
      receipt,
      ...existing,
    ];
  } catch (err) {
    const receipt = createOperationReceipt(
      {
        kind: "operator-restart",
        title: "Graceful restart",
        sub: "Cycle ext-protocore",
        intro: "Restart the service through Talos API.",
        fields: [],
      },
      { ok: false, message: errorMessage(err) },
      {
        transport: "talos",
        service: "ext-protocore",
        action: "restart",
      },
    );
    return [
      receipt,
      ...existing,
    ];
  }
}

async function collectChatEvidence(
  options: MonarchE2eReadinessOptions,
  endpoint: string,
): Promise<DesktopReleaseReadinessInput["chat"]> {
  const bootstrapPeers = await resolveChatBootstrapPeersForCluster({
    endpoint,
    clusterId: options.clusterId,
    configuredPeers: options.chatBootstrapPeers,
  });
  const init = await chatInitialize({
    rpcEndpoint: endpoint,
    bootstrapPeers,
  }).catch(() => null);

  let channels = await chatGetChannels().catch(() => []);
  let active = chooseActiveChannel(channels, options.clusterId);
  if (!active && typeof options.clusterId === "number") {
    active = await chatSubscribeChannel({
      clusterId: options.clusterId,
      name: options.clusterName,
    }).catch(() => null);
    channels = await chatGetChannels().catch(() => active ? [active] : []);
  }

  if (active && options.sendChatMessage !== false) {
    const sent = await chatSendMessage({
      channelId: active.channel_id,
      clusterId: active.cluster_id,
      body: options.chatBody ?? `monarch desktop e2e ${new Date().toISOString()}`,
    }).catch(() => null);
    if (sent) {
      await waitForChatMessage(active.channel_id, sent.msg_id);
    }
  }

  const rawMessages = active
    ? await chatGetMessages(active.channel_id, 100).catch(() => [])
    : [];
  const messages = normalizeMessagePerspective(rawMessages, init?.address_hex);
  const membership = await collectChatMembershipEvidence(endpoint, active, messages);

  return {
    init,
    channels,
    activeChannelId: active?.channel_id ?? null,
    messages,
    bootstrapPeers,
    requireBootstrapPeers: options.requireBootstrapPeers ?? true,
    membership,
  };
}

function normalizeMessagePerspective(
  messages: ChatMessage[],
  localAddress?: string | null,
): ChatMessage[] {
  const normalizedLocal = localAddress ? normalizeChatAddress(localAddress) : null;
  if (!normalizedLocal) return messages;
  return messages.map((message) => {
    const sender = normalizeChatAddress(message.sender_address);
    if (!sender) return message;
    return {
      ...message,
      from_me: sender === normalizedLocal,
    };
  });
}

async function collectChatMembershipEvidence(
  endpoint: string,
  active: ChatChannel | null,
  messages: Awaited<ReturnType<typeof chatGetMessages>>,
): Promise<ReleaseChatMembershipEvidence | null> {
  if (!active) return null;

  const senderAddresses = new Set(
    messages
      .filter((message) => message.channel_id === active.channel_id && message.verified)
      .map((message) => normalizeChatAddress(message.sender_address))
      .filter((address): address is string => Boolean(address)),
  );
  if (senderAddresses.size === 0) return null;

  const cluster = await readClusterStatus(endpoint, active.cluster_id).catch(() => null);
  if (!cluster) {
    return {
      source: "lyth_clusterStatus+lyth_operatorInfo",
      clusterId: active.cluster_id,
      checkedAt: new Date().toISOString(),
      membersChecked: 0,
      proofs: [],
    };
  }

  const operatorInfos = await Promise.all(
    cluster.members.map((member) =>
      readOperatorInfo(endpoint, member.operatorId)
        .then((operator) => ({ member, operator }))
        .catch(() => null),
    ),
  );

  return {
    source: "lyth_clusterStatus+lyth_operatorInfo",
    clusterId: active.cluster_id,
    checkedAt: new Date().toISOString(),
    membersChecked: cluster.members.length,
    proofs: operatorInfos
      .flatMap((entry) => {
        if (!entry) return [];
        const chainAddressHex = normalizeChatAddress(entry.operator.chainAddress);
        if (!chainAddressHex || !senderAddresses.has(chainAddressHex)) return [];
        return [{
          source: "lyth_clusterStatus+lyth_operatorInfo" as const,
          clusterId: active.cluster_id,
          senderAddress: chainAddressHex,
          operatorId: entry.member.operatorId,
          chainAddress: entry.operator.chainAddress,
          chainAddressHex,
        }];
      }),
  };
}

async function readClusterStatus(
  endpoint: string,
  clusterId: number,
): Promise<ClusterStatusResponse> {
  try {
    const raw = await rpcCallJson<ClusterStatusResponse>(endpoint, "lyth_clusterStatus", [clusterId]);
    if (isClusterStatusResponse(raw)) return raw;
  } catch {
    // The native bridge is only available in Tauri; browser/unit contexts use the SDK client below.
  }

  try {
    return await rpcForEndpoint(endpoint).lythClusterStatus(clusterId);
  } catch (directError) {
    try {
      return await rpcCallJson<ClusterStatusResponse>(endpoint, "lyth_clusterStatus", [clusterId]);
    } catch {
      throw directError;
    }
  }
}

async function readOperatorInfo(
  endpoint: string,
  operatorId: string,
): Promise<OperatorInfoResponse> {
  try {
    const raw = await rpcCallJson<OperatorInfoResponse>(endpoint, "lyth_operatorInfo", [operatorId]);
    if (isOperatorInfoResponse(raw)) return raw;
  } catch {
    // The native bridge is only available in Tauri; browser/unit contexts use the SDK client below.
  }

  try {
    return await rpcForEndpoint(endpoint).lythOperatorInfo(operatorId);
  } catch (directError) {
    try {
      return await rpcCallJson<OperatorInfoResponse>(endpoint, "lyth_operatorInfo", [operatorId]);
    } catch {
      throw directError;
    }
  }
}

async function waitForChatMessage(channelId: string, msgId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const messages = await chatGetMessages(channelId, 100).catch(() => []);
    if (messages.some((message) => message.msg_id === msgId)) return;
    await delay(250);
  }
}

function isClusterStatusResponse(value: unknown): value is ClusterStatusResponse {
  return Boolean(value && typeof value === "object" && Array.isArray((value as { members?: unknown }).members));
}

function isOperatorInfoResponse(value: unknown): value is OperatorInfoResponse {
  return Boolean(value && typeof value === "object" && typeof (value as { chainAddress?: unknown }).chainAddress === "string");
}

function chooseActiveChannel(
  channels: ChatChannel[],
  clusterId?: number,
): ChatChannel | null {
  if (typeof clusterId === "number") {
    return channels.find((channel) => channel.cluster_id === clusterId && channel.subscribed) ?? null;
  }
  return channels.find((channel) => channel.subscribed) ?? null;
}

function parseOptions(raw: unknown): MonarchE2eReadinessOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  return {
    expectedChainId: numberOption(input.expectedChainId),
    expectedRpcEndpoint: stringOption(input.expectedRpcEndpoint),
    protocoreRpcEndpoint: stringOption(input.protocoreRpcEndpoint),
    expectedDigest: stringOption(input.expectedDigest),
    talosEndpoint: stringOption(input.talosEndpoint),
    talosConfigPath: stringOption(input.talosConfigPath),
    trustTalosConfig: booleanOption(input.trustTalosConfig),
    operatorMnemonic: stringOption(input.operatorMnemonic),
    chatBootstrapPeers: stringListOption(input.chatBootstrapPeers),
    clusterId: numberOption(input.clusterId),
    clusterName: stringOption(input.clusterName),
    chatBody: stringOption(input.chatBody),
    sendChatMessage: booleanOption(input.sendChatMessage),
    executeRestart: booleanOption(input.executeRestart),
    requireBootstrapPeers: booleanOption(input.requireBootstrapPeers),
  };
}

function numberOption(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanOption(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function stringListOption(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "string") {
    const items = value
      .split(/[\s,]+/u)
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function trimEndpoint(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function rpcForEndpoint(endpoint: string): typeof rpc {
  return trimEndpoint(endpoint) === trimEndpoint(rpcEndpoint)
    ? rpc
    : makeRpcClient(endpoint) as unknown as typeof rpc;
}

function normalizeChatAddress(address: string): string | null {
  try {
    return normalizeAddressHex(address);
  } catch {
    const clean = address.trim().replace(/^0x/iu, "").toLowerCase();
    return /^[0-9a-f]{40}$/u.test(clean) ? `0x${clean}` : null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
