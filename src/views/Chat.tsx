// Chat — signed operator-to-operator messaging (Phase 1 MVP).
//
// Mirrors `designs/src/chat.jsx`: a channel list (left), a message
// stream + composer (center). The design's right-hand channel-detail pane,
// reactions, and attachment cards are later-phase surfaces and are
// intentionally omitted here — the MVP ships cluster channels with
// signed send/receive over gossipsub, local SQLite history, and live
// membership gating (all wired in `src-tauri/src/chat.rs` +
// `hooks/useChat.ts`).
//
// Every message carries an ML-DSA-65 signature the Rust side verified on
// receipt; the "signed" badge reflects that verification, not a UI
// claim. The view stays presentational — all networking + crypto lives
// in the Rust `chat` module.

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../hooks/useChat";
import { useClusterDirectory } from "../sdk";
import type { ChatChannel, ChatMessage } from "../sdk/chat";

export function Chat() {
  const chat = useChat();
  const directory = useClusterDirectory();
  const [draft, setDraft] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const activeChannel = chat.channels.find((c) => c.channel_id === chat.activeChannelId) ?? null;

  // Auto-scroll to the newest message on channel switch / new message.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chat.activeChannelId, chat.messages.length]);

  const onSend = async () => {
    const body = draft.trim();
    if (!body || chat.sending) return;
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

  return (
    <div className="chat-shell">
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
          {chat.channels.length === 0 ? (
            <div className="mono chat-channels__empty">
              {chat.loading ? "loading…" : "join a cluster to start"}
            </div>
          ) : (
            chat.channels.map((c) => (
              <ChannelRow
                key={c.channel_id}
                channel={c}
                active={c.channel_id === chat.activeChannelId}
                onSelect={() => chat.selectChannel(c.channel_id)}
              />
            ))
          )}
        </div>
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
            chat.messages.map((m, i) => (
              <Message key={m.msg_id} msg={m} prev={chat.messages[i - 1] ?? null} />
            ))
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
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn--gold btn--sm"
              onClick={() => void onSend()}
              disabled={!activeChannel || !draft.trim() || chat.sending}
            >
              {chat.sending ? "Sending…" : "Send"}
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
  return (
    <button
      type="button"
      className={`chat-channel-row${active ? " chat-channel-row--active" : ""}`}
      onClick={onSelect}
    >
      <span className="chat-channel-row__icon mono">C-{String(channel.cluster_id).padStart(3, "0")}</span>
      <span className="chat-channel-row__body">
        <span className="chat-channel-row__name">{channel.name}</span>
        <span className="chat-channel-row__sub mono">{channel.sub}</span>
      </span>
    </button>
  );
}

function shortAddr(addr: string): string {
  const clean = addr.startsWith("0x") ? addr.slice(2) : addr;
  if (clean.length <= 12) return addr;
  return `${addr.slice(0, 8)}…${clean.slice(-4)}`;
}

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Message({ msg, prev }: { msg: ChatMessage; prev: ChatMessage | null }) {
  // Group consecutive messages from the same sender within 5 minutes.
  const grouped =
    prev !== null &&
    prev.sender_address === msg.sender_address &&
    msg.timestamp_ms - prev.timestamp_ms < 5 * 60 * 1000;

  const label = msg.from_me ? "you" : shortAddr(msg.sender_address);

  return (
    <div className={`chat-msg${grouped ? " chat-msg--grouped" : ""}`}>
      {!grouped ? (
        <div className="chat-msg__head">
          <span className="chat-msg__author">{label}</span>
          {msg.from_me ? <span className="chat-msg__you-pill mono">you</span> : null}
          <span className="chat-msg__ts mono">{fmtTs(msg.timestamp_ms)}</span>
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
