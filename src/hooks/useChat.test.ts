import { describe, expect, it } from "vitest";
import type { ChatChannel, ChatMessage } from "../sdk/chat";
import { mergeChatMessage, nextActiveChatChannelId } from "./useChat";

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
