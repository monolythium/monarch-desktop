import { describe, expect, it } from "vitest";
import { isChatBootstrapPeersInputComplete } from "./ChatBootstrapPeersForm";

const peerIdHex = "0x" + "ab".repeat(32);
const peerA = "/ip4/127.0.0.1/tcp/41001/p2p/12D3KooWChatA";
const peerB = "/dns4/chat.example/tcp/443/wss/p2p/12D3KooWChatB";

describe("chat bootstrap peer input validation", () => {
  it("requires a 32-byte peer id and at least one bounded libp2p multiaddr", () => {
    expect(isChatBootstrapPeersInputComplete(undefined)).toBe(false);
    expect(
      isChatBootstrapPeersInputComplete({
        peerIdHex: "0x" + "ab".repeat(31),
        peers: peerA,
      }),
    ).toBe(false);
    expect(
      isChatBootstrapPeersInputComplete({
        peerIdHex,
        peers: "https://chat.example",
      }),
    ).toBe(false);
    expect(
      isChatBootstrapPeersInputComplete({
        peerIdHex,
        peers: `/ip4/127.0.0.1/tcp/41001/p2p/${"a".repeat(260)}`,
      }),
    ).toBe(false);
    expect(
      isChatBootstrapPeersInputComplete({
        peerIdHex,
        peers: `${peerA},\n${peerB}`,
      }),
    ).toBe(true);
  });
});
