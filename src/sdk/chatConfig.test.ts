import { describe, expect, it, vi } from "vitest";
import {
  discoverClusterChatBootstrapPeers,
  extractChatBootstrapPeersFromOperatorMetadata,
  parseChatBootstrapPeers,
  resolveChatBootstrapPeersForCluster,
  setStoredChatBootstrapPeers,
} from "./chatConfig";

describe("chat bootstrap peer config", () => {
  it("parses comma, newline, and whitespace separated multiaddrs", () => {
    expect(parseChatBootstrapPeers(`
      /ip4/127.0.0.1/tcp/41001/p2p/peer-a,
      /dns4/chat.example/tcp/443/wss/p2p/peer-b
      /ip6/::1/tcp/41002/p2p/peer-c
    `)).toEqual([
      "/ip4/127.0.0.1/tcp/41001/p2p/peer-a",
      "/dns4/chat.example/tcp/443/wss/p2p/peer-b",
      "/ip6/::1/tcp/41002/p2p/peer-c",
    ]);
  });

  it("drops empty entries and normalizes persisted values", () => {
    expect(setStoredChatBootstrapPeers([" /ip4/127.0.0.1/tcp/41001/p2p/peer-a ", ""]))
      .toEqual(["/ip4/127.0.0.1/tcp/41001/p2p/peer-a"]);
  });

  it("extracts only explicit chat libp2p multiaddrs from operator metadata", () => {
    expect(extractChatBootstrapPeersFromOperatorMetadata({
      bootstrapPeers: ["/ip4/127.0.0.1/tcp/1/p2p/not-chat"],
      chat: {
        bootstrapPeers: [
          "/dns4/chat-a.monolythium.test/tcp/443/wss/p2p/12D3KooWChatA",
          "https://chat-a.monolythium.test",
        ],
      },
      libp2p: {
        chatBootstrapPeers: "/ip4/127.0.0.1/tcp/41001/p2p/12D3KooWChatB",
      },
      services: [
        {
          name: "operator-chat",
          multiaddr: "/dnsaddr/chat-c.monolythium.test/p2p/12D3KooWChatC",
        },
        {
          name: "metrics",
          multiaddr: "/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWMetrics",
        },
      ],
    })).toEqual([
      "/dns4/chat-a.monolythium.test/tcp/443/wss/p2p/12D3KooWChatA",
      "/ip4/127.0.0.1/tcp/41001/p2p/12D3KooWChatB",
      "/dnsaddr/chat-c.monolythium.test/p2p/12D3KooWChatC",
    ]);
  });

  it("discovers chat bootstrap peers from live cluster operator metadata", async () => {
    const client = {
      lythClusterStatus: vi.fn(async () => ({
        members: [
          { operatorId: "0x" + "a".repeat(64) },
          { operatorId: "0x" + "b".repeat(64) },
        ],
      })),
      lythGetOperatorNetworkMetadata: vi.fn(async (operatorId: string) =>
        operatorId.endsWith("a")
          ? {
            operatorId,
            chat: {
              bootstrapPeers: [
                "/ip4/127.0.0.1/tcp/41001/p2p/12D3KooWChatA",
              ],
            },
          }
          : {
            operatorId,
            monarchChat: {
              multiaddrs: [
                "/ip4/127.0.0.1/tcp/41002/p2p/12D3KooWChatB",
                "/ip4/127.0.0.1/tcp/41001/p2p/12D3KooWChatA",
              ],
            },
          }),
    };

    await expect(discoverClusterChatBootstrapPeers({
      clusterId: 7,
      client,
    })).resolves.toEqual([
      "/ip4/127.0.0.1/tcp/41001/p2p/12D3KooWChatA",
      "/ip4/127.0.0.1/tcp/41002/p2p/12D3KooWChatB",
    ]);
    expect(client.lythClusterStatus).toHaveBeenCalledWith(7);
    expect(client.lythGetOperatorNetworkMetadata).toHaveBeenCalledTimes(2);
  });

  it("merges configured peers with discovered peers", async () => {
    const client = {
      lythClusterStatus: vi.fn(async () => ({
        members: [{ operatorId: "0x" + "a".repeat(64) }],
      })),
      lythGetOperatorNetworkMetadata: vi.fn(async () => ({
        chatBootstrapPeers: [
          "/ip4/127.0.0.1/tcp/41002/p2p/12D3KooWChatB",
        ],
      })),
    };

    await expect(resolveChatBootstrapPeersForCluster({
      clusterId: 7,
      configuredPeers: [
        "/ip4/127.0.0.1/tcp/41001/p2p/12D3KooWChatA",
      ],
      client,
    })).resolves.toEqual([
      "/ip4/127.0.0.1/tcp/41001/p2p/12D3KooWChatA",
      "/ip4/127.0.0.1/tcp/41002/p2p/12D3KooWChatB",
    ]);
  });
});
