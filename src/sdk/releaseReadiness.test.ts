import { describe, expect, it } from "vitest";
import type { ChatChannel, ChatInitResult, ChatMessage } from "./chat";
import type {
  ProtocoreReadiness,
  TalosCertificateInfo,
  TalosConfigInfo,
  TalosServiceInfo,
  TalosStatus,
} from "./bridge";
import type { ReleaseAttestationStatus } from "./releaseAttestation";
import { withOperationReceiptAuditHash, type OperationReceipt } from "../ops/receipts";
import {
  desktopReleaseReadiness,
  type ReleaseChatMembershipEvidence,
} from "./releaseReadiness";

const rpcEndpoint = "http://127.0.0.1:8545";
const releaseDigest = "a".repeat(64);

function hex(ch: string, bytes: number): string {
  return `0x${ch.repeat(bytes * 2)}`;
}

function certificate(overrides: Partial<TalosCertificateInfo> = {}): TalosCertificateInfo {
  return {
    role: "client",
    subject: "CN=monarch-operator",
    issuer: "CN=talos-ca",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: "2027-01-01T00:00:00Z",
    sha256Fingerprint: "aa:bb:cc",
    expired: false,
    notYetValid: false,
    expiresInDays: 365,
    dnsNames: [],
    ipAddresses: ["127.0.0.1"],
    ...overrides,
  };
}

function config(overrides: Partial<TalosConfigInfo> = {}): TalosConfigInfo {
  return {
    path: "/tmp/talosconfig",
    context: "monarch",
    endpoint: "https://127.0.0.1:50000",
    serverName: "127.0.0.1",
    caFingerprint: "ca:01",
    trustedCaFingerprint: "ca:01",
    caPinStatus: "matched",
    endpoints: ["https://127.0.0.1:50000"],
    nodes: ["https://127.0.0.1:50000"],
    certificates: [certificate()],
    warnings: [],
    ...overrides,
  };
}

function status(overrides: Partial<TalosStatus> = {}): TalosStatus {
  return {
    configured: true,
    reachable: true,
    endpoint: "https://127.0.0.1:50000",
    nodeAddress: "127.0.0.1",
    configPath: "/tmp/talosconfig",
    clientMode: "native",
    version: "v1.13.0",
    lastError: null,
    ...overrides,
  };
}

function service(overrides: Partial<TalosServiceInfo> = {}): TalosServiceInfo {
  return {
    id: "ext-protocore",
    state: "Running",
    displayState: "running",
    severity: "ok",
    summary: "ext-protocore is running",
    healthy: true,
    healthUnknown: false,
    healthMessage: null,
    lastEvent: null,
    events: [],
    ...overrides,
  };
}

function readiness(overrides: Partial<ProtocoreReadiness> = {}): ProtocoreReadiness {
  return {
    service: service(),
    rpcEndpoint,
    displayState: "serving-rpc",
    severity: "ok",
    summary: "Protocore RPC is serving chain_id 69420 at block 42",
    chainId: 69420,
    blockNumber: 42,
    clientVersion: "protocore/0.4.0",
    listening: true,
    syncing: false,
    checks: [
      { name: "talos-service", state: "ok", message: "ext-protocore is running" },
      { name: "chain-id", state: "ok", message: "chain_id 69420" },
      { name: "block-number", state: "ok", message: "block 42" },
    ],
    ...overrides,
  };
}

function attestation(overrides: Partial<ReleaseAttestationStatus> = {}): ReleaseAttestationStatus {
  return {
    className: "halo halo--ok",
    text: "runtime digest matched",
    title: "live abcdef",
    expectedDigest: releaseDigest,
    liveDigest: releaseDigest,
    ...overrides,
  };
}

function receipt(overrides: Partial<OperationReceipt> = {}): OperationReceipt {
  return withOperationReceiptAuditHash({
    id: "receipt-1",
    createdAt: "2026-01-01T00:00:00Z",
    kind: "operator-restart",
    title: "Graceful restart",
    status: "ok",
    message: "submitted",
    transport: "talos",
    service: "ext-protocore",
    action: "restart",
    endpoint: "https://127.0.0.1:50000",
    nodeAddress: "127.0.0.1",
    ...overrides,
  });
}

function channel(overrides: Partial<ChatChannel> = {}): ChatChannel {
  return {
    channel_id: "cluster-1",
    name: "Cluster 1",
    sub: "cluster",
    kind: "cluster",
    cluster_id: 1,
    subscribed: true,
    last_read_ts: 0,
    unread_count: 0,
    ...overrides,
  };
}

function chatInit(overrides: Partial<ChatInitResult> = {}): ChatInitResult {
  return {
    address_hex: "0x1111111111111111111111111111111111111111",
    public_key_hex: "aa".repeat(32),
    rpc_endpoint: rpcEndpoint,
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    msg_id: hex("a", 32),
    channel_id: "cluster-1",
    cluster_id: 1,
    sender_address: "0x1111111111111111111111111111111111111111",
    sender_pubkey_hex: hex("c", 32),
    body: "hello",
    timestamp_ms: 1_000,
    nonce_hex: hex("d", 16),
    signature_hex: hex("b", 64),
    verified: true,
    from_me: true,
    ...overrides,
  };
}

function membership(
  overrides: Partial<ReleaseChatMembershipEvidence> = {},
): ReleaseChatMembershipEvidence {
  return {
    source: "lyth_clusterStatus+lyth_operatorInfo",
    clusterId: 1,
    checkedAt: "2026-06-01T00:00:00Z",
    membersChecked: 10,
    proofs: [
      {
        source: "lyth_clusterStatus+lyth_operatorInfo",
        clusterId: 1,
        senderAddress: "0x1111111111111111111111111111111111111111",
        operatorId: hex("c", 32),
        chainAddress: "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at",
        chainAddressHex: "0x1111111111111111111111111111111111111111",
      },
      {
        source: "lyth_clusterStatus+lyth_operatorInfo",
        clusterId: 1,
        senderAddress: "0x2222222222222222222222222222222222222222",
        operatorId: hex("d", 32),
        chainAddress: "0x2222222222222222222222222222222222222222",
        chainAddressHex: "0x2222222222222222222222222222222222222222",
      },
    ],
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<typeof desktopReleaseReadiness>[0]> = {}) {
  return {
    expectedChainId: 69420,
    expectedRpcEndpoint: rpcEndpoint,
    talosStatus: status(),
    talosConfig: config(),
    protocore: readiness(),
    releaseAttestation: attestation(),
    operationReceipts: [receipt()],
    requiredOperationActions: ["restart" as const],
    chat: {
      init: chatInit(),
      channels: [channel()],
      activeChannelId: "cluster-1",
      messages: [
        message({ msg_id: hex("a", 32), from_me: true }),
        message({
          msg_id: hex("b", 32),
          from_me: false,
          sender_address: "0x2222222222222222222222222222222222222222",
        }),
      ],
      bootstrapPeers: ["/ip4/127.0.0.1/tcp/41001/p2p/peer-a"],
      membership: membership(),
    },
    ...overrides,
  };
}

describe("Desktop release readiness gate", () => {
  it("passes only when Talos, Protocore, release digest, operation receipt, and chat evidence are complete", () => {
    const report = desktopReleaseReadiness(input());

    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.gates.map((gate) => gate.id)).toEqual([
      "talos-identity",
      "protocore-readiness",
      "release-attestation",
      "operation-receipts",
      "chat-exchange",
    ]);
  });

  it("fails closed on Talos CA mismatch or invalid cert lifecycle", () => {
    expect(
      desktopReleaseReadiness(input({ talosConfig: config({ caPinStatus: "mismatch" }) })),
    ).toMatchObject({
      ok: false,
      blockers: [{ id: "talos-identity" }],
    });

    expect(
      desktopReleaseReadiness(input({
        talosConfig: config({ certificates: [certificate({ expired: true })] }),
      })),
    ).toMatchObject({
      ok: false,
      blockers: [{ id: "talos-identity" }],
    });
  });

  it("requires Talos certificates to be outside the release rotation window", () => {
    const report = desktopReleaseReadiness(input({
      talosConfig: config({ certificates: [certificate({ expiresInDays: 4 })] }),
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      id: "talos-identity",
      summary: "Talos config has 1 certificate(s) inside the 14-day rotation window.",
    }));
  });

  it("requires serving RPC on the expected chain with P2P listening and not syncing", () => {
    const report = desktopReleaseReadiness(input({
      protocore: readiness({
        displayState: "syncing",
        severity: "info",
        syncing: true,
      }),
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      id: "protocore-readiness",
    }));
  });

  it("requires a successful Talos operation receipt for required service actions", () => {
    const report = desktopReleaseReadiness(input({
      operationReceipts: [receipt({ status: "error" })],
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      id: "operation-receipts",
    }));
  });

  it("does not accept browser-preview receipts as release operation evidence", () => {
    const report = desktopReleaseReadiness(input({
      operationReceipts: [
        receipt({
          transport: "browser-preview",
          endpoint: undefined,
          nodeAddress: undefined,
        }),
      ],
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      id: "operation-receipts",
    }));
  });

  it("requires operation receipts to carry a canonical audit hash", () => {
    const audited = receipt();
    const report = desktopReleaseReadiness(input({
      operationReceipts: [
        {
          ...audited,
          auditPayloadHash: "0".repeat(64),
        },
      ],
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      id: "operation-receipts",
    }));
  });

  it("requires release digest attestation to match", () => {
    const report = desktopReleaseReadiness(input({
      releaseAttestation: attestation({
        className: "halo halo--err",
        text: "runtime digest mismatch",
      }),
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      id: "release-attestation",
    }));
  });

  it("requires chat bootstrap, active subscription, and verified two-party messages", () => {
    const report = desktopReleaseReadiness(input({
      chat: {
        init: chatInit(),
        channels: [channel()],
        activeChannelId: "cluster-1",
        messages: [
          message({ msg_id: hex("a", 32), from_me: true }),
          message({
            msg_id: hex("b", 32),
            from_me: false,
            sender_address: "0x2222222222222222222222222222222222222222",
            verified: false,
          }),
        ],
        bootstrapPeers: [],
        membership: membership(),
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      id: "chat-exchange",
    }));
  });

  it("requires chat history to retain full signed-envelope fields", () => {
    const report = desktopReleaseReadiness(input({
      chat: {
        init: chatInit(),
        channels: [channel()],
        activeChannelId: "cluster-1",
        messages: [
          message({ msg_id: hex("a", 32), from_me: true }),
          message({
            msg_id: hex("b", 32),
            from_me: false,
            sender_address: "0x2222222222222222222222222222222222222222",
            sender_pubkey_hex: "",
            nonce_hex: "",
          }),
        ],
        bootstrapPeers: ["/ip4/127.0.0.1/tcp/41001/p2p/peer-a"],
        membership: membership(),
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      id: "chat-exchange",
      summary: "Chat history contains stale, unsigned, or unverified messages.",
    }));
  });

  it("does not count empty chat bodies as release exchange evidence", () => {
    const report = desktopReleaseReadiness(input({
      chat: {
        init: chatInit(),
        channels: [channel()],
        activeChannelId: "cluster-1",
        messages: [
          message({ msg_id: hex("a", 32), from_me: true }),
          message({
            msg_id: hex("b", 32),
            from_me: false,
            sender_address: "0x2222222222222222222222222222222222222222",
            body: "   ",
          }),
        ],
        bootstrapPeers: ["/ip4/127.0.0.1/tcp/41001/p2p/peer-a"],
        membership: membership(),
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      id: "chat-exchange",
      summary: "Chat history contains stale, unsigned, or unverified messages.",
    }));
  });

  it("requires the two chat messages to come from distinct sender identities", () => {
    const report = desktopReleaseReadiness(input({
      chat: {
        init: chatInit(),
        channels: [channel()],
        activeChannelId: "cluster-1",
        messages: [
          message({ msg_id: hex("a", 32), from_me: true }),
          message({ msg_id: hex("b", 32), from_me: false }),
        ],
        bootstrapPeers: ["/ip4/127.0.0.1/tcp/41001/p2p/peer-a"],
        membership: membership(),
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      id: "chat-exchange",
      summary: "Chat has not proved two distinct signed operator identities.",
    }));
  });

  it("requires chat evidence to include local and peer messages", () => {
    const report = desktopReleaseReadiness(input({
      chat: {
        init: chatInit(),
        channels: [channel()],
        activeChannelId: "cluster-1",
        messages: [
          message({ msg_id: hex("a", 32), from_me: true }),
          message({
            msg_id: hex("b", 32),
            from_me: true,
            sender_address: "0x2222222222222222222222222222222222222222",
          }),
        ],
        bootstrapPeers: ["/ip4/127.0.0.1/tcp/41001/p2p/peer-a"],
        membership: membership(),
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      id: "chat-exchange",
      summary: "Chat has not proved both local and peer signed messages.",
    }));
  });

  it("requires chat message perspective to match the initialized identity", () => {
    const report = desktopReleaseReadiness(input({
      chat: {
        init: chatInit(),
        channels: [channel()],
        activeChannelId: "cluster-1",
        messages: [
          message({ msg_id: hex("a", 32), from_me: false }),
          message({
            msg_id: hex("b", 32),
            from_me: true,
            sender_address: "0x2222222222222222222222222222222222222222",
          }),
        ],
        bootstrapPeers: ["/ip4/127.0.0.1/tcp/41001/p2p/peer-a"],
        membership: membership(),
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      id: "chat-exchange",
      summary: "Chat message perspective does not match the initialized identity.",
    }));
  });

  it("requires every signed chat sender to have cluster membership proof", () => {
    const report = desktopReleaseReadiness(input({
      chat: {
        init: chatInit(),
        channels: [channel()],
        activeChannelId: "cluster-1",
        messages: [
          message({ msg_id: hex("a", 32), from_me: true }),
          message({
            msg_id: hex("b", 32),
            from_me: false,
            sender_address: "0x2222222222222222222222222222222222222222",
          }),
        ],
        bootstrapPeers: ["/ip4/127.0.0.1/tcp/41001/p2p/peer-a"],
        membership: membership({
          proofs: [
            {
              source: "lyth_clusterStatus+lyth_operatorInfo",
              clusterId: 1,
              senderAddress: "0x1111111111111111111111111111111111111111",
              operatorId: hex("c", 32),
              chainAddress: "0x1111111111111111111111111111111111111111",
              chainAddressHex: "0x1111111111111111111111111111111111111111",
            },
          ],
        }),
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      id: "chat-exchange",
      summary: "Chat sender membership proof does not cover every signed sender.",
    }));
  });
});
