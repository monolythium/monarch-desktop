// Inline form for the operator-callable
// `setChatBootstrapPeers(bytes32,bytes)` node-registry metadata path.

import { useEffect, useMemo, type CSSProperties } from "react";
import {
  CHAT_BOOTSTRAP_PEERS_MAX_BYTES,
  normalizeChatBootstrapPeers,
} from "../sdk/chatPeerOps";
import { getStoredChatBootstrapPeers } from "../sdk/chatConfig";
import { useOps } from "./OpsContext";
import type { ChatBootstrapPeersInput } from "./types";

function normalizePeerId(value: string): string {
  const clean = value.trim().replace(/^0x/iu, "");
  return clean ? `0x${clean.toLowerCase()}` : "";
}

function isPeerIdHex(value: string | undefined): boolean {
  if (!value) return false;
  return /^0x[0-9a-fA-F]{64}$/u.test(value.trim());
}

function peersStatus(value: string | undefined): {
  ok: boolean;
  count: number;
  bytes: number;
  message: string;
} {
  if (!value || !value.trim()) {
    return { ok: false, count: 0, bytes: 0, message: "Enter at least one chat multiaddr." };
  }
  try {
    const normalized = normalizeChatBootstrapPeers(value);
    return {
      ok: true,
      count: normalized.peers.length,
      bytes: normalized.wireBytes.length,
      message: `${normalized.peers.length} peer${normalized.peers.length === 1 ? "" : "s"} · ${normalized.wireBytes.length}/${CHAT_BOOTSTRAP_PEERS_MAX_BYTES} bytes`,
    };
  } catch (err) {
    return {
      ok: false,
      count: 0,
      bytes: 0,
      message: (err as Error).message,
    };
  }
}

function inputStyle(valid: boolean): CSSProperties {
  return {
    background: "rgba(0,0,0,0.3)",
    border: valid
      ? "1px solid rgba(255,255,255,0.1)"
      : "1px solid var(--err-500, #c53030)",
    color: "var(--fg-200)",
    padding: "6px 8px",
    fontSize: 12,
    borderRadius: 6,
    fontFamily: "var(--font-mono, monospace)",
  };
}

export function ChatBootstrapPeersForm() {
  const { request, setChatBootstrapPeersInput } = useOps();
  const input = request?.chatBootstrapPeersInput;

  useEffect(() => {
    if (!request || request.kind !== "chat-bootstrap-peers") return;
    if (input?.peers?.trim()) return;
    const stored = getStoredChatBootstrapPeers();
    if (stored.length > 0) {
      setChatBootstrapPeersInput({ peers: stored.join("\n") });
    }
  }, [input?.peers, request, setChatBootstrapPeersInput]);

  const validity = useMemo(() => {
    const peerIdOk = isPeerIdHex(input?.peerIdHex);
    const peers = peersStatus(input?.peers);
    return { peerIdOk, peers };
  }, [input?.peerIdHex, input?.peers]);

  if (!request || request.kind !== "chat-bootstrap-peers") return null;

  const current: Partial<ChatBootstrapPeersInput> = input ?? {};

  return (
    <div className="card" style={{ background: "rgba(255,255,255,0.02)", marginTop: 12 }}>
      <div className="cap" style={{ marginBottom: 8 }}>chat bootstrap metadata</div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">Operator peer id</span>
        <input
          type="text"
          inputMode="text"
          placeholder={`0x${"00".repeat(32)}`}
          value={current.peerIdHex ?? ""}
          onChange={(e) => setChatBootstrapPeersInput({ peerIdHex: normalizePeerId(e.target.value) })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          style={inputStyle(validity.peerIdOk)}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          Must match the owner registration row keyed by node-registry peer id.
        </span>
      </label>

      <label
        className="kv"
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginTop: 12 }}
      >
        <span className="kv__k">Chat bootstrap peers</span>
        <textarea
          placeholder="/dns4/chat.example/tcp/443/wss/p2p/12D3KooW..."
          value={current.peers ?? ""}
          onChange={(e) => setChatBootstrapPeersInput({ peers: e.target.value })}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          rows={4}
          style={{ ...inputStyle(validity.peers.ok), resize: "vertical" }}
        />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          {validity.peers.message}
        </span>
      </label>
    </div>
  );
}

export function isChatBootstrapPeersInputComplete(
  input: ChatBootstrapPeersInput | undefined,
): boolean {
  return !!input && isPeerIdHex(input.peerIdHex) && peersStatus(input.peers).ok;
}
