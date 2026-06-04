import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the SDK so the submit path can be asserted without a live node. The
// crypto mock captures the `submitTransactionWithPrivacy` args; the main
// mock gives `RpcClient` typed `lyth_*` reads with canned values.
// ---------------------------------------------------------------------------

type SubmitArg = {
  private: boolean;
  tx: { gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; input?: string };
};
const submitWithPrivacy = vi.fn(async (_arg: SubmitArg) => "0x" + "ab".repeat(32));
const consensusPubkey = new Uint8Array(1952).fill(0xaa);
const consensusPop = new Uint8Array(3309).fill(0xbb);

const fakeBackend = {
  publicKey: () => consensusPubkey,
  sign: () => consensusPop,
  addressBytes: () => new Uint8Array(20).fill(0x11),
  signEvmTx: () => ({
    wireHex: "0x00",
    wireBytes: new Uint8Array(64),
    sighash: new Uint8Array(32).fill(0x22),
    txHash: new Uint8Array(32).fill(0x33),
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
    lythGetTransactionCount = vi.fn(async () => 7n);
    lythExecutionUnitPrice = vi.fn(async () => ({
      executionUnitPriceLythoshi: "1000",
      basePricePerExecutionUnitLythoshi: "1000",
      priorityTipLythoshi: "5000", // above the ceiling on purpose → must clamp
      blockNumber: 1,
      source: "test",
    }));
  },
}));

vi.mock("@monolythium/core-sdk/crypto", () => ({
  pqm1MnemonicToMlDsa65Backend: () => fakeBackend,
  submitTransactionWithPrivacy: (arg: SubmitArg) => submitWithPrivacy(arg),
}));

import {
  buildRegisterTxFields,
  clampPriorityTip,
  deriveOperatorConsensusPubkeyHex,
  submitRegister,
  DEFAULT_REGISTER_EXECUTION_UNIT_LIMIT,
} from "./register";
import {
  NODE_REGISTRY_CONSENSUS_POP_BYTES,
  NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
} from "./operatorKeys";

const peerId = new Uint8Array(32).fill(0xcc);

describe("clampPriorityTip", () => {
  it("clamps a tip above the per-execution-unit price ceiling", () => {
    expect(clampPriorityTip(5000n, 1000n)).toBe(1000n);
  });
  it("leaves a tip at or below the ceiling untouched", () => {
    expect(clampPriorityTip(800n, 1000n)).toBe(800n);
    expect(clampPriorityTip(1000n, 1000n)).toBe(1000n);
  });
});

describe("deriveOperatorConsensusPubkeyHex", () => {
  it("returns the ML-DSA-65 consensus pubkey derived from the PQM-1 mnemonic", () => {
    expect(deriveOperatorConsensusPubkeyHex("test mnemonic")).toBe("0x" + "aa".repeat(1952));
  });
});

describe("buildRegisterTxFields — SDK sane fee defaults", () => {
  const fee = {
    executionUnitPriceLythoshi: "1000",
    priorityTipLythoshi: "5000",
  };

  it("uses the 200k register execution-unit limit by default (covers ~151k)", () => {
    const { tx } = buildRegisterTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      endpoint: "https://node.example",
      capabilities: 0x0001,
      consensusPubkey,
      consensusPop,
      bondLythoshi: "500000000000",
      peerId,
      sppkHash: new Uint8Array(32),
      tpmQuote: new Uint8Array(0),
    });
    expect(DEFAULT_REGISTER_EXECUTION_UNIT_LIMIT).toBe(200_000n);
    expect(tx.gasLimit).toBe(200_000n);
    // ~151k register cost fits comfortably under the default ceiling.
    expect(tx.gasLimit as bigint).toBeGreaterThan(151_000n);
  });

  it("sets maxFeePerGas to the price ceiling and clamps the tip to it", () => {
    const { tx } = buildRegisterTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      endpoint: "https://node.example",
      capabilities: 0x0001,
      consensusPubkey,
      consensusPop,
      bondLythoshi: "500000000000",
      peerId,
      sppkHash: new Uint8Array(32),
      tpmQuote: new Uint8Array(0),
    });
    expect(tx.maxFeePerGas).toBe(1000n);
    // suggested tip 5000 > ceiling 1000 → clamped down to 1000.
    expect(tx.maxPriorityFeePerGas).toBe(1000n);
  });

  it("targets the node-registry precompile and carries the bond as value", () => {
    const { tx } = buildRegisterTxFields({
      chainId: 69420n,
      nonce: 3n,
      fee,
      endpoint: "https://node.example",
      capabilities: 0x0011,
      consensusPubkey,
      consensusPop,
      bondLythoshi: "500000000000",
      peerId,
      sppkHash: new Uint8Array(32),
      tpmQuote: new Uint8Array(0),
    });
    expect(tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(tx.value).toBe(500000000000n);
    expect(typeof tx.input).toBe("string");
    // register selector keccak256("register(...)")[0..4] = f4896df2
    expect((tx.input as string).startsWith("0xf4896df2")).toBe(true);
  });

  it("honours an explicit execution-unit-limit override", () => {
    const { tx } = buildRegisterTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      endpoint: "https://node.example",
      capabilities: 0x0001,
      consensusPubkey,
      consensusPop,
      bondLythoshi: "1",
      peerId,
      sppkHash: new Uint8Array(32),
      tpmQuote: new Uint8Array(0),
      executionUnitLimit: 250_000n,
    });
    expect(tx.gasLimit).toBe(250_000n);
  });

  it("rejects capability masks outside uint32 range", () => {
    expect(() => buildRegisterTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      endpoint: "https://node.example",
      capabilities: 0x1_0000_0000,
      consensusPubkey,
      consensusPop,
      bondLythoshi: "1",
      peerId,
      sppkHash: new Uint8Array(32),
      tpmQuote: new Uint8Array(0),
    })).toThrow(/capabilities: expected uint32/u);
  });
});

describe("submitRegister — defaults to the PLAINTEXT SDK path", () => {
  beforeEach(() => {
    submitWithPrivacy.mockClear();
  });

  it("submits via submitTransactionWithPrivacy with private:false (plaintext → mesh_submitTx)", async () => {
    const res = await submitRegister({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      endpoint: "https://node.example",
      capabilities: 0x0001,
      bondLythoshi: "500000000000",
      peerIdHex: "0x" + "cc".repeat(32),
    });

    expect(submitWithPrivacy).toHaveBeenCalledTimes(1);
    const call = submitWithPrivacy.mock.calls[0]![0];
    // PLAINTEXT is the default and only path the operator flow uses.
    expect(call.private).toBe(false);
    // Sane fee defaults flow through to the actual submit.
    expect(call.tx.gasLimit).toBe(200_000n);
    expect(call.tx.maxFeePerGas).toBe(1000n);
    expect(call.tx.maxPriorityFeePerGas).toBe(1000n);
    expect(call.tx.input).toContain(
      NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES.toString(16).padStart(64, "0"),
    );
    expect(call.tx.input).toContain(
      NODE_REGISTRY_CONSENSUS_POP_BYTES.toString(16).padStart(64, "0"),
    );
    expect(res.txHash).toBe("0x" + "ab".repeat(32));
    expect(res.consensusPubkeyHex).toBe("0x" + "aa".repeat(1952));
  });

  it("only engages the encrypted PREVIEW path when privatePreview is explicitly true", async () => {
    await submitRegister({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      endpoint: "https://node.example",
      capabilities: 0x0001,
      bondLythoshi: "1",
      peerIdHex: "0x" + "cc".repeat(32),
      privatePreview: true,
    });
    const call = submitWithPrivacy.mock.calls[0]![0];
    expect(call.private).toBe(true);
  });

  it("rejects malformed hex before submitting a transaction", async () => {
    await expect(submitRegister({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      endpoint: "https://node.example",
      capabilities: 0x0001,
      bondLythoshi: "1",
      peerIdHex: "0x" + "cc".repeat(31) + "zz",
    })).rejects.toThrow(/peerId: invalid hex/u);
    expect(submitWithPrivacy).not.toHaveBeenCalled();
  });
});
