// `useChat()` — drives the operator Chat view.
//
// Mirrors the `useLogStream` pattern: it fetches the persisted channel
// list + the active channel's history from the Rust `chat_*` commands,
// then subscribes to the live `monarch://chat/message/{channel_id}`
// event so new messages (locally-sent and verified inbound gossip)
// append without a re-fetch.
//
// The hook owns no networking — that lives in the Rust `chat` module.
// It is purely a presentational data source for `views/Chat.tsx`.
//
// Deferred beyond the current cluster-channel release: DMs, reactions,
// attachments, and typing/read receipts.

import { useCallback, useEffect, useRef, useState } from "react";
import { blake3 } from "@noble/hashes/blake3.js";
import {
  chatGetChannels,
  chatGetMemberMonikers,
  chatGetMessages,
  chatInitialize,
  chatMarkRead,
  chatSendMessage,
  chatSubscribeChannel,
  inTauri,
  listenChatAnyMessage,
  listenChatMessages,
  type ChatChannel,
  type ChatMemberMoniker,
  type ChatMessage,
} from "../sdk/bridge";
import { resolveChatBootstrapPeers, resolveChatBootstrapPeersForCluster } from "../sdk/chatConfig";
import { rpcEndpoint } from "../sdk/client";
import { DEFAULT_ACTIVE_CLUSTER_ID } from "../sdk/clusterModel";

export type ChatState = {
  channels: ChatChannel[];
  activeChannelId: string | null;
  messages: ChatMessage[];
  /** True while the initial channel/message fetch is in flight. */
  loading: boolean;
  /** Last error surfaced from a command (send / subscribe / fetch). */
  error: string | null;
  /** True while a message send is in flight. */
  sending: boolean;
  /**
   * Member display identities for the ACTIVE channel (moniker +
   * bech32m address), from the Rust roster cache. Empty for ceremony
   * channels (no fixed roster) and when the roster read fails.
   */
  members: ChatMemberMoniker[];
  selectChannel: (channelId: string) => void;
  send: (body: string) => Promise<boolean>;
  joinCluster: (clusterId: number, name?: string) => Promise<void>;
  /** Re-pull the channel list (after a join, or on demand). */
  refreshChannels: () => Promise<void>;
  /** Advance a channel's read cursor and clear its local unread badge. */
  markRead: (channelId: string) => Promise<void>;
};

/** De-dupe + sort messages oldest-first by timestamp, then id. */
export function mergeChatMessage(prev: ChatMessage[], next: ChatMessage): ChatMessage[] {
  if (prev.some((m) => m.msg_id === next.msg_id)) return prev;
  const merged = [...prev, next];
  merged.sort((a, b) =>
    a.timestamp_ms === b.timestamp_ms
      ? a.msg_id.localeCompare(b.msg_id)
      : a.timestamp_ms - b.timestamp_ms,
  );
  return merged;
}

export function nextActiveChatChannelId(
  current: string | null,
  channels: ChatChannel[],
): string | null {
  if (current && channels.some((channel) => channel.channel_id === current)) {
    return current;
  }
  return channels.find((channel) => channel.subscribed)?.channel_id
    ?? channels[0]?.channel_id
    ?? null;
}

/**
 * Bump a channel's local unread badge for a live inbound message
 * (`monarch://chat/any`). Own messages and messages for the channel
 * currently on screen never count — the active channel is marked read
 * as messages land. Pure; returns the same array when nothing changed.
 */
export function bumpUnreadCount(
  channels: ChatChannel[],
  msg: Pick<ChatMessage, "channel_id" | "from_me">,
  activeChannelId: string | null,
): ChatChannel[] {
  if (msg.from_me || msg.channel_id === activeChannelId) return channels;
  let changed = false;
  const next = channels.map((channel) => {
    if (channel.channel_id !== msg.channel_id || !channel.subscribed) return channel;
    changed = true;
    return { ...channel, unread_count: channel.unread_count + 1 };
  });
  return changed ? next : channels;
}

/**
 * Build a resolver from a channel's member directory: a message's
 * verified `sender_pubkey_hex` → the member record (moniker-first
 * display). operator id = BLAKE3(pubkey), exactly how the registry keys
 * operators; results are memoized per pubkey so render passes don't
 * re-hash. Returns null for senders outside the directory (callers fall
 * back to a bech32m rendering of the sender address — never raw hex).
 */
export function buildChatSenderResolver(
  members: readonly ChatMemberMoniker[],
): (senderPubkeyHex: string) => ChatMemberMoniker | null {
  const byOperatorId = new Map(
    members.map((member) => [stripHexPrefix(member.operator_id).toLowerCase(), member]),
  );
  const cache = new Map<string, ChatMemberMoniker | null>();
  return (senderPubkeyHex: string) => {
    const cached = cache.get(senderPubkeyHex);
    if (cached !== undefined) return cached;
    const bytes = hexToBytesOrNull(stripHexPrefix(senderPubkeyHex));
    const operatorId = bytes ? bytesToPlainHex(blake3(bytes)) : null;
    const resolved = operatorId ? byOperatorId.get(operatorId) ?? null : null;
    cache.set(senderPubkeyHex, resolved);
    return resolved;
  };
}

function stripHexPrefix(value: string): string {
  return value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
}

function hexToBytesOrNull(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/u.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function bytesToPlainHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function useChat(): ChatState {
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [members, setMembers] = useState<ChatMemberMoniker[]>([]);

  const aliveRef = useRef(true);
  // The active cluster id is needed when sending (the Rust send path
  // re-checks live membership keyed on the numeric cluster id; ceremony
  // channels carry the -1 sentinel).
  const activeClusterRef = useRef<number | null>(null);
  // Mirror of activeChannelId for the channel-agnostic unread listener
  // (which is mounted once, not re-subscribed per selection).
  const activeChannelIdRef = useRef<string | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const ensureInitialized = useCallback(async (clusterId?: number): Promise<boolean> => {
    try {
      const bootstrapPeers = inTauri()
        ? await resolveChatBootstrapPeersForCluster({
          endpoint: rpcEndpoint,
          clusterId: clusterId ?? DEFAULT_ACTIVE_CLUSTER_ID,
        })
        : resolveChatBootstrapPeers();
      const init = await chatInitialize({
        rpcEndpoint,
        bootstrapPeers,
      });
      if (!init && inTauri()) {
        if (aliveRef.current) {
          setError("Operator key is not stored yet. Add the operator key before joining chat.");
          setChannels([]);
          setActiveChannelId(null);
          setMessages([]);
        }
        return false;
      }
      return true;
    } catch (err) {
      if (aliveRef.current) setError((err as Error)?.message ?? String(err));
      return false;
    }
  }, []);

  const refreshChannels = useCallback(async () => {
    setLoading(true);
    try {
      const ready = await ensureInitialized();
      if (!aliveRef.current || !ready) return;
      const list = await chatGetChannels();
      if (!aliveRef.current) return;
      setChannels(list);
      setActiveChannelId((current) => nextActiveChatChannelId(current, list));
    } catch (err) {
      if (!aliveRef.current) return;
      setError((err as Error)?.message ?? String(err));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [ensureInitialized]);

  // Initial load.
  useEffect(() => {
    void refreshChannels();
  }, [refreshChannels]);

  // Track the active cluster id whenever the selection / list changes.
  useEffect(() => {
    const active = channels.find((c) => c.channel_id === activeChannelId);
    activeClusterRef.current = active?.cluster_id ?? null;
    activeChannelIdRef.current = activeChannelId;
  }, [channels, activeChannelId]);

  // Advance the read cursor (Rust-side, monotonic) and clear the local
  // badge so the UI doesn't wait for the next channel refresh.
  const markRead = useCallback(async (channelId: string) => {
    try {
      await chatMarkRead(channelId);
      if (!aliveRef.current) return;
      setChannels((prev) =>
        prev.map((channel) =>
          channel.channel_id === channelId && channel.unread_count !== 0
            ? { ...channel, unread_count: 0 }
            : channel,
        ),
      );
    } catch {
      // Non-fatal: the badge simply persists until the next refresh.
    }
  }, []);

  // Member display identities (moniker + bech32m) for the active
  // channel. Failure (RPC down, ceremony channel) degrades to [] — the
  // view falls back to bech32m addresses.
  useEffect(() => {
    if (!activeChannelId) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    chatGetMemberMonikers(activeChannelId)
      .then((rows) => {
        if (!cancelled && aliveRef.current) setMembers(rows);
      })
      .catch(() => {
        if (!cancelled && aliveRef.current) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeChannelId]);

  // Channel-agnostic live tail (`monarch://chat/any`): bump unread
  // badges for messages landing on channels that are not on screen.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const stop = await listenChatAnyMessage((msg) => {
        if (cancelled || !aliveRef.current) return;
        setChannels((prev) => bumpUnreadCount(prev, msg, activeChannelIdRef.current));
      });
      if (cancelled) {
        stop();
      } else {
        unlisten = stop;
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Fetch history + subscribe to the live tail for the active channel.
  useEffect(() => {
    if (!activeChannelId) {
      setMessages([]);
      return;
    }
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    setMessages([]);

    (async () => {
      try {
        const history = await chatGetMessages(activeChannelId);
        if (cancelled || !aliveRef.current) return;
        setMessages(history);
        // Opening a channel reads it.
        void markRead(activeChannelId);
        unlisten = await listenChatMessages(activeChannelId, (msg) => {
          if (!aliveRef.current || cancelled) return;
          // Ignore events for a channel we've since switched away from.
          if (msg.channel_id !== activeChannelId) return;
          setMessages((prev) => mergeChatMessage(prev, msg));
          // The channel is on screen — messages are read as they land.
          if (!msg.from_me) void markRead(activeChannelId);
        });
      } catch (err) {
        if (cancelled || !aliveRef.current) return;
        setError((err as Error)?.message ?? String(err));
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [activeChannelId, markRead]);

  const selectChannel = useCallback((channelId: string) => {
    setActiveChannelId(channelId);
    setError(null);
  }, []);

  const send = useCallback(
    async (body: string): Promise<boolean> => {
      const trimmed = body.trim();
      if (!trimmed || !activeChannelId) return false;
      const clusterId = activeClusterRef.current;
      if (clusterId === null) {
        setError("No cluster selected");
        return false;
      }
      setError(null);
      setSending(true);
      try {
        // The Rust side persists + emits the optimistic record on the
        // live event channel, so the message lands via the subscription;
        // we don't need to splice the return value in by hand.
        await chatSendMessage({ channelId: activeChannelId, clusterId, body: trimmed });
        return true;
      } catch (err) {
        setError((err as Error)?.message ?? String(err));
        return false;
      } finally {
        if (aliveRef.current) setSending(false);
      }
    },
    [activeChannelId],
  );

  const joinCluster = useCallback(
    async (clusterId: number, name?: string) => {
      setError(null);
      try {
        const ready = await ensureInitialized(clusterId);
        if (!ready) return;
        const channel = await chatSubscribeChannel({ clusterId, name });
        await refreshChannels();
        if (aliveRef.current) setActiveChannelId(channel.channel_id);
      } catch (err) {
        setError((err as Error)?.message ?? String(err));
      }
    },
    [ensureInitialized, refreshChannels],
  );

  return {
    channels,
    activeChannelId,
    messages,
    loading,
    error,
    sending,
    members,
    selectChannel,
    send,
    joinCluster,
    refreshChannels,
    markRead,
  };
}
