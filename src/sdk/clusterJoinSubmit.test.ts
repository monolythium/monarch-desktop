import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorOnboardingPreview } from "./clusterJoinOps";

type SubmitArg = {
  tx: {
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    to: string;
    value: bigint;
    input: string;
  };
};

const submitPlain = vi.fn(async (_arg: SubmitArg) => "0x" + "ac".repeat(32));
let previewResponse: OperatorOnboardingPreview = {
  schemaVersion: 1,
  capability: "operatorOnboardingRpcV1",
  method: "requestClusterJoin",
  ok: true,
  status: "ok",
  reason: null,
  message: null,
};
let previewFailure: Error | null = null;
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
        if (previewFailure) throw previewFailure;
        return previewResponse;
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
  mnemonicToMlDsa65Backend: () => fakeBackend,
  submitTransaction: (arg: SubmitArg) => submitPlain(arg),
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

describe("CJ-1 submit helpers", () => {
  beforeEach(() => {
    submitPlain.mockClear();
    rpcCalls.length = 0;
    transactionCountAddresses.length = 0;
    transactionCountReads = 0;
    previewFailure = null;
    previewResponse = {
      schemaVersion: 1,
      capability: "operatorOnboardingRpcV1",
      method: "requestClusterJoin",
      ok: true,
      status: "ok",
      reason: null,
      message: null,
    };
  });

  it("submits requestClusterJoin as a plaintext native tx after native preview", async () => {
    const res = await submitRequestClusterJoin({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      clusterId: 7,
      operatorPubkeyHex,
      bondLythoshi: "9000",
    });

    expect(rpcCalls[0]?.method).toBe("lyth_previewRequestClusterJoin");
    expect(rpcCalls[0]?.params).toMatchObject([{
      from: "mono1typedoperator",
      clusterId: 7,
      operatorPubkey: operatorPubkeyHex,
      bondLythoshi: "9000",
    }]);
    expect(submitPlain).toHaveBeenCalledTimes(1);
    const call = submitPlain.mock.calls[0]![0];
    // v2 plaintext mempool — the tx is signed and submitted in the clear.
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
    previewResponse = {
      schemaVersion: 1,
      capability: "operatorOnboardingRpcV1",
      method: "voteClusterAdmit",
      ok: true,
      status: "ok",
      reason: null,
      message: null,
    };

    const res = await submitVoteClusterAdmit({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      clusterId: "7",
      operatorIdHex,
      voterPubkeyHex,
    });

    expect(rpcCalls[0]?.method).toBe("lyth_previewVoteClusterAdmit");
    expect(rpcCalls[0]?.params).toMatchObject([{
      from: "mono1typedoperator",
      clusterId: 7,
      operatorId: operatorIdHex,
      voterPubkey: voterPubkeyHex,
    }]);
    expect(submitPlain).toHaveBeenCalledTimes(1);
    const call = submitPlain.mock.calls[0]![0];
    expect(call.tx.value).toBe(0n);
    expect(call.tx.input.startsWith(VOTE_CLUSTER_ADMIT_SELECTOR)).toBe(true);
    expect(transactionCountAddresses).toEqual(["mono1typedoperator"]);
    expect(res.clusterId).toBe("7");
    expect(res.operatorIdHex).toBe(operatorIdHex);
  });

  it("does not sign or broadcast when the connected runtime does not expose native preview", async () => {
    previewFailure = new Error("method not found");

    await expect(submitRequestClusterJoin({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      clusterId: 7,
      operatorPubkeyHex,
      bondLythoshi: "9000",
    })).rejects.toThrow(/Join-request preview is unavailable/u);

    expect(submitPlain).not.toHaveBeenCalled();
    expect(transactionCountReads).toBe(0);
  });

  it("does not broadcast an admit vote when preview rejects the candidate", async () => {
    previewResponse = {
      schemaVersion: 1,
      capability: "operatorOnboardingRpcV1",
      method: "voteClusterAdmit",
      ok: false,
      status: "rejected",
      reason: "request_not_open",
      message: "candidate join request is not open",
    };

    await expect(submitVoteClusterAdmit({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      clusterId: 7,
      operatorIdHex,
      voterPubkeyHex,
    })).rejects.toThrow(/voteClusterAdmit preview rejected: request_not_open/u);

    expect(submitPlain).not.toHaveBeenCalled();
    expect(transactionCountReads).toBe(0);
  });
});
