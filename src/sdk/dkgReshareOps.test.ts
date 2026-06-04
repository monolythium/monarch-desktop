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

const submitWithPrivacy = vi.fn(async (_arg: SubmitArg) => "0x" + "ad".repeat(32));

const fakeBackend = {
  addressBytes: () => new Uint8Array(20).fill(0x22),
  signEvmTx: () => ({
    wireHex: "0x00",
    wireBytes: new Uint8Array(104),
    sighash: new Uint8Array(32).fill(0x33),
    txHash: new Uint8Array(32).fill(0x44),
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
    lythGetTransactionCount = vi.fn(async () => 15n);
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
  ATTEST_DKG_RESHARE_SELECTOR,
  buildDkgReshareAttestationTxFields,
  DEFAULT_DKG_RESHARE_EXECUTION_UNIT_LIMIT,
  DKG_RESHARE_ATTESTATION_SIG_BYTES,
  DKG_RESHARE_ATTESTATION_SCHEMA,
  DKG_RESHARE_CONSENSUS_PUBKEY_BYTES,
  DKG_RESHARE_MAX_SIGNERS,
  DKG_RESHARE_MIN_SIGNERS,
  encodeAttestDkgReshareCalldata,
  MAX_DKG_RESHARE_INTENT_ID,
  parseDkgReshareAttestationArtifact,
  parseDkgResharePublicKeys,
  submitDkgReshareAttestation,
} from "./dkgReshareOps";

function key(byte: number): string {
  return byte.toString(16).padStart(2, "0").repeat(DKG_RESHARE_CONSENSUS_PUBKEY_BYTES);
}

const keysHex = "0x" + [1, 2, 3, 4, 5].map(key).join("");
const sigHex = "0x" + "cc".repeat(5 * DKG_RESHARE_ATTESTATION_SIG_BYTES);
const fee = {
  executionUnitPriceLythoshi: "900",
  priorityTipLythoshi: "1200",
};

describe("attestDkgReshare calldata", () => {
  it("pins selector and ABI-v2 dynamic bytes layout", () => {
    const calldata = encodeAttestDkgReshareCalldata({
      intentId: 7n,
      blsPublicKeysHex: keysHex,
      thresholdSigHex: sigHex,
    });

    const keysLength = 5 * DKG_RESHARE_CONSENSUS_PUBKEY_BYTES;
    const keysPaddedLength = Math.ceil(keysLength / 32) * 32;
    const sigLength = 5 * DKG_RESHARE_ATTESTATION_SIG_BYTES;
    const sigPaddedLength = Math.ceil(sigLength / 32) * 32;
    const offsetSig = 0x60 + 32 + keysPaddedLength;

    expect(ATTEST_DKG_RESHARE_SELECTOR).toBe("0x36e34030");
    expect(calldata.slice(0, 10)).toBe("0x36e34030");
    expect(calldata.slice(10, 74)).toBe("7".padStart(64, "0"));
    expect(calldata.slice(74, 138)).toBe("60".padStart(64, "0"));
    expect(calldata.slice(138, 202)).toBe(offsetSig.toString(16).padStart(64, "0"));
    expect(calldata.slice(202, 266)).toBe(keysLength.toString(16).padStart(64, "0"));
    expect(calldata.slice(266, 266 + keysLength * 2)).toBe([1, 2, 3, 4, 5].map(key).join(""));
    const sigLenWordStart = 266 + keysPaddedLength * 2;
    expect(calldata.slice(sigLenWordStart, sigLenWordStart + 64)).toBe(
      sigLength.toString(16).padStart(64, "0"),
    );
    expect(calldata.slice(sigLenWordStart + 64, sigLenWordStart + 64 + sigLength * 2)).toBe(
      "cc".repeat(sigLength),
    );
    expect(calldata.slice(sigLenWordStart + 64 + sigLength * 2)).toBe(
      "00".repeat(sigPaddedLength - sigLength),
    );
  });

  it("validates signer count, duplicate keys, signature length, and intent cap", () => {
    expect(parseDkgResharePublicKeys(keysHex)).toHaveLength(DKG_RESHARE_MIN_SIGNERS);
    expect(
      parseDkgResharePublicKeys("0x" + [1, 2, 3, 4, 5, 6, 7].map(key).join("")),
    ).toHaveLength(DKG_RESHARE_MAX_SIGNERS);
    expect(() =>
      parseDkgResharePublicKeys("0x" + [1, 2, 3, 4].map(key).join("")),
    ).toThrow(/expected 5..7 signers/u);
    expect(() =>
      parseDkgResharePublicKeys("0x" + [1, 1, 2, 3, 4].map(key).join("")),
    ).toThrow(/duplicate signer/u);
    expect(() =>
      encodeAttestDkgReshareCalldata({
        intentId: MAX_DKG_RESHARE_INTENT_ID + 1n,
        blsPublicKeysHex: keysHex,
        thresholdSigHex: sigHex,
      }),
    ).toThrow(/2\^56-1/u);
    expect(() =>
      encodeAttestDkgReshareCalldata({
        intentId: 7,
        blsPublicKeysHex: keysHex,
        thresholdSigHex: "0x" + "cc".repeat(5 * DKG_RESHARE_ATTESTATION_SIG_BYTES - 1),
      }),
    ).toThrow(/expected 16545 bytes/u);
  });
});

describe("parseDkgReshareAttestationArtifact", () => {
  it("imports canonical ceremony attestation JSON", () => {
    const artifact = parseDkgReshareAttestationArtifact(
      JSON.stringify({
        schema_version: DKG_RESHARE_ATTESTATION_SCHEMA,
        intent_id: "7",
        bls_public_keys_hex: keysHex.toUpperCase(),
        threshold_sig_hex: sigHex.toUpperCase(),
      }),
    );

    expect(artifact.schemaVersion).toBe(DKG_RESHARE_ATTESTATION_SCHEMA);
    expect(artifact.intentId).toBe("7");
    expect(artifact.blsPublicKeysHex).toBe(keysHex);
    expect(artifact.thresholdSigHex).toBe(sigHex);
    expect(artifact.signerCount).toBe(5);
  });

  it("imports nested camelCase attestation payloads", () => {
    const artifact = parseDkgReshareAttestationArtifact({
      dkgReshareAttestation: {
        intentId: 8,
        blsPublicKeysHex: keysHex,
        thresholdSigHex: sigHex,
      },
    });

    expect(artifact.schemaVersion).toBeNull();
    expect(artifact.intentId).toBe("8");
    expect(artifact.signerCount).toBe(5);
  });

  it("rejects invalid artifact schema and malformed threshold signatures", () => {
    expect(() =>
      parseDkgReshareAttestationArtifact({
        schema_version: "monarch-dkg-reshare-attestation/v0",
        intent_id: "7",
        bls_public_keys_hex: keysHex,
        threshold_sig_hex: sigHex,
      }),
    ).toThrow(/unsupported schema_version/u);
    expect(() =>
      parseDkgReshareAttestationArtifact({
        intent_id: "7",
        bls_public_keys_hex: keysHex,
        threshold_sig_hex: "0x" + "cc".repeat(5 * DKG_RESHARE_ATTESTATION_SIG_BYTES - 1),
      }),
    ).toThrow(/expected 16545 bytes/u);
  });
});

describe("buildDkgReshareAttestationTxFields", () => {
  it("targets node-registry with zero value and clamped fee tip", () => {
    const tx = buildDkgReshareAttestationTxFields({
      chainId: 69420n,
      nonce: 0n,
      fee,
      intentId: 7,
      blsPublicKeysHex: keysHex,
      thresholdSigHex: sigHex,
    });

    expect(DEFAULT_DKG_RESHARE_EXECUTION_UNIT_LIMIT).toBe(250_000n);
    expect(tx.gasLimit).toBe(250_000n);
    expect(tx.maxFeePerGas).toBe(900n);
    expect(tx.maxPriorityFeePerGas).toBe(900n);
    expect(tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(tx.value).toBe(0n);
    expect(typeof tx.input).toBe("string");
    expect((tx.input as string).startsWith("0x36e34030")).toBe(true);
  });
});

describe("submitDkgReshareAttestation", () => {
  beforeEach(() => {
    submitWithPrivacy.mockClear();
  });

  it("submits a plaintext operator DKG attestation tx through the SDK signer", async () => {
    const res = await submitDkgReshareAttestation({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "operator mnemonic",
      intentId: 7,
      blsPublicKeysHex: keysHex,
      thresholdSigHex: sigHex,
    });

    expect(submitWithPrivacy).toHaveBeenCalledTimes(1);
    const call = submitWithPrivacy.mock.calls[0]![0];
    expect(call.private).toBe(false);
    expect(call.tx.gasLimit).toBe(250_000n);
    expect(call.tx.maxFeePerGas).toBe(900n);
    expect(call.tx.maxPriorityFeePerGas).toBe(900n);
    expect(call.tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(call.tx.input.startsWith("0x36e34030")).toBe(true);
    expect(res.txHash).toBe("0x" + "ad".repeat(32));
    expect(res.intentId).toBe("7");
    expect(res.signerCount).toBe(5);
    expect(res.envelopeWireBytes).toBe(104);
    expect(res.innerSighashHex).toBe("0x" + "33".repeat(32));
  });
});
