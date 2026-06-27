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

const submitWithPrivacy = vi.fn(async (_arg: SubmitArg) => "0x" + "ba".repeat(32));

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
    lythGetTransactionCount = vi.fn(async () => 12n);
    lythExecutionUnitPrice = vi.fn(async () => ({
      executionUnitPriceLythoshi: "800",
      basePricePerExecutionUnitLythoshi: "800",
      priorityTipLythoshi: "950",
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
  buildSubmitPendingChangeTxFields,
  DEFAULT_PENDING_CHANGE_EXECUTION_UNIT_LIMIT,
  encodeSubmitPendingChangeCalldata,
  MAX_PENDING_CHANGE_INTENT_ID,
  normalizePendingChangeKind,
  PENDING_CHANGE_KIND_CODES,
  submitPendingChange,
  SUBMIT_PENDING_CHANGE_SELECTOR,
} from "./pendingChangeOps";
import { NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES } from "./operatorKeys";

const pubkeyHex = "0x" + "aa".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES);
const fee = {
  executionUnitPriceLythoshi: "800",
  priorityTipLythoshi: "950",
};

describe("submitPendingChange calldata", () => {
  it("pins the selector and ABI-v2 layout for Add", () => {
    const calldata = encodeSubmitPendingChangeCalldata({
      kind: "add",
      targetPubkeyHex: pubkeyHex,
      effectiveEpoch: 42n,
      intentId: 0n,
    });

    expect(SUBMIT_PENDING_CHANGE_SELECTOR).toBe("0x7d09426c");
    expect(PENDING_CHANGE_KIND_CODES).toEqual({ add: 1, remove: 2, rotate: 3 });
    expect(calldata).toHaveLength(2 + 2 * (4 + 4 * 32 + 32 + NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES));
    expect(calldata.slice(0, 10)).toBe("0x7d09426c");
    expect(calldata.slice(10, 74)).toBe("0".repeat(63) + "1");
    expect(calldata.slice(74, 138)).toBe("0".repeat(62) + "80");
    expect(calldata.slice(138, 202)).toBe("0".repeat(62) + "2a");
    expect(calldata.slice(202, 266)).toBe("0".repeat(64));
    expect(calldata.slice(266, 330)).toBe(
      NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES.toString(16).padStart(64, "0"),
    );
    expect(calldata.slice(330)).toBe("aa".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES));
  });

  it("encodes Rotate with a non-zero intent id under the 56-bit cap", () => {
    const calldata = encodeSubmitPendingChangeCalldata({
      kind: "rotate",
      targetPubkeyHex: pubkeyHex,
      effectiveEpoch: "100",
      intentId: MAX_PENDING_CHANGE_INTENT_ID,
    });

    expect(normalizePendingChangeKind(3)).toEqual({ kind: "rotate", kindCode: 3 });
    expect(calldata.slice(10, 74)).toBe("0".repeat(63) + "3");
    expect(calldata.slice(202, 266)).toBe(
      MAX_PENDING_CHANGE_INTENT_ID.toString(16).padStart(64, "0"),
    );
  });

  it("rejects malformed pending-change inputs before signing", () => {
    expect(() =>
      encodeSubmitPendingChangeCalldata({
        kind: 9,
        targetPubkeyHex: pubkeyHex,
        effectiveEpoch: 1,
      }),
    ).toThrow(/unknown pending-change kind/u);
    expect(() =>
      encodeSubmitPendingChangeCalldata({
        kind: "add",
        targetPubkeyHex: "0x" + "aa".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES - 1),
        effectiveEpoch: 1,
      }),
    ).toThrow(/expected 1952 bytes/u);
    expect(() =>
      encodeSubmitPendingChangeCalldata({
        kind: "add",
        targetPubkeyHex: pubkeyHex,
        effectiveEpoch: 0,
      }),
    ).toThrow(/greater than zero/u);
    expect(() =>
      encodeSubmitPendingChangeCalldata({
        kind: "add",
        targetPubkeyHex: pubkeyHex,
        effectiveEpoch: 1,
        intentId: 1,
      }),
    ).toThrow(/only rotate/u);
    expect(() =>
      encodeSubmitPendingChangeCalldata({
        kind: "rotate",
        targetPubkeyHex: pubkeyHex,
        effectiveEpoch: 1,
        intentId: MAX_PENDING_CHANGE_INTENT_ID + 1n,
      }),
    ).toThrow(/2\^56-1/u);
  });
});

describe("buildSubmitPendingChangeTxFields", () => {
  it("targets node-registry with zero value and clamped fee tip", () => {
    const tx = buildSubmitPendingChangeTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      kind: "add",
      targetPubkeyHex: pubkeyHex,
      effectiveEpoch: 42n,
    });

    expect(DEFAULT_PENDING_CHANGE_EXECUTION_UNIT_LIMIT).toBe(250_000n);
    expect(tx.gasLimit).toBe(250_000n);
    expect(tx.maxFeePerGas).toBe(800n);
    expect(tx.maxPriorityFeePerGas).toBe(800n);
    expect(tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(tx.value).toBe(0n);
    expect(typeof tx.input).toBe("string");
    expect((tx.input as string).startsWith("0x7d09426c")).toBe(true);
  });
});

describe("submitPendingChange", () => {
  beforeEach(() => {
    submitWithPrivacy.mockClear();
  });

  it("submits a plaintext foundation pending-change tx through the SDK signer", async () => {
    const res = await submitPendingChange({
      rpcUrl: "http://127.0.0.1:8545",
      foundationMnemonic: "foundation mnemonic",
      kind: "rotate",
      targetPubkeyHex: pubkeyHex,
      effectiveEpoch: 100,
      intentId: 77,
    });

    expect(submitWithPrivacy).toHaveBeenCalledTimes(1);
    const call = submitWithPrivacy.mock.calls[0]![0];
    expect(call.private).toBe(false);
    expect(call.tx.gasLimit).toBe(250_000n);
    expect(call.tx.maxFeePerGas).toBe(800n);
    expect(call.tx.maxPriorityFeePerGas).toBe(800n);
    expect(call.tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(call.tx.input.startsWith("0x7d09426c")).toBe(true);
    expect(res.txHash).toBe("0x" + "ba".repeat(32));
    expect(res.kind).toBe("rotate");
    expect(res.kindCode).toBe(3);
    expect(res.effectiveEpoch).toBe("100");
    expect(res.intentId).toBe("77");
    expect(res.envelopeWireBytes).toBe(96);
    expect(res.innerSighashHex).toBe("0x" + "55".repeat(32));
  });
});
