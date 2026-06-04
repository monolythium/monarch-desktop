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

const submitWithPrivacy = vi.fn(async (_arg: SubmitArg) => "0x" + "ac".repeat(32));
let ethCallResponse = "0x" + "00".repeat(8 * 32);
let ethCallFailure: Error | null = null;
const rpcCalls: Array<{ method: string; params?: unknown }> = [];
let transactionCountReads = 0;
const transactionCountAddresses: string[] = [];

const fakeBackend = {
  addressBytes: () => new Uint8Array(20).fill(0x44),
  signEvmTx: () => ({
    wireHex: "0x00",
    wireBytes: new Uint8Array(112),
    sighash: new Uint8Array(32).fill(0x77),
    txHash: new Uint8Array(32).fill(0x88),
  }),
};

vi.mock("@monolythium/core-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@monolythium/core-sdk")>();
  return {
    ...actual,
    RpcClient: class {
      endpoint: string;
      constructor(endpoint: string) {
        this.endpoint = endpoint;
      }
      call = vi.fn(async (method: string, params?: unknown) => {
        rpcCalls.push({ method, params });
        if (ethCallFailure) throw ethCallFailure;
        return ethCallResponse;
      });
      ethChainId = vi.fn(async () => 69420n);
      lythGetTransactionCount = vi.fn(async (address: string) => {
        transactionCountReads += 1;
        transactionCountAddresses.push(address);
        return 18n;
      });
      lythExecutionUnitPrice = vi.fn(async () => ({
        executionUnitPriceLythoshi: "800",
        basePricePerExecutionUnitLythoshi: "800",
        priorityTipLythoshi: "950",
        blockNumber: 1,
        source: "test",
      }));
    },
    REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT: 250_000n,
    addressToTypedBech32: () => "mono1typedoperator",
    nodeRegistryAddressHex: () => "0x0000000000000000000000000000000000001005",
  };
});

vi.mock("@monolythium/core-sdk/crypto", () => ({
  pqm1MnemonicToMlDsa65Backend: () => fakeBackend,
  submitTransactionWithPrivacy: (arg: SubmitArg) => submitWithPrivacy(arg),
}));

import {
  DEFAULT_CLUSTER_JOIN_EXECUTION_UNIT_LIMIT,
  REQUEST_CLUSTER_JOIN_SELECTOR,
  VOTE_CLUSTER_ADMIT_SELECTOR,
  deriveClusterJoinOperatorIdHex,
  submitRequestClusterJoin,
  submitVoteClusterAdmit,
} from "./clusterJoinOps";
import { NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES } from "./operatorKeys";

const operatorPubkeyHex = "0x" + "44".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES);
const voterPubkeyHex = "0x" + "55".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES);
const operatorIdHex = "0x" + "66".repeat(32);

function word(value: bigint | number | string): string {
  if (typeof value === "string" && value.startsWith("0x")) {
    return value.slice(2).padStart(64, "0");
  }
  return BigInt(value).toString(16).padStart(64, "0");
}

function requestView(status: number): string {
  const owner = status === 0 ? "0x" + "00".repeat(20) : "0x" + "77".repeat(20);
  return `0x${[
    word(owner),
    word(9),
    word(7),
    word(10),
    word(status === 1 ? 3 : 7),
    word(status),
    word(5000),
    word(1),
  ].join("")}`;
}

describe("CJ-1 submit helpers", () => {
  beforeEach(() => {
    submitWithPrivacy.mockClear();
    rpcCalls.length = 0;
    transactionCountAddresses.length = 0;
    transactionCountReads = 0;
    ethCallFailure = null;
    ethCallResponse = requestView(0);
  });

  it("submits requestClusterJoin as a plaintext native tx after the CJ-1 view preflight", async () => {
    const res = await submitRequestClusterJoin({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      clusterId: 7,
      operatorPubkeyHex,
      bondLythoshi: "9000",
    });

    expect(rpcCalls[0]?.method).toBe("eth_call");
    expect(submitWithPrivacy).toHaveBeenCalledTimes(1);
    const call = submitWithPrivacy.mock.calls[0]![0];
    expect(call.private).toBe(false);
    expect(call.tx.gasLimit).toBe(DEFAULT_CLUSTER_JOIN_EXECUTION_UNIT_LIMIT);
    expect(call.tx.maxPriorityFeePerGas).toBe(800n);
    expect(call.tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(call.tx.value).toBe(9000n);
    expect(call.tx.input.startsWith(REQUEST_CLUSTER_JOIN_SELECTOR)).toBe(true);
    expect(transactionCountAddresses).toEqual(["mono1typedoperator"]);
    expect(res.txHash).toBe("0x" + "ac".repeat(32));
    expect(res.operatorIdHex).toBe(deriveClusterJoinOperatorIdHex(operatorPubkeyHex));
    expect(res.innerSighashHex).toBe("0x" + "77".repeat(32));
    expect(res.envelopeWireBytes).toBe(112);
  });

  it("submits voteClusterAdmit only when the candidate request is open", async () => {
    ethCallResponse = requestView(1);

    const res = await submitVoteClusterAdmit({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      clusterId: "7",
      operatorIdHex,
      voterPubkeyHex,
    });

    expect(submitWithPrivacy).toHaveBeenCalledTimes(1);
    const call = submitWithPrivacy.mock.calls[0]![0];
    expect(call.private).toBe(false);
    expect(call.tx.value).toBe(0n);
    expect(call.tx.input.startsWith(VOTE_CLUSTER_ADMIT_SELECTOR)).toBe(true);
    expect(transactionCountAddresses).toEqual(["mono1typedoperator"]);
    expect(res.clusterId).toBe("7");
    expect(res.operatorIdHex).toBe(operatorIdHex);
  });

  it("does not sign or broadcast when the connected runtime does not expose CJ-1", async () => {
    ethCallFailure = new Error("method not found");

    await expect(submitRequestClusterJoin({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      clusterId: 7,
      operatorPubkeyHex,
      bondLythoshi: "9000",
    })).rejects.toThrow(/getClusterJoinRequest is not exposed/u);

    expect(submitWithPrivacy).not.toHaveBeenCalled();
    expect(transactionCountReads).toBe(0);
  });

  it("does not broadcast an admit vote when no open candidate request exists", async () => {
    ethCallResponse = requestView(0);

    await expect(submitVoteClusterAdmit({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      clusterId: 7,
      operatorIdHex,
      voterPubkeyHex,
    })).rejects.toThrow(/not open for voting/u);

    expect(submitWithPrivacy).not.toHaveBeenCalled();
    expect(transactionCountReads).toBe(0);
  });
});
