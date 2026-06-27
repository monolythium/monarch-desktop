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

const submitPlain = vi.fn(async (_arg: SubmitArg) => "0x" + "ab".repeat(32));

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
  submitTransaction: (arg: SubmitArg) => submitPlain(arg),
}));

import {
  buildSetOperatorDisplayTxFields,
  DEFAULT_OPERATOR_DISPLAY_EXECUTION_UNIT_LIMIT,
  encodeSetOperatorDisplayCalldata,
  normalizeOperatorDisplay,
  OPERATOR_ALIAS_MAX_BYTES,
  OPERATOR_MONIKER_MAX_BYTES,
  operatorDisplayPeerIdHexToBytes,
  SET_OPERATOR_DISPLAY_SELECTOR,
  submitOperatorDisplay,
} from "./operatorDisplayOps";

const peerIdHex = "0x" + "dd".repeat(32);
const moniker = "Monolythium Foundation 01";
const alias = "foundation-01";
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

describe("setOperatorDisplay calldata", () => {
  it("pins the selector and ABI layout for bytes32 plus two dynamic strings", () => {
    const calldata = encodeSetOperatorDisplayCalldata({
      peerIdHex,
      moniker,
      alias,
    });
    const monikerWire = new TextEncoder().encode(moniker);
    const aliasWire = new TextEncoder().encode(alias);

    expect(SET_OPERATOR_DISPLAY_SELECTOR).toBe("0x7a2ac986");
    expect(calldata.slice(0, 10)).toBe("0x7a2ac986");
    expect(wordAt(calldata, 0)).toBe("dd".repeat(32));
    expect(wordAt(calldata, 1)).toBe("0".repeat(62) + "60");
    expect(wordAt(calldata, 2)).toBe("0".repeat(62) + "a0");
    expect(wordAt(calldata, 3)).toBe(monikerWire.length.toString(16).padStart(64, "0"));
    expect(calldata).toContain(hex(monikerWire));
    expect(wordAt(calldata, 5)).toBe(aliasWire.length.toString(16).padStart(64, "0"));
    expect(calldata).toContain(hex(aliasWire));
    expect((calldata.length - 2 - 8) % 64).toBe(0);
  });

  it("accepts empty fields and rejects malformed or oversized display text", () => {
    const empty = encodeSetOperatorDisplayCalldata({
      peerIdHex,
      moniker: "",
      alias: "",
    });
    expect(wordAt(empty, 1)).toBe("0".repeat(62) + "60");
    expect(wordAt(empty, 2)).toBe("0".repeat(62) + "80");
    expect(wordAt(empty, 3)).toBe("0".repeat(64));
    expect(wordAt(empty, 4)).toBe("0".repeat(64));

    expect(() => operatorDisplayPeerIdHexToBytes("0x" + "dd".repeat(31))).toThrow(
      /expected 32 bytes/u,
    );
    expect(() => normalizeOperatorDisplay({ moniker: "bad\nname", alias: "" })).toThrow(
      /control characters/u,
    );
    expect(() => normalizeOperatorDisplay({ moniker: "a".repeat(129), alias: "" })).toThrow(
      new RegExp(`${OPERATOR_MONIKER_MAX_BYTES} UTF-8 bytes`, "u"),
    );
    expect(() => normalizeOperatorDisplay({ moniker: "", alias: "a".repeat(65) })).toThrow(
      new RegExp(`${OPERATOR_ALIAS_MAX_BYTES} UTF-8 bytes`, "u"),
    );
  });
});

describe("buildSetOperatorDisplayTxFields", () => {
  it("targets node-registry with zero value and clamped fee tip", () => {
    const tx = buildSetOperatorDisplayTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      peerIdHex,
      moniker,
      alias,
    });

    expect(DEFAULT_OPERATOR_DISPLAY_EXECUTION_UNIT_LIMIT).toBe(250_000n);
    expect(tx.gasLimit).toBe(250_000n);
    expect(tx.maxFeePerGas).toBe(900n);
    expect(tx.maxPriorityFeePerGas).toBe(900n);
    expect(tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(tx.value).toBe(0n);
    expect(typeof tx.input).toBe("string");
    expect((tx.input as string).startsWith("0x7a2ac986")).toBe(true);
  });
});

describe("submitOperatorDisplay", () => {
  beforeEach(() => {
    submitPlain.mockClear();
  });

  it("submits a plaintext operator metadata tx through the SDK signer", async () => {
    const res = await submitOperatorDisplay({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "operator mnemonic",
      peerIdHex,
      moniker,
      alias,
    });

    expect(submitPlain).toHaveBeenCalledTimes(1);
    const call = submitPlain.mock.calls[0]![0];
    expect(call.tx.gasLimit).toBe(250_000n);
    expect(call.tx.maxFeePerGas).toBe(900n);
    expect(call.tx.maxPriorityFeePerGas).toBe(900n);
    expect(call.tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(call.tx.input.startsWith("0x7a2ac986")).toBe(true);
    expect(res.txHash).toBe("0x" + "ab".repeat(32));
    expect(res.peerIdHex).toBe(peerIdHex);
    expect(res.monikerBytes).toBe(new TextEncoder().encode(moniker).length);
    expect(res.aliasBytes).toBe(new TextEncoder().encode(alias).length);
    expect(res.envelopeWireBytes).toBe(91);
    expect(res.innerSighashHex).toBe("0x" + "6b".repeat(32));
  });
});
