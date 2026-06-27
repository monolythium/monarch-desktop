import { beforeEach, describe, expect, it, vi } from "vitest";

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

const submitPlain = vi.fn(async (_arg: SubmitArg) => "0x" + "de".repeat(32));

const fakeBackend = {
  addressBytes: () => new Uint8Array(20).fill(0x77),
  signEvmTx: () => ({
    wireHex: "0x00",
    wireBytes: new Uint8Array(88),
    sighash: new Uint8Array(32).fill(0x88),
    txHash: new Uint8Array(32).fill(0x99),
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
    lythGetTransactionCount = vi.fn(async () => 9n);
    lythExecutionUnitPrice = vi.fn(async () => ({
      executionUnitPriceLythoshi: "700",
      basePricePerExecutionUnitLythoshi: "700",
      priorityTipLythoshi: "900",
      blockNumber: 1,
      source: "test",
    }));
  },
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT: 250_000n,
  nodeRegistryAddressHex: () => "0x0000000000000000000000000000000000001005",
}));

vi.mock("@monolythium/core-sdk/crypto", () => ({
  mnemonicToMlDsa65Backend: () => fakeBackend,
  submitTransaction: (arg: SubmitArg) => submitPlain(arg),
}));

import {
  buildRecoverOperatorNodeTxFields,
  DEFAULT_RECOVER_OPERATOR_NODE_EXECUTION_UNIT_LIMIT,
  encodeRecoverOperatorNodeCalldata,
  peerIdHexToBytes,
  RECOVER_OPERATOR_NODE_SELECTOR,
  submitRecoverOperatorNode,
} from "./recoveryOps";

const peerIdHex = "0x" + "cc".repeat(32);
const fee = {
  executionUnitPriceLythoshi: "700",
  priorityTipLythoshi: "900",
};

describe("recoverOperatorNode calldata", () => {
  it("pins the selector and peer id ABI shape", () => {
    expect(RECOVER_OPERATOR_NODE_SELECTOR).toBe("0xe58729e6");
    expect(encodeRecoverOperatorNodeCalldata(peerIdHex)).toBe(
      "0xe58729e6" + "cc".repeat(32),
    );
  });

  it("rejects malformed peer ids before building calldata", () => {
    expect(() => peerIdHexToBytes("0x" + "cc".repeat(31))).toThrow(
      /expected 32 bytes/u,
    );
    expect(() => peerIdHexToBytes("0x" + "cc".repeat(31) + "zz")).toThrow(
      /invalid hex/u,
    );
  });
});

describe("buildRecoverOperatorNodeTxFields", () => {
  it("targets the node-registry precompile with zero value", () => {
    const tx = buildRecoverOperatorNodeTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      peerIdHex,
    });

    expect(DEFAULT_RECOVER_OPERATOR_NODE_EXECUTION_UNIT_LIMIT).toBe(250_000n);
    expect(tx.gasLimit).toBe(250_000n);
    expect(tx.maxFeePerGas).toBe(700n);
    expect(tx.maxPriorityFeePerGas).toBe(700n);
    expect(tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(tx.value).toBe(0n);
    expect(tx.input).toBe("0xe58729e6" + "cc".repeat(32));
  });

  it("honours an explicit execution-unit-limit override", () => {
    const tx = buildRecoverOperatorNodeTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      peerIdHex,
      executionUnitLimit: 300_000n,
    });
    expect(tx.gasLimit).toBe(300_000n);
  });
});

describe("submitRecoverOperatorNode", () => {
  beforeEach(() => {
    submitPlain.mockClear();
  });

  it("submits a plaintext foundation recovery tx through the SDK signer", async () => {
    const res = await submitRecoverOperatorNode({
      rpcUrl: "http://127.0.0.1:8545",
      foundationMnemonic: "foundation mnemonic",
      peerIdHex,
    });

    expect(submitPlain).toHaveBeenCalledTimes(1);
    const call = submitPlain.mock.calls[0]![0];
    expect(call.tx.gasLimit).toBe(250_000n);
    expect(call.tx.maxFeePerGas).toBe(700n);
    expect(call.tx.maxPriorityFeePerGas).toBe(700n);
    expect(call.tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(call.tx.input).toBe("0xe58729e6" + "cc".repeat(32));
    expect(res.txHash).toBe("0x" + "de".repeat(32));
    expect(res.envelopeWireBytes).toBe(88);
    expect(res.innerSighashHex).toBe("0x" + "88".repeat(32));
  });
});
