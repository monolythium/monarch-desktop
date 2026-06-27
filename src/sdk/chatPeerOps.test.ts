import { beforeEach, describe, expect, it, vi } from "vitest";

type SubmitArg = {
  private: boolean;
  tx: {
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    to: string;
    value: bigint;
    input: string;
  };
};

const submitWithPrivacy = vi.fn(async (_arg: SubmitArg) => "0x" + "ca".repeat(32));

const fakeBackend = {
  addressBytes: () => new Uint8Array(20).fill(0x5a),
  signEvmTx: () => ({
    wireHex: "0x00",
    wireBytes: new Uint8Array(91),
    sighash: new Uint8Array(32).fill(0x6b),
    txHash: new Uint8Array(32).fill(0x7c),
  }),
};

vi.mock("@monolythium/core-sdk", () => ({
  addressToTypedBech32: () => "mono1typedoperator",
  RpcClient: class {
    endpoint: string;
    constructor(endpoint: string) {
      this.endpoint = endpoint;
    }
    ethChainId = vi.fn(async () => 69420n);
    lythGetTransactionCount = vi.fn(async () => 14n);
    lythExecutionUnitPrice = vi.fn(async () => ({
      executionUnitPriceLythoshi: "900",
      basePricePerExecutionUnitLythoshi: "900",
      priorityTipLythoshi: "1200",
      blockNumber: 1,
      source: "test",
    }));
  },
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT: 250_000n,
  nodeRegistryAddressHex: () => "0x0000000000000000000000000000000000001005",
}));

vi.mock("@monolythium/core-sdk/crypto", () => ({
  mnemonicToMlDsa65Backend: () => fakeBackend,
  submitTransactionWithPrivacy: (arg: SubmitArg) => submitWithPrivacy(arg),
}));

import {
  buildSetChatBootstrapPeersTxFields,
  CHAT_BOOTSTRAP_PEERS_MAX_BYTES,
  DEFAULT_CHAT_BOOTSTRAP_PEERS_EXECUTION_UNIT_LIMIT,
  encodeSetChatBootstrapPeersCalldata,
  normalizeChatBootstrapPeers,
  peerIdHexToBytes,
  SET_CHAT_BOOTSTRAP_PEERS_SELECTOR,
  submitChatBootstrapPeers,
} from "./chatPeerOps";

const peerIdHex = "0x" + "dd".repeat(32);
const peerA = "/ip4/127.0.0.1/tcp/41001/p2p/12D3KooWChatA";
const peerB = "/dns4/chat.example/tcp/443/wss/p2p/12D3KooWChatB";
const fee = {
  executionUnitPriceLythoshi: "900",
  priorityTipLythoshi: "1200",
};

function wordAt(calldata: string, index: number): string {
  const start = 10 + index * 64;
  return calldata.slice(start, start + 64);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("setChatBootstrapPeers calldata", () => {
  it("pins the selector and ABI layout for bytes32 plus dynamic bytes", () => {
    const calldata = encodeSetChatBootstrapPeersCalldata({
      peerIdHex,
      peers: [peerA, peerB],
    });
    const wire = new TextEncoder().encode(`${peerA}\n${peerB}`);

    expect(SET_CHAT_BOOTSTRAP_PEERS_SELECTOR).toBe("0x360a2942");
    expect(calldata.slice(0, 10)).toBe("0x360a2942");
    expect(wordAt(calldata, 0)).toBe("dd".repeat(32));
    expect(wordAt(calldata, 1)).toBe("0".repeat(62) + "40");
    expect(wordAt(calldata, 2)).toBe(wire.length.toString(16).padStart(64, "0"));
    expect(calldata).toContain(hex(wire));
    expect((calldata.length - 2 - 8) % 64).toBe(0);
  });

  it("normalizes duplicates and rejects malformed or oversized peers", () => {
    expect(normalizeChatBootstrapPeers(`${peerA},\n${peerA} ${peerB}`)).toEqual({
      peers: [peerA, peerB],
      wire: `${peerA}\n${peerB}`,
      wireBytes: new TextEncoder().encode(`${peerA}\n${peerB}`),
    });
    expect(() => peerIdHexToBytes("0x" + "dd".repeat(31))).toThrow(
      /expected 32 bytes/u,
    );
    expect(() =>
      normalizeChatBootstrapPeers("https://chat.example/p2p/12D3KooWChat"),
    ).toThrow(/invalid libp2p multiaddr/u);
    expect(() =>
      normalizeChatBootstrapPeers(`/ip4/127.0.0.1/tcp/41001/p2p/${"a".repeat(260)}`),
    ).toThrow(new RegExp(`${CHAT_BOOTSTRAP_PEERS_MAX_BYTES} bytes`, "u"));
  });
});

describe("buildSetChatBootstrapPeersTxFields", () => {
  it("targets node-registry with zero value and clamped fee tip", () => {
    const tx = buildSetChatBootstrapPeersTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      peerIdHex,
      peers: peerA,
    });

    expect(DEFAULT_CHAT_BOOTSTRAP_PEERS_EXECUTION_UNIT_LIMIT).toBe(250_000n);
    expect(tx.gasLimit).toBe(250_000n);
    expect(tx.maxFeePerGas).toBe(900n);
    expect(tx.maxPriorityFeePerGas).toBe(900n);
    expect(tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(tx.value).toBe(0n);
    expect(typeof tx.input).toBe("string");
    expect((tx.input as string).startsWith("0x360a2942")).toBe(true);
  });
});

describe("submitChatBootstrapPeers", () => {
  beforeEach(() => {
    submitWithPrivacy.mockClear();
  });

  it("submits a plaintext operator metadata tx through the SDK signer", async () => {
    const res = await submitChatBootstrapPeers({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "operator mnemonic",
      peerIdHex,
      peers: [peerA, peerB],
    });

    expect(submitWithPrivacy).toHaveBeenCalledTimes(1);
    const call = submitWithPrivacy.mock.calls[0]![0];
    expect(call.private).toBe(false);
    expect(call.tx.gasLimit).toBe(250_000n);
    expect(call.tx.maxFeePerGas).toBe(900n);
    expect(call.tx.maxPriorityFeePerGas).toBe(900n);
    expect(call.tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(call.tx.input.startsWith("0x360a2942")).toBe(true);
    expect(res.txHash).toBe("0x" + "ca".repeat(32));
    expect(res.peerIdHex).toBe(peerIdHex);
    expect(res.peerCount).toBe(2);
    expect(res.peersWire).toBe(`${peerA}\n${peerB}`);
    expect(res.envelopeWireBytes).toBe(91);
    expect(res.innerSighashHex).toBe("0x" + "6b".repeat(32));
  });
});
