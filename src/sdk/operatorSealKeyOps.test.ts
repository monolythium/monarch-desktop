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

const submitWithPrivacy = vi.fn(async (_arg: SubmitArg) => "0x" + "ab".repeat(32));

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
  pqm1MnemonicToMlDsa65Backend: () => fakeBackend,
  submitTransactionWithPrivacy: (arg: SubmitArg) => submitWithPrivacy(arg),
}));

import {
  buildPublishOperatorSealKeyTxFields,
  DEFAULT_OPERATOR_SEAL_KEY_EXECUTION_UNIT_LIMIT,
  encodeGetOperatorSealKeyCalldata,
  encodePublishOperatorSealKeyCalldata,
  GET_OPERATOR_SEAL_KEY_SELECTOR,
  normalizeOperatorSealKey,
  OPERATOR_SEAL_EK_BYTES,
  operatorSealEkHexToBytes,
  operatorSealKeyPeerIdHexToBytes,
  PUBLISH_OPERATOR_SEAL_KEY_SELECTOR,
  submitOperatorSealKey,
} from "./operatorSealKeyOps";

const peerIdHex = "0x" + "dd".repeat(32);
const sealEkHex = "0x" + "66".repeat(OPERATOR_SEAL_EK_BYTES);
const fee = {
  executionUnitPriceLythoshi: "900",
  priorityTipLythoshi: "1200",
};

function wordAt(calldata: string, index: number): string {
  const start = 10 + index * 64;
  return calldata.slice(start, start + 64);
}

describe("publishOperatorSealKey calldata", () => {
  it("pins the selector and ABI layout for bytes32 plus dynamic EK bytes", () => {
    const calldata = encodePublishOperatorSealKeyCalldata({ peerIdHex, sealEkHex });

    expect(PUBLISH_OPERATOR_SEAL_KEY_SELECTOR).toBe("0x0490b9a8");
    expect(GET_OPERATOR_SEAL_KEY_SELECTOR).toBe("0xfcbb69a6");
    expect(calldata.slice(0, 10)).toBe("0x0490b9a8");
    expect(wordAt(calldata, 0)).toBe("dd".repeat(32));
    expect(wordAt(calldata, 1)).toBe("0".repeat(62) + "40");
    expect(wordAt(calldata, 2)).toBe(OPERATOR_SEAL_EK_BYTES.toString(16).padStart(64, "0"));
    expect(calldata.endsWith("66".repeat(OPERATOR_SEAL_EK_BYTES))).toBe(true);
    expect((calldata.length - 2 - 8) % 64).toBe(0);

    const get = encodeGetOperatorSealKeyCalldata({ operatorIdHex: peerIdHex });
    expect(get).toBe("0xfcbb69a6" + "dd".repeat(32));
  });

  it("validates peer id and EK bytes", () => {
    expect(operatorSealKeyPeerIdHexToBytes(peerIdHex).length).toBe(32);
    expect(operatorSealEkHexToBytes(sealEkHex).length).toBe(OPERATOR_SEAL_EK_BYTES);
    expect(normalizeOperatorSealKey({ peerIdHex, sealEkHex }).sealEkBytes.length).toBe(
      OPERATOR_SEAL_EK_BYTES,
    );
    expect(() => operatorSealKeyPeerIdHexToBytes("0x" + "dd".repeat(31))).toThrow(
      /expected 32 bytes/u,
    );
    expect(() => operatorSealEkHexToBytes("0x" + "66".repeat(OPERATOR_SEAL_EK_BYTES - 1))).toThrow(
      new RegExp(`expected ${OPERATOR_SEAL_EK_BYTES} bytes`, "u"),
    );
    expect(() => operatorSealEkHexToBytes("0x" + "00".repeat(OPERATOR_SEAL_EK_BYTES))).toThrow(
      /all-zero/u,
    );
  });
});

describe("buildPublishOperatorSealKeyTxFields", () => {
  it("targets node-registry with zero value and clamped fee tip", () => {
    const tx = buildPublishOperatorSealKeyTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      peerIdHex,
      sealEkHex,
    });

    expect(DEFAULT_OPERATOR_SEAL_KEY_EXECUTION_UNIT_LIMIT).toBe(250_000n);
    expect(tx.gasLimit).toBe(250_000n);
    expect(tx.maxFeePerGas).toBe(900n);
    expect(tx.maxPriorityFeePerGas).toBe(900n);
    expect(tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(tx.value).toBe(0n);
    expect(typeof tx.input).toBe("string");
    expect((tx.input as string).startsWith("0x0490b9a8")).toBe(true);
  });
});

describe("submitOperatorSealKey", () => {
  beforeEach(() => {
    submitWithPrivacy.mockClear();
  });

  it("submits a plaintext operator seal key tx through the SDK signer", async () => {
    const res = await submitOperatorSealKey({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "operator mnemonic",
      peerIdHex,
      sealEkHex,
    });

    expect(submitWithPrivacy).toHaveBeenCalledTimes(1);
    const call = submitWithPrivacy.mock.calls[0]![0];
    expect(call.private).toBe(false);
    expect(call.tx.gasLimit).toBe(250_000n);
    expect(call.tx.maxFeePerGas).toBe(900n);
    expect(call.tx.maxPriorityFeePerGas).toBe(900n);
    expect(call.tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(call.tx.input.startsWith("0x0490b9a8")).toBe(true);
    expect(res.txHash).toBe("0x" + "ab".repeat(32));
    expect(res.peerIdHex).toBe(peerIdHex);
    expect(res.sealEkBytes).toBe(OPERATOR_SEAL_EK_BYTES);
    expect(res.envelopeWireBytes).toBe(91);
    expect(res.innerSighashHex).toBe("0x" + "6b".repeat(32));
  });
});
