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

const submitWithPrivacy = vi.fn(async (_arg: SubmitArg) => "0x" + "cd".repeat(32));
const encodeRedelegateCalldata = vi.fn(
  (fromCluster: number, toCluster: number, weightBps: number) =>
    `0xa06ac18f:${fromCluster}:${toCluster}:${weightBps}`,
);

const fakeBackend = {
  addressBytes: () => new Uint8Array(20).fill(0x44),
  signEvmTx: () => ({
    wireHex: "0x00",
    wireBytes: new Uint8Array(96),
    sighash: new Uint8Array(32).fill(0x55),
    txHash: new Uint8Array(32).fill(0x66),
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
    lythGetTransactionCount = vi.fn(async () => 8n);
    lythExecutionUnitPrice = vi.fn(async () => ({
      executionUnitPriceLythoshi: "900",
      basePricePerExecutionUnitLythoshi: "900",
      priorityTipLythoshi: "1200",
      blockNumber: 1,
      source: "test",
    }));
  },
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT: 250_000n,
  delegationAddressHex: () => "0x000000000000000000000000000000000000100a",
  encodeRedelegateCalldata: (
    fromCluster: number,
    toCluster: number,
    weightBps: number,
  ) => encodeRedelegateCalldata(fromCluster, toCluster, weightBps),
}));

vi.mock("@monolythium/core-sdk/crypto", () => ({
  pqm1MnemonicToMlDsa65Backend: () => fakeBackend,
  submitTransactionWithPrivacy: (arg: SubmitArg) => submitWithPrivacy(arg),
}));

import {
  buildRedelegateTxFields,
  DEFAULT_REDELEGATE_EXECUTION_UNIT_LIMIT,
  submitRedelegate,
} from "./delegationOps";

const fee = {
  executionUnitPriceLythoshi: "900",
  priorityTipLythoshi: "1200",
};

describe("buildRedelegateTxFields", () => {
  beforeEach(() => {
    encodeRedelegateCalldata.mockClear();
  });

  it("targets the delegation precompile with a zero-value redelegate call", () => {
    const tx = buildRedelegateTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      fromCluster: 1,
      toCluster: 2,
      weightBps: 7500,
    });

    expect(DEFAULT_REDELEGATE_EXECUTION_UNIT_LIMIT).toBe(250_000n);
    expect(tx.gasLimit).toBe(250_000n);
    expect(tx.maxFeePerGas).toBe(900n);
    expect(tx.maxPriorityFeePerGas).toBe(900n);
    expect(tx.to).toBe("0x000000000000000000000000000000000000100a");
    expect(tx.value).toBe(0n);
    expect(tx.input).toBe("0xa06ac18f:1:2:7500");
    expect(encodeRedelegateCalldata).toHaveBeenCalledWith(1, 2, 7500);
  });

  it("honours an explicit execution-unit-limit override", () => {
    const tx = buildRedelegateTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      fromCluster: 3,
      toCluster: 4,
      weightBps: 10000,
      executionUnitLimit: 300_000n,
    });
    expect(tx.gasLimit).toBe(300_000n);
  });

  it("rejects invalid cluster and weight inputs before encoding calldata", () => {
    expect(() => buildRedelegateTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      fromCluster: 1,
      toCluster: 1,
      weightBps: 1000,
    })).toThrow(/toCluster must differ/u);

    expect(() => buildRedelegateTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      fromCluster: 1,
      toCluster: 2,
      weightBps: 10001,
    })).toThrow(/weightBps: expected integer 1\.\.10000/u);
    expect(encodeRedelegateCalldata).not.toHaveBeenCalled();
  });
});

describe("submitRedelegate", () => {
  beforeEach(() => {
    submitWithPrivacy.mockClear();
    encodeRedelegateCalldata.mockClear();
  });

  it("submits a plaintext native tx through the SDK signer", async () => {
    const res = await submitRedelegate({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      fromCluster: 1,
      toCluster: 2,
      weightBps: 5000,
    });

    expect(submitWithPrivacy).toHaveBeenCalledTimes(1);
    const call = submitWithPrivacy.mock.calls[0]![0];
    expect(call.private).toBe(false);
    expect(call.tx.gasLimit).toBe(250_000n);
    expect(call.tx.maxFeePerGas).toBe(900n);
    expect(call.tx.maxPriorityFeePerGas).toBe(900n);
    expect(call.tx.to).toBe("0x000000000000000000000000000000000000100a");
    expect(call.tx.input).toBe("0xa06ac18f:1:2:5000");
    expect(res.txHash).toBe("0x" + "cd".repeat(32));
    expect(res.envelopeWireBytes).toBe(96);
    expect(res.innerSighashHex).toBe("0x" + "55".repeat(32));
  });
});
