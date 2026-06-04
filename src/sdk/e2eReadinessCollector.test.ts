import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChannel, ChatMessage } from "./chat";

vi.mock("@monolythium/core-sdk", () => ({
  RpcClient: vi.fn(() => ({
    lythRuntimeProvenance: vi.fn().mockResolvedValue({
      runtime: { binarySha256: "sha256:other-endpoint" },
    }),
    lythClusterStatus: vi.fn(),
    lythOperatorInfo: vi.fn(),
  })),
  normalizeAddressHex: (address: string) => {
    const trimmed = address.trim();
    if (trimmed === "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at") {
      return "0x1111111111111111111111111111111111111111";
    }
    if (/^0x[0-9a-fA-F]{40}$/u.test(trimmed)) return trimmed.toLowerCase();
    throw new Error("bad address");
  },
}));

vi.mock("./bridge", () => ({
  KEYCHAIN_ACCOUNTS: {
    protocoreExpectedDigest: "monarch.protocoreExpectedDigest",
    operatorMnemonic: "operator:mnemonic",
  },
  chatGetChannels: vi.fn(),
  chatGetMessages: vi.fn(),
  chatInitialize: vi.fn(),
  chatSendMessage: vi.fn(),
  chatSubscribeChannel: vi.fn(),
  keychainGet: vi.fn(),
  keychainSet: vi.fn(),
  talosConnect: vi.fn(),
  talosConfigInfo: vi.fn(),
  talosProtocoreReadiness: vi.fn(),
  talosServiceAction: vi.fn(),
  talosStatus: vi.fn(),
  talosTrustConfig: vi.fn(),
}));

vi.mock("./chatConfig", () => ({
  resolveChatBootstrapPeers: vi.fn(() => ["/ip4/127.0.0.1/tcp/7001/p2p/peer"]),
  resolveChatBootstrapPeersForCluster: vi.fn(async (options?: { configuredPeers?: string[] }) =>
    options?.configuredPeers ?? ["/ip4/127.0.0.1/tcp/7001/p2p/peer"],
  ),
}));

vi.mock("./client", () => ({
  rpc: {
    lythRuntimeProvenance: vi.fn(),
    lythClusterStatus: vi.fn(),
    lythOperatorInfo: vi.fn(),
  },
  rpcEndpoint: "https://rpc.monolythium.test",
}));

vi.mock("./releaseAttestation", () => ({
  releaseAttestationStatus: vi.fn(() => ({
    className: "halo halo--ok",
    text: "matched",
    title: "Runtime digest matched",
    expectedDigest: "expected",
    liveDigest: "expected",
  })),
}));

import {
  chatGetChannels,
  chatGetMessages,
  chatInitialize,
  chatSendMessage,
  chatSubscribeChannel,
  keychainGet,
  keychainSet,
  talosConnect,
  talosConfigInfo,
  talosProtocoreReadiness,
  talosServiceAction,
  talosStatus,
  talosTrustConfig,
} from "./bridge";
import { rpc } from "./client";
import { resolveChatBootstrapPeersForCluster } from "./chatConfig";
import { collectMonarchE2eReadiness } from "./e2eReadinessCollector";
import { releaseAttestationStatus } from "./releaseAttestation";

const activeChannel: ChatChannel = {
  channel_id: "cluster-42",
  name: "Cluster C-042",
  sub: "cluster-42 signed",
  kind: "cluster",
  cluster_id: 42,
  subscribed: true,
};

const ownMessage: ChatMessage = {
  msg_id: "0x" + "a".repeat(64),
  channel_id: "cluster-42",
  cluster_id: 42,
  sender_address: "0x1111111111111111111111111111111111111111",
  sender_pubkey_hex: "0x" + "c".repeat(64),
  body: "hello",
  timestamp_ms: 1,
  nonce_hex: "0x" + "d".repeat(32),
  signature_hex: "aa",
  verified: true,
  from_me: true,
};

const peerMessage: ChatMessage = {
  msg_id: "0x" + "b".repeat(64),
  channel_id: "cluster-42",
  cluster_id: 42,
  sender_address: "0x2222222222222222222222222222222222222222",
  sender_pubkey_hex: "0x" + "e".repeat(64),
  body: "ack",
  timestamp_ms: 2,
  nonce_hex: "0x" + "f".repeat(32),
  signature_hex: "bb",
  verified: true,
  from_me: false,
};

describe("collectMonarchE2eReadiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(talosStatus).mockResolvedValue({
      reachable: true,
      endpoint: "https://talos.monolythium.test",
    } as never);
    vi.mocked(talosConfigInfo).mockResolvedValue({
      endpoint: "https://talos.monolythium.test",
      endpoints: ["https://talos.monolythium.test"],
      nodes: ["https://talos.monolythium.test"],
      caPinStatus: "matched",
      certificates: [],
    } as never);
    vi.mocked(talosProtocoreReadiness).mockResolvedValue({
      service: { id: "ext-protocore", severity: "ok" },
    } as never);
    vi.mocked(talosServiceAction).mockResolvedValue({
      output: "restart submitted",
      endpoint: "https://talos.monolythium.test",
      nodeAddress: "10.0.0.2",
    } as never);
    vi.mocked(talosConnect).mockResolvedValue({
      reachable: true,
      endpoint: "https://talos.monolythium.test",
    } as never);
    vi.mocked(talosTrustConfig).mockResolvedValue({
      endpoint: "https://talos.monolythium.test",
      caPinStatus: "matched",
    } as never);
    vi.mocked(keychainSet).mockResolvedValue(undefined as never);
    vi.mocked(keychainGet).mockResolvedValue("sha256:expected" as never);
    vi.mocked(rpc.lythRuntimeProvenance).mockResolvedValue({
      runtime: { binarySha256: "sha256:expected" },
    } as never);
    vi.mocked(rpc.lythClusterStatus).mockResolvedValue({
      clusterId: 42,
      threshold: 7,
      size: 10,
      live: 10,
      lagging: 0,
      offline: 0,
      maintenance: 0,
      members: [
        { operatorId: "0x" + "c".repeat(64), blsPubkey: "0x" + "a".repeat(96), state: "nominal" },
        { operatorId: "0x" + "d".repeat(64), blsPubkey: "0x" + "b".repeat(96), state: "nominal" },
      ],
      epoch: 1n,
      round: 1n,
      quorum: "7/10",
      reputationScore: null,
      livenessScore: null,
      lastUpdateHeight: 42n,
    } as never);
    vi.mocked(rpc.lythOperatorInfo)
      .mockResolvedValueOnce({
        operatorId: "0x" + "c".repeat(64),
        chainAddress: "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at",
      } as never)
      .mockResolvedValueOnce({
        operatorId: "0x" + "d".repeat(64),
        chainAddress: "0x2222222222222222222222222222222222222222",
      } as never);
    vi.mocked(chatInitialize).mockResolvedValue({
      address_hex: "0x1111111111111111111111111111111111111111",
      public_key_hex: "abcd",
      rpc_endpoint: "https://rpc.monolythium.test",
    } as never);
    vi.mocked(chatGetChannels)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([activeChannel] as never);
    vi.mocked(chatSubscribeChannel).mockResolvedValue(activeChannel as never);
    vi.mocked(chatSendMessage).mockResolvedValue(ownMessage as never);
    vi.mocked(chatGetMessages).mockResolvedValue([ownMessage, peerMessage] as never);
  });

  it("collects live Talos, attestation, operation, and chat evidence", async () => {
    const readiness = await collectMonarchE2eReadiness({
      expectedChainId: 69420,
      expectedDigest: "sha256:expected",
      talosEndpoint: "https://talos.monolythium.test",
      talosConfigPath: "/tmp/talosconfig",
      trustTalosConfig: true,
      operatorMnemonic: "abandon ".repeat(23).trim(),
      chatBootstrapPeers: "/ip4/127.0.0.1/tcp/7100/p2p/peer-a,/ip4/127.0.0.1/tcp/7101/p2p/peer-b",
      clusterId: 42,
      chatBody: "hello",
    });

    expect(keychainSet).toHaveBeenCalledWith(
      "operator:mnemonic",
      "abandon ".repeat(23).trim(),
    );
    expect(keychainSet).toHaveBeenCalledWith(
      "monarch.protocoreExpectedDigest",
      "sha256:expected",
    );
    expect(talosTrustConfig).toHaveBeenCalledWith({
      endpoint: "https://talos.monolythium.test",
      configPath: "/tmp/talosconfig",
    });
    expect(talosConnect).toHaveBeenCalledWith({
      endpoint: "https://talos.monolythium.test",
      configPath: "/tmp/talosconfig",
    });
    expect(talosProtocoreReadiness).toHaveBeenCalledWith("https://rpc.monolythium.test");
    expect(releaseAttestationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ expectedDigest: "sha256:expected" }),
    );
    expect(talosServiceAction).toHaveBeenCalledWith("ext-protocore", "restart");
    expect(resolveChatBootstrapPeersForCluster).toHaveBeenCalledWith({
      endpoint: "https://rpc.monolythium.test",
      clusterId: 42,
      configuredPeers: [
        "/ip4/127.0.0.1/tcp/7100/p2p/peer-a",
        "/ip4/127.0.0.1/tcp/7101/p2p/peer-b",
      ],
    });
    expect(chatInitialize).toHaveBeenCalledWith({
      rpcEndpoint: "https://rpc.monolythium.test",
      bootstrapPeers: [
        "/ip4/127.0.0.1/tcp/7100/p2p/peer-a",
        "/ip4/127.0.0.1/tcp/7101/p2p/peer-b",
      ],
    });
    expect(chatSubscribeChannel).toHaveBeenCalledWith({ clusterId: 42, name: undefined });
    expect(chatSendMessage).toHaveBeenCalledWith({
      channelId: "cluster-42",
      clusterId: 42,
      body: "hello",
    });
    const receipt = readiness.operationReceipts[0];
    expect(receipt).toBeDefined();
    expect(receipt).toMatchObject({
      kind: "operator-restart",
      status: "ok",
      transport: "talos",
      service: "ext-protocore",
      action: "restart",
      endpoint: "https://talos.monolythium.test",
      nodeAddress: "10.0.0.2",
      auditPayloadSchema: "monarch-desktop-operation-receipt/v1",
    });
    expect(receipt!.auditPayloadHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(readiness.chat).toMatchObject({
      activeChannelId: "cluster-42",
      bootstrapPeers: [
        "/ip4/127.0.0.1/tcp/7100/p2p/peer-a",
        "/ip4/127.0.0.1/tcp/7101/p2p/peer-b",
      ],
      messages: [ownMessage, peerMessage],
      membership: {
        source: "lyth_clusterStatus+lyth_operatorInfo",
        clusterId: 42,
        membersChecked: 2,
        proofs: [
          {
            source: "lyth_clusterStatus+lyth_operatorInfo",
            clusterId: 42,
            senderAddress: "0x1111111111111111111111111111111111111111",
            operatorId: "0x" + "c".repeat(64),
            chainAddress: "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at",
            chainAddressHex: "0x1111111111111111111111111111111111111111",
          },
          {
            source: "lyth_clusterStatus+lyth_operatorInfo",
            clusterId: 42,
            senderAddress: "0x2222222222222222222222222222222222222222",
            operatorId: "0x" + "d".repeat(64),
            chainAddress: "0x2222222222222222222222222222222222222222",
            chainAddressHex: "0x2222222222222222222222222222222222222222",
          },
        ],
      },
    });
  });
});
