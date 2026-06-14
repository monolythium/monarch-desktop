import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FormClusterPreview } from "./clusterFormOps";

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

const state = vi.hoisted(() => {
  const submitWithPrivacy = vi.fn(async (_arg: SubmitArg) => "0x" + "ac".repeat(32));
  const signPayloads: Uint8Array[] = [];
  return {
    submitWithPrivacy,
    previewFailure: null as Error | null,
    previewResponse: {
      schemaVersion: 1,
      capability: "operatorOnboardingRpcV1",
      method: "formCluster",
      ok: true,
      status: "ok",
      reason: null,
      message: null,
    } as FormClusterPreview,
    rpcCalls: [] as Array<{ method: string; params?: unknown }>,
    transactionCountReads: 0,
    transactionCountAddresses: [] as string[],
    signPayloads,
    fakeBackend: {
      addressBytes: () => new Uint8Array(20).fill(0x44),
      sign: (message: Uint8Array) => {
        signPayloads.push(message);
        return new Uint8Array(3309).fill(0xdd);
      },
      signEvmTx: () => ({
        wireHex: "0x00",
        wireBytes: new Uint8Array(128),
        sighash: new Uint8Array(32).fill(0x77),
        txHash: new Uint8Array(32).fill(0x88),
      }),
    },
  };
});

// Spread the REAL SDK (charter encoders, V2 calldata, selectors) and
// override only the network/identity surfaces — the V2 parity tests
// below must exercise the genuine core-sdk encoders, not stubs.
vi.mock("@monolythium/core-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@monolythium/core-sdk")>()),
  RpcClient: class {
    endpoint: string;
    constructor(endpoint: string) {
      this.endpoint = endpoint;
    }
    call = vi.fn(async (method: string, params?: unknown) => {
      state.rpcCalls.push({ method, params });
      if (state.previewFailure) throw state.previewFailure;
      return state.previewResponse;
    });
    ethChainId = vi.fn(async () => 69420n);
    lythGetTransactionCount = vi.fn(async (address: string) => {
      state.transactionCountReads += 1;
      state.transactionCountAddresses.push(address);
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
  addressToTypedBech32: () => "mono1typedoperator",
  nodeRegistryAddressHex: () => "0x0000000000000000000000000000000000001005",
}));

vi.mock("@monolythium/core-sdk/crypto", () => ({
  pqm1MnemonicToMlDsa65Backend: () => state.fakeBackend,
  submitTransactionWithPrivacy: (arg: SubmitArg) => state.submitWithPrivacy(arg),
}));

import { blake3 } from "@noble/hashes/blake3.js";
import {
  ClusterCharterError,
  DEFAULT_FORM_CLUSTER_EXECUTION_UNIT_LIMIT,
  FORM_CLUSTER_ACTIVE_COUNT,
  FORM_CLUSTER_CHARTER_BYTES,
  FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS,
  FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS,
  FORM_CLUSTER_MEMBER_COUNT,
  FORM_CLUSTER_SELECTOR,
  FORM_CLUSTER_SIGNATURE_BYTES,
  FORM_CLUSTER_STANDBY_COUNT,
  FORM_CLUSTER_V2_SELECTOR,
  buildFormClusterTxFields,
  decodeClusterCharterHex,
  encodeClusterCharterHex,
  encodeFormClusterCalldata,
  formClusterConsentMessageHex,
  signFormClusterConsent,
  submitFormCluster,
  validateClusterCharterHex,
} from "./clusterFormOps";
import { NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES } from "./operatorKeys";

function byteHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function pubkey(value: number): string {
  return "0x" + byteHex(value).repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES);
}

function signature(value: number): string {
  return "0x" + byteHex(value).repeat(FORM_CLUSTER_SIGNATURE_BYTES);
}

function activePubkeys(): string[] {
  return Array.from({ length: FORM_CLUSTER_ACTIVE_COUNT }, (_, index) => pubkey(index + 1));
}

function standbyPubkeys(): string[] {
  return Array.from({ length: FORM_CLUSTER_STANDBY_COUNT }, (_, index) => pubkey(index + 11));
}

function signatures(): string[] {
  return Array.from({ length: FORM_CLUSTER_MEMBER_COUNT }, (_, index) => signature(index + 31));
}

function validInput(overrides: Partial<{
  activePubkeysHex: string;
  standbyPubkeysHex: string;
  signaturesHex: string;
}> = {}) {
  return {
    activePubkeysHex: activePubkeys().join("\n"),
    standbyPubkeysHex: standbyPubkeys().join("\n"),
    signaturesHex: signatures().join("\n"),
    ...overrides,
  };
}

function wordAt(calldata: string, index: number): bigint {
  const body = calldata.slice(10);
  return BigInt("0x" + body.slice(index * 64, (index + 1) * 64));
}

function hexAt(calldata: string, byteOffset: number, byteLength: number): string {
  const body = calldata.slice(10);
  return "0x" + body.slice(byteOffset * 2, (byteOffset + byteLength) * 2);
}

describe("formCluster submit helpers", () => {
  beforeEach(() => {
    state.submitWithPrivacy.mockClear();
    state.previewFailure = null;
    state.previewResponse = {
      schemaVersion: 1,
      capability: "operatorOnboardingRpcV1",
      method: "formCluster",
      ok: true,
      status: "ok",
      reason: null,
      message: null,
    };
    state.rpcCalls.length = 0;
    state.transactionCountReads = 0;
    state.transactionCountAddresses.length = 0;
    state.signPayloads.length = 0;
  });

  it("encodes formCluster dynamic calldata in roster order", () => {
    const input = validInput();
    const calldata = encodeFormClusterCalldata(input);
    const activeBytes = FORM_CLUSTER_ACTIVE_COUNT * NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES;
    const standbyBytes = FORM_CLUSTER_STANDBY_COUNT * NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES;
    const signatureBytes = FORM_CLUSTER_MEMBER_COUNT * FORM_CLUSTER_SIGNATURE_BYTES;
    const activeOffset = 96n;
    const standbyOffset = activeOffset + 32n + BigInt(activeBytes);
    const signaturesOffset = standbyOffset + 32n + BigInt(standbyBytes);

    expect(calldata.startsWith(FORM_CLUSTER_SELECTOR)).toBe(true);
    expect(wordAt(calldata, 0)).toBe(activeOffset);
    expect(wordAt(calldata, 1)).toBe(standbyOffset);
    expect(wordAt(calldata, 2)).toBe(signaturesOffset);
    expect(wordAt(calldata, Number(activeOffset / 32n))).toBe(BigInt(activeBytes));
    expect(wordAt(calldata, Number(standbyOffset / 32n))).toBe(BigInt(standbyBytes));
    expect(wordAt(calldata, Number(signaturesOffset / 32n))).toBe(BigInt(signatureBytes));
    expect(hexAt(calldata, Number(activeOffset) + 32, 2)).toBe("0x0101");
    expect(hexAt(calldata, Number(standbyOffset) + 32, 2)).toBe("0x0b0b");
    expect(hexAt(calldata, Number(signaturesOffset) + 32, 2)).toBe("0x1f1f");
  });

  it("rejects duplicate roster entries and malformed signature bundles", () => {
    expect(() =>
      encodeFormClusterCalldata(validInput({
        standbyPubkeysHex: [activePubkeys()[0], ...standbyPubkeys().slice(1)].join("\n"),
      })),
    ).toThrow(/duplicate pubkey/u);

    expect(() =>
      encodeFormClusterCalldata(validInput({
        signaturesHex: signatures().slice(0, FORM_CLUSTER_MEMBER_COUNT - 1).join("\n"),
      })),
    ).toThrow(/expected 10 signatures/u);

    expect(() =>
      encodeFormClusterCalldata(validInput({
        signaturesHex: [
          "0x" + "aa".repeat(FORM_CLUSTER_SIGNATURE_BYTES - 1),
          ...signatures().slice(1),
        ].join("\n"),
      })),
    ).toThrow(/expected 3309 bytes/u);
  });

  it("builds and signs the canonical roster consent message", () => {
    const input = validInput();
    const digest = formClusterConsentMessageHex(input);
    const changed = formClusterConsentMessageHex({
      activePubkeysHex: input.activePubkeysHex,
      standbyPubkeysHex: [pubkey(21), ...standbyPubkeys().slice(1)].join("\n"),
    });

    expect(digest).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(changed).not.toBe(digest);

    const sig = signFormClusterConsent({
      mnemonic: "test mnemonic",
      activePubkeysHex: input.activePubkeysHex,
      standbyPubkeysHex: input.standbyPubkeysHex,
    });
    expect(sig).toBe("0x" + "dd".repeat(FORM_CLUSTER_SIGNATURE_BYTES));
    expect(state.signPayloads).toHaveLength(1);
    expect(state.signPayloads[0]).toHaveLength(32);
  });

  it("builds zero-value formCluster tx fields with clamped priority tip", () => {
    const tx = buildFormClusterTxFields({
      chainId: 69420n,
      nonce: 3n,
      fee: {
        executionUnitPriceLythoshi: "800",
        priorityTipLythoshi: "950",
      },
      ...validInput(),
    });

    expect(tx.gasLimit).toBe(DEFAULT_FORM_CLUSTER_EXECUTION_UNIT_LIMIT);
    expect(tx.maxFeePerGas).toBe(800n);
    expect(tx.maxPriorityFeePerGas).toBe(800n);
    expect(tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(tx.value).toBe(0n);
    expect(typeof tx.input).toBe("string");
    expect((tx.input as string).startsWith(FORM_CLUSTER_SELECTOR)).toBe(true);
  });

  it("previews formCluster before nonce reads and broadcasts plaintext", async () => {
    const res = await submitFormCluster({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      ...validInput(),
    });

    expect(state.rpcCalls[0]?.method).toBe("lyth_previewFormCluster");
    const params = state.rpcCalls[0]?.params as Array<{
      from: string;
      activePubkeys: string[];
      standbyPubkeys: string[];
      signatures: string[];
    }>;
    expect(params[0]).toMatchObject({
      from: "mono1typedoperator",
    });
    expect(params[0]?.activePubkeys).toHaveLength(FORM_CLUSTER_ACTIVE_COUNT);
    expect(params[0]?.standbyPubkeys).toHaveLength(FORM_CLUSTER_STANDBY_COUNT);
    expect(params[0]?.signatures).toHaveLength(FORM_CLUSTER_MEMBER_COUNT);
    expect(state.transactionCountAddresses).toEqual(["mono1typedoperator"]);
    expect(state.submitWithPrivacy).toHaveBeenCalledTimes(1);
    const call = state.submitWithPrivacy.mock.calls[0]![0];
    expect(call.private).toBe(false);
    expect(call.tx.value).toBe(0n);
    expect(call.tx.input.startsWith(FORM_CLUSTER_SELECTOR)).toBe(true);
    expect(res.txHash).toBe("0x" + "ac".repeat(32));
    expect(res.activeCount).toBe(FORM_CLUSTER_ACTIVE_COUNT);
    expect(res.standbyCount).toBe(FORM_CLUSTER_STANDBY_COUNT);
    expect(res.signatureCount).toBe(FORM_CLUSTER_MEMBER_COUNT);
    expect(res.innerSighashHex).toBe("0x" + "77".repeat(32));
    expect(res.envelopeWireBytes).toBe(128);
  });

  it("does not read nonce or broadcast when formCluster preview fails", async () => {
    state.previewFailure = new Error("method not found");

    await expect(submitFormCluster({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      ...validInput(),
    })).rejects.toThrow(/Cluster-form preview is unavailable/u);

    expect(state.transactionCountReads).toBe(0);
    expect(state.submitWithPrivacy).not.toHaveBeenCalled();
  });

  it("does not read nonce or broadcast when formCluster preview rejects", async () => {
    state.previewResponse = {
      schemaVersion: 1,
      capability: "operatorOnboardingRpcV1",
      method: "formCluster",
      ok: false,
      status: "rejected",
      reason: "duplicate_member",
      message: "cluster formation roster contains a duplicate operator",
    };

    await expect(submitFormCluster({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      ...validInput(),
    })).rejects.toThrow(/formCluster preview rejected: duplicate_member/u);

    expect(state.transactionCountReads).toBe(0);
    expect(state.submitWithPrivacy).not.toHaveBeenCalled();
  });
});

// ---- charter (V2) ------------------------------------------------------

/** SDK fixture roster (mono-core-sdk `tests/node-registry.test.ts`):
 *  active key i = 1952×(0x20+i), standby j = 1952×(0x40+j),
 *  signature k = 3309×(0x80+k). */
function v2FixtureInput() {
  return {
    activePubkeysHex: Array.from(
      { length: FORM_CLUSTER_ACTIVE_COUNT },
      (_, i) => pubkey(0x20 + i),
    ).join("\n"),
    standbyPubkeysHex: Array.from(
      { length: FORM_CLUSTER_STANDBY_COUNT },
      (_, j) => pubkey(0x40 + j),
    ).join("\n"),
    signaturesHex: Array.from(
      { length: FORM_CLUSTER_MEMBER_COUNT },
      (_, k) => signature(0x80 + k),
    ).join("\n"),
  };
}

/** SDK fixture charter terms — byte/digest vectors pinned from the Rust
 *  SDK + mono-core (mirrored from the core-sdk test suite). */
const V2_FIXTURE_SHARES = [1500, 1500, 1000, 1000, 1000, 1000, 1000, 800, 700, 500];
const V2_FIXTURE_DELEGATOR_BPS = 3000;
const V2_FIXTURE_EXPIRES_MS = 1_999_999_999_000;
const V2_FIXTURE_CHARTER_HEX =
  "0x05dc05dc03e803e803e803e803e8032002bc01f40bb8000001d1a94a1c18";
const V2_FIXTURE_DIGEST =
  "0x118e8dbfc057ffd2fcab85d6a1942c674cdb3f516f4cae86377e1b275bdcd106";
const V1_FIXTURE_DIGEST =
  "0xa49cb5314c8f1b2feb508d2512b59e599a05f27d78e8cc6426cac67b55504015";
const V2_FIXTURE_CALLDATA_BYTES = 52_932;
const V2_FIXTURE_CALLDATA_BLAKE3 =
  "0x1a752e3995adf1cdd86b4e6daefe4660d58cecd63170b2a4763d7837bb181edc";

/** Raw (unvalidated) charter hex for malformed-charter cases. */
function rawCharterHex(shares: number[], delegatorBps: number, expiresMs: number): string {
  const u16 = (n: number) => n.toString(16).padStart(4, "0");
  const u64 = (n: number) => BigInt(n).toString(16).padStart(16, "0");
  return `0x${shares.map(u16).join("")}${u16(delegatorBps)}${u64(expiresMs)}`;
}

function charterErrorCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof ClusterCharterError ? err.code : `not-typed: ${String(err)}`;
  }
}

describe("formCluster V2 charter", () => {
  beforeEach(() => {
    state.submitWithPrivacy.mockClear();
    state.previewFailure = null;
    state.previewResponse = {
      schemaVersion: 1,
      capability: "operatorOnboardingRpcV1",
      method: "formCluster",
      ok: true,
      status: "ok",
      reason: null,
      message: null,
    };
    state.rpcCalls.length = 0;
    state.transactionCountReads = 0;
    state.transactionCountAddresses.length = 0;
    state.signPayloads.length = 0;
  });

  it("encodes the charter byte-identical to the SDK fixture vector", () => {
    const charterHex = encodeClusterCharterHex({
      memberShareBps: V2_FIXTURE_SHARES,
      delegatorShareBps: V2_FIXTURE_DELEGATOR_BPS,
      expiresMs: V2_FIXTURE_EXPIRES_MS,
    });
    expect(charterHex).toBe(V2_FIXTURE_CHARTER_HEX);
    expect((charterHex.length - 2) / 2).toBe(FORM_CLUSTER_CHARTER_BYTES);

    // decode round-trips the exact terms.
    expect(decodeClusterCharterHex(charterHex)).toEqual({
      memberShareBps: V2_FIXTURE_SHARES,
      delegatorShareBps: V2_FIXTURE_DELEGATOR_BPS,
      expiresMs: V2_FIXTURE_EXPIRES_MS,
    });
  });

  it("computes the V2 consent digest pinned to the SDK fixture (V1 unchanged)", () => {
    const input = v2FixtureInput();
    expect(
      formClusterConsentMessageHex({ ...input, charterHex: V2_FIXTURE_CHARTER_HEX }),
    ).toBe(V2_FIXTURE_DIGEST);
    // The charter-less digest for the same roster is the unchanged V1 pin —
    // domain separation means a V1 consent can never replay as V2.
    expect(formClusterConsentMessageHex(input)).toBe(V1_FIXTURE_DIGEST);
    expect(V1_FIXTURE_DIGEST).not.toBe(V2_FIXTURE_DIGEST);
  });

  it("encodes formCluster V2 calldata byte-identical to the SDK fixture", () => {
    const calldata = encodeFormClusterCalldata({
      ...v2FixtureInput(),
      charterHex: V2_FIXTURE_CHARTER_HEX,
    });
    expect(calldata.startsWith(FORM_CLUSTER_V2_SELECTOR)).toBe(true);
    expect(FORM_CLUSTER_V2_SELECTOR).toBe("0xdc4cc1cc");
    const bytes = new Uint8Array((calldata.length - 2) / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(calldata.slice(2 + i * 2, 4 + i * 2), 16);
    }
    expect(bytes.length).toBe(V2_FIXTURE_CALLDATA_BYTES);
    expect(
      "0x" + Array.from(blake3(bytes), (b) => b.toString(16).padStart(2, "0")).join(""),
    ).toBe(V2_FIXTURE_CALLDATA_BLAKE3);

    // Without a charter the same roster still takes the byte-identical V1 path.
    const v1 = encodeFormClusterCalldata(v2FixtureInput());
    expect(v1.startsWith(FORM_CLUSTER_SELECTOR)).toBe(true);
  });

  it("rejects malformed charters client-side with typed errors", () => {
    // length
    expect(charterErrorCode(() => decodeClusterCharterHex("0x" + "00".repeat(22)))).toBe("length");
    expect(charterErrorCode(() =>
      formClusterConsentMessageHex({ ...v2FixtureInput(), charterHex: "0x0102" }),
    )).toBe("length");
    // share sum
    expect(charterErrorCode(() =>
      validateClusterCharterHex(rawCharterHex(
        [...V2_FIXTURE_SHARES.slice(0, 9), 499],
        V2_FIXTURE_DELEGATOR_BPS,
        V2_FIXTURE_EXPIRES_MS,
      )),
    )).toBe("share-sum");
    // delegator floor
    expect(charterErrorCode(() =>
      validateClusterCharterHex(rawCharterHex(
        V2_FIXTURE_SHARES,
        FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS - 1,
        V2_FIXTURE_EXPIRES_MS,
      )),
    )).toBe("delegator-floor");
    // delegator ceiling
    expect(charterErrorCode(() =>
      validateClusterCharterHex(rawCharterHex(
        V2_FIXTURE_SHARES,
        FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS + 1,
        V2_FIXTURE_EXPIRES_MS,
      )),
    )).toBe("delegator-ceiling");
    // expiry in the past (only checked when a clock is provided)
    expect(charterErrorCode(() =>
      validateClusterCharterHex(V2_FIXTURE_CHARTER_HEX, { nowMs: V2_FIXTURE_EXPIRES_MS + 1 }),
    )).toBe("expired");
    expect(
      validateClusterCharterHex(V2_FIXTURE_CHARTER_HEX, { nowMs: V2_FIXTURE_EXPIRES_MS - 1 })
        .delegatorShareBps,
    ).toBe(V2_FIXTURE_DELEGATOR_BPS);
    // a malformed charter must also block calldata encoding
    expect(() =>
      encodeFormClusterCalldata({
        ...v2FixtureInput(),
        charterHex: rawCharterHex(V2_FIXTURE_SHARES, 1999, V2_FIXTURE_EXPIRES_MS),
      }),
    ).toThrow(ClusterCharterError);
  });

  it("passes the charter through preview and submits the V2 calldata", async () => {
    const res = await submitFormCluster({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      ...v2FixtureInput(),
      charterHex: V2_FIXTURE_CHARTER_HEX,
    });

    // lyth_previewFormCluster carries the optional charter param.
    expect(state.rpcCalls[0]?.method).toBe("lyth_previewFormCluster");
    const params = state.rpcCalls[0]?.params as Array<{ charter?: string }>;
    expect(params[0]?.charter).toBe(V2_FIXTURE_CHARTER_HEX);

    // Broadcast input is the V2 selector; the consent digest is the V2 pin.
    const call = state.submitWithPrivacy.mock.calls[0]![0];
    expect(call.tx.input.startsWith(FORM_CLUSTER_V2_SELECTOR)).toBe(true);
    expect(res.consentMessageHex).toBe(V2_FIXTURE_DIGEST);
  });

  it("refuses to submit a charter whose consent expiry already passed", async () => {
    await expect(submitFormCluster({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      ...v2FixtureInput(),
      charterHex: rawCharterHex(V2_FIXTURE_SHARES, V2_FIXTURE_DELEGATOR_BPS, 1_000),
    })).rejects.toThrow(/expiry .* not in the future/u);
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.submitWithPrivacy).not.toHaveBeenCalled();
  });

  it("keeps the charter-less preview params free of the charter key", async () => {
    await submitFormCluster({
      rpcUrl: "http://127.0.0.1:8545",
      mnemonic: "test mnemonic",
      ...validInput(),
    });
    const params = state.rpcCalls[0]?.params as Array<Record<string, unknown>>;
    expect("charter" in params[0]!).toBe(false);
    const call = state.submitWithPrivacy.mock.calls[0]![0];
    expect(call.tx.input.startsWith(FORM_CLUSTER_SELECTOR)).toBe(true);
  });
});
