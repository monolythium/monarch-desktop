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

const submitPlain = vi.fn(async (_arg: SubmitArg) => "0x" + "9c".repeat(32));

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
  PRECOMPILE_ADDRESSES: {
    CLUSTER_NAME_REGISTRY: "0x0000000000000000000000000000000000001104",
  },
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
}));

vi.mock("@monolythium/core-sdk/crypto", () => ({
  mnemonicToMlDsa65Backend: () => fakeBackend,
  submitTransaction: (arg: SubmitArg) => submitPlain(arg),
}));

import {
  buildRegisterClusterNameTxFields,
  CLUSTER_NAME_REGISTER_SELECTOR,
  clusterNameAnnualFeeLythoshi,
  DEFAULT_CLUSTER_NAME_EXECUTION_UNIT_LIMIT,
  encodeRegisterClusterNameCalldata,
  normalizeClusterName,
  parseClusterNameId,
  submitClusterNameRegistration,
} from "./clusterNameOps";

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

describe("cluster-name registry calldata", () => {
  it("pins register(string,uint64) layout", () => {
    const calldata = encodeRegisterClusterNameCalldata({
      name: "athena",
      clusterId: 7,
    });
    const nameWire = new TextEncoder().encode("athena");

    expect(CLUSTER_NAME_REGISTER_SELECTOR).toBe("0x5694cb0a");
    expect(calldata.slice(0, 10)).toBe("0x5694cb0a");
    expect(wordAt(calldata, 0)).toBe("0".repeat(62) + "40");
    expect(wordAt(calldata, 1)).toBe("0".repeat(63) + "7");
    expect(wordAt(calldata, 2)).toBe(nameWire.length.toString(16).padStart(64, "0"));
    expect(calldata).toContain(hex(nameWire));
    expect((calldata.length - 2 - 8) % 64).toBe(0);
  });

  it("validates lowercase cluster names and uint64 ids", () => {
    expect(normalizeClusterName(" athena ")).toMatchObject({ name: "athena" });
    expect(parseClusterNameId("18446744073709551615")).toBe(0xffff_ffff_ffff_ffffn);
    expect(() => parseClusterNameId("-1")).toThrow(/uint64/u);
    expect(() => parseClusterNameId("18446744073709551616")).toThrow(/uint64/u);
    expect(() => normalizeClusterName("ab")).toThrow(/at least/u);
    expect(() => normalizeClusterName("a".repeat(33))).toThrow(/exceeds/u);
    expect(() => normalizeClusterName("Athena")).toThrow(/lowercase/u);
    expect(() => normalizeClusterName("athena7")).toThrow(/lowercase/u);
    expect(() => normalizeClusterName("treasury")).toThrow(/reserved/u);
  });

  it("matches the chain annual fee curve", () => {
    expect(clusterNameAnnualFeeLythoshi("athena")).toBe(72_900_000_000_000_000n);
    expect(clusterNameAnnualFeeLythoshi("abc")).toBe(90_000_000_000_000_000n);
    expect(clusterNameAnnualFeeLythoshi("a".repeat(32))).toBe(100_000_000_000_000n);
  });
});

describe("buildRegisterClusterNameTxFields", () => {
  it("targets cluster-name registry with exact annual fee and clamped tip", () => {
    const tx = buildRegisterClusterNameTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      clusterId: 7,
      name: "athena",
    });

    expect(DEFAULT_CLUSTER_NAME_EXECUTION_UNIT_LIMIT).toBe(250_000n);
    expect(tx.gasLimit).toBe(250_000n);
    expect(tx.maxFeePerGas).toBe(900n);
    expect(tx.maxPriorityFeePerGas).toBe(900n);
    expect(tx.to).toBe("0x0000000000000000000000000000000000001104");
    expect(tx.value).toBe(72_900_000_000_000_000n);
    expect(typeof tx.input).toBe("string");
    expect((tx.input as string).startsWith("0x5694cb0a")).toBe(true);
  });
});

describe("submitClusterNameRegistration", () => {
  beforeEach(() => {
    submitPlain.mockClear();
  });

  it("submits a plaintext cluster-name tx through the SDK signer", async () => {
    const res = await submitClusterNameRegistration({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "operator mnemonic",
      clusterId: 7,
      name: "athena",
    });

    expect(submitPlain).toHaveBeenCalledTimes(1);
    const call = submitPlain.mock.calls[0]![0];
    expect(call.tx.gasLimit).toBe(250_000n);
    expect(call.tx.to).toBe("0x0000000000000000000000000000000000001104");
    expect(call.tx.value).toBe(72_900_000_000_000_000n);
    expect(call.tx.input.startsWith("0x5694cb0a")).toBe(true);
    expect(res.txHash).toBe("0x" + "9c".repeat(32));
    expect(res.clusterId).toBe("7");
    expect(res.name).toBe("athena");
    expect(res.nameBytes).toBe(6);
    expect(res.envelopeWireBytes).toBe(91);
    expect(res.innerSighashHex).toBe("0x" + "6b".repeat(32));
  });
});
