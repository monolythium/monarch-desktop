import { describe, expect, it } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
import type { ChatChannel, ChatMemberMoniker, ChatMessage } from "../sdk/chat";
import {
  buildChatSenderResolver,
  bumpUnreadCount,
  mergeChatMessage,
  nextActiveChatChannelId,
} from "./useChat";

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    msg_id: "msg-a",
    channel_id: "cluster:1",
    cluster_id: 1,
    sender_address: "0x1111111111111111111111111111111111111111",
    sender_pubkey_hex: "0xabcd",
    body: "hello",
    timestamp_ms: 1_000,
    nonce_hex: "0x1234",
    signature_hex: "abcd",
    verified: true,
    from_me: false,
    ...overrides,
  };
}

describe("chat message merging", () => {
  it("deduplicates repeated message ids", () => {
    const existing = [message({ msg_id: "msg-a" })];
    const merged = mergeChatMessage(existing, message({ msg_id: "msg-a", body: "duplicate" }));

    expect(merged).toBe(existing);
  });

  it("sorts by timestamp, then message id", () => {
    const merged = mergeChatMessage(
      [
        message({ msg_id: "msg-c", timestamp_ms: 2_000 }),
        message({ msg_id: "msg-b", timestamp_ms: 1_000 }),
      ],
      message({ msg_id: "msg-a", timestamp_ms: 1_000 }),
    );

    expect(merged.map((m) => m.msg_id)).toEqual(["msg-a", "msg-b", "msg-c"]);
  });
});

function channel(overrides: Partial<ChatChannel>): ChatChannel {
  return {
    channel_id: "cluster-1",
    name: "Cluster C-001",
    sub: "cluster-1 signed",
    kind: "cluster",
    cluster_id: 1,
    subscribed: true,
    last_read_ts: 0,
    unread_count: 0,
    ...overrides,
  };
}

describe("chat channel selection", () => {
  it("keeps the current channel when it is still present", () => {
    expect(nextActiveChatChannelId("cluster-2", [
      channel({ channel_id: "cluster-1", cluster_id: 1 }),
      channel({ channel_id: "cluster-2", cluster_id: 2 }),
    ])).toBe("cluster-2");
  });

  it("falls back to a subscribed channel when the current one disappeared", () => {
    expect(nextActiveChatChannelId("cluster-9", [
      channel({ channel_id: "cluster-1", cluster_id: 1, subscribed: false }),
      channel({ channel_id: "cluster-2", cluster_id: 2, subscribed: true }),
    ])).toBe("cluster-2");
  });

  it("returns null when there are no channels", () => {
    expect(nextActiveChatChannelId("cluster-1", [])).toBeNull();
  });
});

describe("unread badge bumping (monarch://chat/any)", () => {
  const channels = [
    channel({ channel_id: "cluster-1", cluster_id: 1, unread_count: 2 }),
    channel({ channel_id: "cluster-2", cluster_id: 2, unread_count: 0 }),
    channel({
      channel_id: "ceremony-abc123",
      kind: "ceremony",
      cluster_id: -1,
      unread_count: 0,
    }),
  ];

  it("bumps a non-active subscribed channel", () => {
    const next = bumpUnreadCount(
      channels,
      message({ channel_id: "cluster-1", from_me: false }),
      "cluster-2",
    );
    expect(next.find((c) => c.channel_id === "cluster-1")?.unread_count).toBe(3);
    expect(next.find((c) => c.channel_id === "cluster-2")?.unread_count).toBe(0);
  });

  it("bumps ceremony channels too (sentinel cluster_id -1)", () => {
    const next = bumpUnreadCount(
      channels,
      message({ channel_id: "ceremony-abc123", cluster_id: -1, from_me: false }),
      "cluster-1",
    );
    expect(next.find((c) => c.channel_id === "ceremony-abc123")?.unread_count).toBe(1);
  });

  it("never counts own messages or the on-screen channel", () => {
    expect(bumpUnreadCount(
      channels,
      message({ channel_id: "cluster-1", from_me: true }),
      "cluster-2",
    )).toBe(channels);
    expect(bumpUnreadCount(
      channels,
      message({ channel_id: "cluster-1", from_me: false }),
      "cluster-1",
    )).toBe(channels);
  });

  it("returns the same array when the channel is unknown", () => {
    expect(bumpUnreadCount(
      channels,
      message({ channel_id: "cluster-99", from_me: false }),
      null,
    )).toBe(channels);
  });
});

describe("moniker-first sender resolution", () => {
  const pubkeyBytes = Uint8Array.from([1, 2, 3]);
  const pubkeyHex = "0x010203";
  // operator id = BLAKE3(consensus pubkey) — the registry's operator key.
  const operatorId = "0x" + Array.from(blake3(pubkeyBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const members: ChatMemberMoniker[] = [
    {
      operator_id: operatorId,
      address: "mono1zg69v7y6hn00qyfzxdz92enh3zv64w7vajvdc4",
      moniker: "atlas-node",
    },
  ];

  it("maps a verified sender pubkey to its member record via BLAKE3", () => {
    const resolve = buildChatSenderResolver(members);
    expect(resolve(pubkeyHex)?.moniker).toBe("atlas-node");
    expect(resolve(pubkeyHex)?.address).toBe(
      "mono1zg69v7y6hn00qyfzxdz92enh3zv64w7vajvdc4",
    );
    // Memoized second lookup returns the same record.
    expect(resolve(pubkeyHex)).toBe(resolve(pubkeyHex));
  });

  it("returns null for unknown or malformed senders", () => {
    const resolve = buildChatSenderResolver(members);
    expect(resolve("0xffffff")).toBeNull();
    expect(resolve("not-hex")).toBeNull();
    expect(resolve("")).toBeNull();
  });
});
