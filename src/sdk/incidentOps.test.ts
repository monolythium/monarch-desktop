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

const submitWithPrivacy = vi.fn(async (_arg: SubmitArg) => "0x" + "fa".repeat(32));

const fakeBackend = {
  addressBytes: () => new Uint8Array(20).fill(0x91),
  signEvmTx: () => ({
    wireHex: "0x00",
    wireBytes: new Uint8Array(104),
    sighash: new Uint8Array(32).fill(0x92),
    txHash: new Uint8Array(32).fill(0x93),
  }),
};

vi.mock("@monolythium/core-sdk", () => ({
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
      priorityTipLythoshi: "1100",
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
  buildEmergencyKeyRotationTxFields,
  buildFreezeAdmissionTxFields,
  DEFAULT_INCIDENT_EXECUTION_UNIT_LIMIT,
  EMERGENCY_KEY_ROTATION_SELECTOR,
  encodeEmergencyKeyRotationCalldata,
  encodeFreezeAdmissionCalldata,
  FREEZE_ADMISSION_SELECTOR,
  MAX_INCIDENT_INTENT_ID,
  submitEmergencyKeyRotation,
  submitFreezeAdmission,
} from "./incidentOps";

const reasonHashHex = "0x" + "ab".repeat(32);
const targetPubkeyHex = "0x" + "cd".repeat(48);
const fee = {
  executionUnitPriceLythoshi: "900",
  priorityTipLythoshi: "1100",
};

describe("incident executor calldata", () => {
  it("pins freezeAdmission selector and bytes32 layout", () => {
    expect(FREEZE_ADMISSION_SELECTOR).toBe("0x7a2605cd");
    expect(encodeFreezeAdmissionCalldata(reasonHashHex)).toBe(
      "0x7a2605cd" + "ab".repeat(32),
    );
  });

  it("pins emergencyKeyRotation selector and ABI-v2 layout", () => {
    const calldata = encodeEmergencyKeyRotationCalldata({
      targetPubkeyHex,
      effectiveEpoch: 42n,
      intentId: 7n,
    });

    expect(EMERGENCY_KEY_ROTATION_SELECTOR).toBe("0x0aeeafbf");
    expect(calldata).toHaveLength(2 + 2 * (4 + 6 * 32));
    expect(calldata.slice(0, 10)).toBe("0x0aeeafbf");
    expect(calldata.slice(10, 74)).toBe("0".repeat(62) + "60");
    expect(calldata.slice(74, 138)).toBe("0".repeat(62) + "2a");
    expect(calldata.slice(138, 202)).toBe("0".repeat(63) + "7");
    expect(calldata.slice(202, 266)).toBe("0".repeat(62) + "30");
    expect(calldata.slice(266, 330)).toBe("cd".repeat(32));
    expect(calldata.slice(330)).toBe("cd".repeat(16) + "00".repeat(16));
  });

  it("rejects malformed incident inputs before signing", () => {
    expect(() => encodeFreezeAdmissionCalldata("0x" + "aa".repeat(31))).toThrow(
      /expected 32 bytes/u,
    );
    expect(() =>
      encodeEmergencyKeyRotationCalldata({
        targetPubkeyHex: "0x" + "cd".repeat(47),
        effectiveEpoch: 1,
        intentId: 1,
      }),
    ).toThrow(/expected 48 bytes/u);
    expect(() =>
      encodeEmergencyKeyRotationCalldata({
        targetPubkeyHex,
        effectiveEpoch: 0,
        intentId: 1,
      }),
    ).toThrow(/greater than zero/u);
    expect(() =>
      encodeEmergencyKeyRotationCalldata({
        targetPubkeyHex,
        effectiveEpoch: 1,
        intentId: MAX_INCIDENT_INTENT_ID + 1n,
      }),
    ).toThrow(/2\^56-1/u);
  });
});

describe("incident tx fields", () => {
  it("targets node-registry with zero value and clamped fee tip", () => {
    const freeze = buildFreezeAdmissionTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      reasonHashHex,
    });
    expect(DEFAULT_INCIDENT_EXECUTION_UNIT_LIMIT).toBe(250_000n);
    expect(freeze.gasLimit).toBe(250_000n);
    expect(freeze.maxFeePerGas).toBe(900n);
    expect(freeze.maxPriorityFeePerGas).toBe(900n);
    expect(freeze.to).toBe("0x0000000000000000000000000000000000001005");
    expect(freeze.value).toBe(0n);
    expect(freeze.input).toBe("0x7a2605cd" + "ab".repeat(32));

    const emergency = buildEmergencyKeyRotationTxFields({
      chainId: 69420n,
      nonce: 1n,
      fee,
      targetPubkeyHex,
      effectiveEpoch: 42,
      intentId: 7,
    });
    expect(emergency.to).toBe("0x0000000000000000000000000000000000001005");
    expect(emergency.value).toBe(0n);
    expect(emergency.input).toEqual(expect.stringMatching(/^0x0aeeafbf/u));
  });
});

describe("incident submissions", () => {
  beforeEach(() => {
    submitWithPrivacy.mockClear();
  });

  it("submits freezeAdmission through the foundation signer", async () => {
    const res = await submitFreezeAdmission({
      rpcUrl: "http://127.0.0.1:8545",
      foundationMnemonic: "foundation mnemonic",
      reasonHashHex,
    });
    expect(submitWithPrivacy).toHaveBeenCalledTimes(1);
    const call = submitWithPrivacy.mock.calls[0]![0];
    expect(call.private).toBe(false);
    expect(call.tx.input).toBe("0x7a2605cd" + "ab".repeat(32));
    expect(res.txHash).toBe("0x" + "fa".repeat(32));
    expect(res.innerSighashHex).toBe("0x" + "92".repeat(32));
  });

  it("submits emergencyKeyRotation through the foundation signer", async () => {
    const res = await submitEmergencyKeyRotation({
      rpcUrl: "http://127.0.0.1:8545",
      foundationMnemonic: "foundation mnemonic",
      targetPubkeyHex,
      effectiveEpoch: 42,
      intentId: 7,
    });
    expect(submitWithPrivacy).toHaveBeenCalledTimes(1);
    const call = submitWithPrivacy.mock.calls[0]![0];
    expect(call.private).toBe(false);
    expect(call.tx.input.startsWith("0x0aeeafbf")).toBe(true);
    expect(res.targetPubkeyHex).toBe(targetPubkeyHex);
    expect(res.effectiveEpoch).toBe("42");
    expect(res.intentId).toBe("7");
  });
});
