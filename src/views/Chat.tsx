// Chat — signed operator-to-operator messaging.
//
// Mirrors `designs/src/chat.jsx`: a channel list (left), a message
// stream + composer (center). The design's right-hand channel-detail pane,
// reactions, and attachment cards are later-phase surfaces and are
// intentionally omitted here — this ships cluster channels (plus
// formCluster ceremony lobbies) with signed send/receive over gossipsub,
// local SQLite history, and live membership gating (all wired in
// `src-tauri/src/chat.rs` + `hooks/useChat.ts`).
//
// Every message carries an ML-DSA-65 signature the Rust side verified on
// receipt; the "signed" badge reflects that verification, not a UI
// claim. Senders render moniker-first, falling back to a bech32m
// `mono1…` address (ADR-0038: never raw hex). The view stays
// presentational — all networking + crypto lives in the Rust `chat`
// module.

import { useEffect, useMemo, useRef, useState } from "react";
import { addressToBech32 } from "@monolythium/core-sdk";
import { buildChatSenderResolver, useChat } from "../hooks/useChat";
import { useClusterDirectory } from "../sdk";
import type { ChatChannel, ChatMessage } from "../sdk/chat";

/** Body caps, mirrored from chat.rs (`MAX_BODY_BYTES` / `CEREMONY_MAX_BODY_BYTES`). */
const CLUSTER_BODY_CAP_BYTES = 4_096;
const CEREMONY_BODY_CAP_BYTES = 12_288;

export function Chat() {
  const chat = useChat();
  const directory = useClusterDirectory();
  const [draft, setDraft] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Coarse clock for relative timestamps ("5m ago" stays fresh).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const activeChannel = chat.channels.find((c) => c.channel_id === chat.activeChannelId) ?? null;
  const bodyCapBytes =
    activeChannel?.kind === "ceremony" ? CEREMONY_BODY_CAP_BYTES : CLUSTER_BODY_CAP_BYTES;
  const draftBytes = useMemo(() => new TextEncoder().encode(draft.trim()).length, [draft]);
  const overCap = draftBytes > bodyCapBytes;

  // Moniker-first sender labels for the active channel's roster.
  const resolveSender = useMemo(
    () => buildChatSenderResolver(chat.members),
    [chat.members],
  );

  // Auto-scroll to the newest message on channel switch / new message.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chat.activeChannelId, chat.messages.length]);

  const onSend = async () => {
    const body = draft.trim();
    if (!body || chat.sending || overCap) return;
    const sent = await chat.send(body);
    if (sent) setDraft("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  };

  // Clusters the operator could join but hasn't yet (for the join menu).
  const joinableClusters = useMemo(() => {
    const joined = new Set(chat.channels.map((c) => c.cluster_id));
    return (directory.data ?? []).filter((c) => !joined.has(c.clusterId));
  }, [directory.data, chat.channels]);

  const clusterChannels = chat.channels.filter((c) => c.kind !== "ceremony");
  const ceremonyChannels = chat.channels.filter((c) => c.kind === "ceremony");

  // Message stream with day separators (never group across a separator).
  const streamItems = useMemo(() => {
    const items: Array<
      | { type: "sep"; key: string; label: string }
      | { type: "msg"; msg: ChatMessage; grouped: boolean }
    > = [];
    let prev: ChatMessage | null = null;
    for (const msg of chat.messages) {
      if (prev === null || dayKey(prev.timestamp_ms) !== dayKey(msg.timestamp_ms)) {
        items.push({
          type: "sep",
          key: `sep-${msg.msg_id}`,
          label: fmtDaySeparator(msg.timestamp_ms, now),
        });
        prev = null;
      }
      const grouped =
        prev !== null &&
        prev.sender_address === msg.sender_address &&
        msg.timestamp_ms - prev.timestamp_ms < 5 * 60 * 1000;
      items.push({ type: "msg", msg, grouped });
      prev = msg;
    }
    return items;
  }, [chat.messages, now]);

  const senderLabel = (msg: ChatMessage): string => {
    if (msg.from_me) return "you";
    const member = resolveSender(msg.sender_pubkey_hex);
    if (member?.moniker) return member.moniker;
    if (member) return shortBech(member.address);
    return shortBech(toBech32Display(msg.sender_address));
  };

  return (
    <div className="chat-shell">
      <h1 className="sr-only">Chat</h1>
      {/* ——— Channel list ——— */}
      <aside className="chat-channels">
        <header className="chat-channels__head">
          <span className="chat-channels__title">Chat</span>
          <button
            type="button"
            className="btn btn--icon btn--ghost"
            title="Refresh channels"
            onClick={() => void chat.refreshChannels()}
          >
            ↻
          </button>
          <button
            type="button"
            className="btn btn--icon btn--ghost"
            title="Join a cluster channel"
            onClick={() => setJoinOpen((v) => !v)}
          >
            +
          </button>
        </header>

        {joinOpen ? (
          <div className="chat-join">
            <div className="cap" style={{ marginBottom: 6 }}>Join a cluster</div>
            {joinableClusters.length === 0 ? (
              <div className="mono chat-join__empty">
                {directory.loading ? "loading clusters…" : "no other clusters to join"}
              </div>
            ) : (
              joinableClusters.map((c) => (
                <button
                  key={c.clusterId}
                  type="button"
                  className="chat-join__item"
                  onClick={() => {
                    void chat.joinCluster(c.clusterId, `Cluster C-${String(c.clusterId).padStart(3, "0")}`);
                    setJoinOpen(false);
                  }}
                >
                  <span className="mono">C-{String(c.clusterId).padStart(3, "0")}</span>
                  <span className="chat-join__sub mono">{c.size} members</span>
                </button>
              ))
            )}
          </div>
        ) : null}

        <div className="chat-channels__group cap">Cluster</div>
        <div className="chat-channels__list">
          {clusterChannels.length === 0 ? (
            <div className="mono chat-channels__empty">
              {chat.loading ? "loading…" : "join a cluster to start"}
            </div>
          ) : (
            clusterChannels.map((c) => (
              <ChannelRow
                key={c.channel_id}
                channel={c}
                active={c.channel_id === chat.activeChannelId}
                onSelect={() => chat.selectChannel(c.channel_id)}
              />
            ))
          )}
        </div>

        {ceremonyChannels.length > 0 ? (
          <>
            <div className="chat-channels__group cap">Ceremony</div>
            <div className="chat-channels__list">
              {ceremonyChannels.map((c) => (
                <ChannelRow
                  key={c.channel_id}
                  channel={c}
                  active={c.channel_id === chat.activeChannelId}
                  onSelect={() => chat.selectChannel(c.channel_id)}
                />
              ))}
            </div>
          </>
        ) : null}
      </aside>

      {/* ——— Message stream + composer ——— */}
      <section className="chat-stream">
        <header className="chat-stream__head">
          <div className="chat-stream__title-wrap">
            <span className="chat-stream__title">
              {activeChannel ? activeChannel.name : "No channel selected"}
            </span>
            {activeChannel ? (
              <span className="halo halo--ok" title="Every message is signed with the sender's operator key and verified on receipt.">
                <span className="dot" /> signed
              </span>
            ) : null}
          </div>
          {activeChannel ? (
            <div className="chat-stream__sub mono">{activeChannel.sub}</div>
          ) : null}
        </header>

        <div className="chat-stream__messages" ref={scrollRef}>
          {!activeChannel ? (
            <div className="chat-stream__placeholder mono">
              Select or join a cluster channel to view messages.
            </div>
          ) : chat.messages.length === 0 ? (
            <div className="chat-stream__placeholder mono">No messages yet. Say hello.</div>
          ) : (
            streamItems.map((item) =>
              item.type === "sep" ? (
                <DaySeparator key={item.key} label={item.label} />
              ) : (
                <Message
                  key={item.msg.msg_id}
                  msg={item.msg}
                  grouped={item.grouped}
                  label={senderLabel(item.msg)}
                  now={now}
                />
              ),
            )
          )}
        </div>

        {chat.error ? (
          <div className="status-bar status-bar--warn chat-stream__error mono">
            {chat.error}
          </div>
        ) : null}

        <div className="chat-composer">
          <textarea
            className="chat-composer__input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={activeChannel ? `Message ${activeChannel.name}…` : "Join a channel to send"}
            rows={2}
            disabled={!activeChannel}
          />
          <div className="chat-composer__row">
            <span className="chat-composer__sign mono" title="Each message is signed with your operator key before it leaves the node.">
              ML-DSA-65 · auto-sign
            </span>
            <span
              className="mono"
              style={{ marginLeft: 10, fontSize: 11, opacity: 0.75 }}
            >
              Enter to send · Shift+Enter for newline
            </span>
            <span style={{ flex: 1 }} />
            <span
              className="mono"
              title={`Per-message body limit for this channel kind (${activeChannel?.kind === "ceremony" ? "ceremony" : "cluster"}).`}
              style={{
                marginRight: 10,
                fontSize: 11,
                color: overCap ? "var(--warn, #e2725b)" : undefined,
                opacity: overCap ? 1 : 0.75,
              }}
            >
              {draftBytes.toLocaleString()} / {bodyCapBytes.toLocaleString()} B
            </span>
            <button
              type="button"
              className="btn btn--gold btn--sm"
              onClick={() => void onSend()}
              disabled={!activeChannel || !draft.trim() || chat.sending || overCap}
            >
              {chat.sending ? "Sending…" : overCap ? "Too long" : "Send"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function ChannelRow({
  channel,
  active,
  onSelect,
}: {
  channel: ChatChannel;
  active: boolean;
  onSelect: () => void;
}) {
  const icon =
    channel.kind === "ceremony"
      ? "CER"
      : `C-${String(channel.cluster_id).padStart(3, "0")}`;
  return (
    <button
      type="button"
      className={`chat-channel-row${active ? " chat-channel-row--active" : ""}`}
      onClick={onSelect}
    >
      <span className="chat-channel-row__icon mono">{icon}</span>
      <span className="chat-channel-row__body">
        <span className="chat-channel-row__name">{channel.name}</span>
        <span className="chat-channel-row__sub mono">{channel.sub}</span>
      </span>
      {channel.unread_count > 0 ? (
        <span
          className="mono"
          aria-label={`${channel.unread_count} unread`}
          style={{
            marginLeft: "auto",
            alignSelf: "center",
            background: "var(--gold, #f2b441)",
            color: "#151324",
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 700,
            lineHeight: "16px",
            minWidth: 16,
            padding: "0 5px",
            textAlign: "center",
          }}
        >
          {channel.unread_count > 99 ? "99+" : channel.unread_count}
        </span>
      ) : null}
    </button>
  );
}

/** Hex 20-byte address → bech32m `mono1…` for display (ADR-0038). */
function toBech32Display(addressHex: string): string {
  try {
    return addressToBech32(addressHex);
  } catch {
    // Malformed address (should not happen for verified envelopes) —
    // fall back to the raw value rather than crash the stream.
    return addressHex;
  }
}

function shortBech(addr: string): string {
  if (addr.length <= 24) return addr;
  return `${addr.slice(0, 13)}…${addr.slice(-6)}`;
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function fmtDaySeparator(ms: number, now: number): string {
  if (dayKey(ms) === dayKey(now)) return "Today";
  if (dayKey(ms) === dayKey(now - 86_400_000)) return "Yesterday";
  const d = new Date(ms);
  return d.toLocaleDateString([], {
    year: d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
  });
}

/** "just now" / "Nm ago" within the hour, clock time beyond it. */
function fmtRelativeTime(ms: number, now: number): string {
  const delta = now - ms;
  if (delta >= 0 && delta < 60_000) return "just now";
  if (delta >= 0 && delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function DaySeparator({ label }: { label: string }) {
  return (
    <div
      className="mono cap"
      role="separator"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        margin: "14px 0 6px",
        opacity: 0.7,
        fontSize: 10,
      }}
    >
      <span style={{ flex: 1, height: 1, background: "currentColor", opacity: 0.25 }} />
      {label}
      <span style={{ flex: 1, height: 1, background: "currentColor", opacity: 0.25 }} />
    </div>
  );
}

function Message({
  msg,
  grouped,
  label,
  now,
}: {
  msg: ChatMessage;
  grouped: boolean;
  label: string;
  now: number;
}) {
  return (
    <div className={`chat-msg${grouped ? " chat-msg--grouped" : ""}`}>
      {!grouped ? (
        <div className="chat-msg__head">
          <span className="chat-msg__author">{label}</span>
          {msg.from_me ? <span className="chat-msg__you-pill mono">you</span> : null}
          <span className="chat-msg__ts mono" title={new Date(msg.timestamp_ms).toLocaleString()}>
            {fmtRelativeTime(msg.timestamp_ms, now)}
          </span>
          {msg.verified ? (
            <span className="chat-msg__signed mono" title="Signature verified locally.">
              ✓ signed
            </span>
          ) : (
            <span className="chat-msg__unverified mono" title="Signature did not verify.">
              ⚠ unverified
            </span>
          )}
        </div>
      ) : null}
      <div className="chat-msg__body">{msg.body}</div>
    </div>
  );
}
