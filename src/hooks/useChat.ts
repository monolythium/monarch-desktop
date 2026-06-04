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
import {
  chatInitialize,
  chatGetChannels,
  chatGetMessages,
  chatSendMessage,
  chatSubscribeChannel,
  inTauri,
  listenChatMessages,
  type ChatChannel,
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
  selectChannel: (channelId: string) => void;
  send: (body: string) => Promise<boolean>;
  joinCluster: (clusterId: number, name?: string) => Promise<void>;
  /** Re-pull the channel list (after a join, or on demand). */
  refreshChannels: () => Promise<void>;
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

export function useChat(): ChatState {
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const aliveRef = useRef(true);
  // The active cluster id is needed when sending (the Rust send path
  // re-checks live membership keyed on the numeric cluster id).
  const activeClusterRef = useRef<number | null>(null);

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
          setError("Operator PQM-1 key is not stored yet. Add the operator key before joining chat.");
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
  }, [channels, activeChannelId]);

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
        unlisten = await listenChatMessages(activeChannelId, (msg) => {
          if (!aliveRef.current || cancelled) return;
          // Ignore events for a channel we've since switched away from.
          if (msg.channel_id !== activeChannelId) return;
          setMessages((prev) => mergeChatMessage(prev, msg));
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
  }, [activeChannelId]);

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
    selectChannel,
    send,
    joinCluster,
    refreshChannels,
  };
}
