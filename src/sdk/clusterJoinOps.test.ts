import { describe, expect, it, vi } from "vitest";
import {
  buildRequestClusterJoinTxFields,
  buildVoteClusterAdmitTxFields,
  CANCEL_CLUSTER_JOIN_SELECTOR,
  CLUSTER_JOIN_REQUEST_TTL_EPOCHS,
  DEFAULT_CLUSTER_JOIN_EXECUTION_UNIT_LIMIT,
  decodeClusterJoinRequestView,
  deriveClusterJoinOperatorIdHex,
  encodeCancelClusterJoinCalldata,
  encodeExpireClusterJoinCalldata,
  encodeGetClusterJoinRequestCalldata,
  encodeRequestClusterJoinCalldata,
  encodeVoteClusterAdmitCalldata,
  EXPIRE_CLUSTER_JOIN_SELECTOR,
  GET_CLUSTER_JOIN_REQUEST_SELECTOR,
  readClusterJoinRequest,
  REQUEST_CLUSTER_JOIN_SELECTOR,
  VOTE_CLUSTER_ADMIT_SELECTOR,
} from "./clusterJoinOps";
import {
  NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  operatorPubkeyHash,
} from "./operatorKeys";

const operatorPubkeyHex = "0x" + "44".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES);
const voterPubkeyHex = "0x" + "55".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES);
const operatorIdHex = "0x" + "66".repeat(32);
const fee = {
  executionUnitPriceLythoshi: "800",
  priorityTipLythoshi: "950",
};

function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function word(value: bigint | number | string): string {
  if (typeof value === "string" && value.startsWith("0x")) {
    return value.slice(2).padStart(64, "0");
  }
  return BigInt(value).toString(16).padStart(64, "0");
}

describe("CJ-1 cluster-admission calldata", () => {
  it("pins selectors to the node-registry CJ-1 ABI", () => {
    expect(REQUEST_CLUSTER_JOIN_SELECTOR).toBe("0xe1dd13bd");
    expect(VOTE_CLUSTER_ADMIT_SELECTOR).toBe("0x20519d4f");
    expect(CANCEL_CLUSTER_JOIN_SELECTOR).toBe("0x3e2d51c3");
    expect(EXPIRE_CLUSTER_JOIN_SELECTOR).toBe("0xeeb96895");
    expect(GET_CLUSTER_JOIN_REQUEST_SELECTOR).toBe("0x224de9bf");
    expect(CLUSTER_JOIN_REQUEST_TTL_EPOCHS).toBe(6);
  });

  it("encodes requestClusterJoin(uint32,bytes)", () => {
    const calldata = encodeRequestClusterJoinCalldata({
      clusterId: 7,
      operatorPubkeyHex,
    });

    expect(calldata).toHaveLength(2 + 2 * (4 + 3 * 32 + NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES));
    expect(calldata.slice(0, 10)).toBe(REQUEST_CLUSTER_JOIN_SELECTOR);
    expect(calldata.slice(10, 74)).toBe("0".repeat(63) + "7");
    expect(calldata.slice(74, 138)).toBe("0".repeat(62) + "40");
    expect(calldata.slice(138, 202)).toBe(
      NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES.toString(16).padStart(64, "0"),
    );
    expect(calldata.slice(202)).toBe("44".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES));
  });

  it("encodes voteClusterAdmit(uint32,bytes32,bytes)", () => {
    const calldata = encodeVoteClusterAdmitCalldata({
      clusterId: "9",
      operatorIdHex,
      voterPubkeyHex,
    });

    expect(calldata).toHaveLength(2 + 2 * (4 + 4 * 32 + NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES));
    expect(calldata.slice(0, 10)).toBe(VOTE_CLUSTER_ADMIT_SELECTOR);
    expect(calldata.slice(10, 74)).toBe("0".repeat(63) + "9");
    expect(calldata.slice(74, 138)).toBe("66".repeat(32));
    expect(calldata.slice(138, 202)).toBe("0".repeat(62) + "60");
    expect(calldata.slice(202, 266)).toBe(
      NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES.toString(16).padStart(64, "0"),
    );
    expect(calldata.slice(266)).toBe("55".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES));
  });

  it("encodes operator-id-only cancel, expire, and view calls", () => {
    const args = { clusterId: 7, operatorIdHex };

    expect(encodeCancelClusterJoinCalldata(args)).toBe(
      `${CANCEL_CLUSTER_JOIN_SELECTOR}${"0".repeat(63)}7${"66".repeat(32)}`,
    );
    expect(encodeExpireClusterJoinCalldata(args)).toBe(
      `${EXPIRE_CLUSTER_JOIN_SELECTOR}${"0".repeat(63)}7${"66".repeat(32)}`,
    );
    expect(encodeGetClusterJoinRequestCalldata(args)).toBe(
      `${GET_CLUSTER_JOIN_REQUEST_SELECTOR}${"0".repeat(63)}7${"66".repeat(32)}`,
    );
  });

  it("derives the candidate operator id from the full ML-DSA consensus pubkey", () => {
    const pubkeyBytes = new Uint8Array(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES).fill(0x44);
    expect(deriveClusterJoinOperatorIdHex(operatorPubkeyHex)).toBe(
      bytesToHex(operatorPubkeyHash(pubkeyBytes)),
    );
    expect(() =>
      deriveClusterJoinOperatorIdHex("0x" + "44".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES - 1)),
    ).toThrow(/1952 bytes/u);
  });

  it("decodes the eight-word getClusterJoinRequest view tuple", () => {
    const owner = "0x" + "77".repeat(20);
    const encoded = `0x${[
      word(owner),
      word(9),
      word(7),
      word(10),
      word(3),
      word(1),
      word(5000),
      word(1),
    ].join("")}`;

    expect(decodeClusterJoinRequestView(encoded)).toEqual({
      owner,
      requestEpoch: "9",
      snapshotThreshold: 7,
      snapshotN: 10,
      voteCount: 3,
      status: "open",
      statusCode: 1,
      bondLythoshi: "5000",
      sealRosterPending: true,
      exists: true,
    });
  });

  it("decodes the all-zero getClusterJoinRequest view as a missing request", () => {
    expect(decodeClusterJoinRequestView("0x" + "00".repeat(8 * 32))).toMatchObject({
      owner: "0x0000000000000000000000000000000000000000",
      status: "none",
      exists: false,
    });
  });

  it("rejects malformed request view tuples", () => {
    expect(() => decodeClusterJoinRequestView("0x" + "00".repeat(7 * 32))).toThrow(
      /256 bytes/u,
    );
  });

  it("reads getClusterJoinRequest through the native lyth_* view", async () => {
    const response = {
      schemaVersion: 1,
      capability: "operatorOnboardingRpcV1",
      method: "getClusterJoinRequest",
      clusterId: 7,
      operatorId: operatorIdHex,
      request: {
        exists: true,
        owner: "mono1candidateowner",
        requestEpoch: "12",
        requestNonce: "1",
        snapshotThreshold: 7,
        snapshotN: 10,
        voteCount: 7,
        status: "admitted" as const,
        statusCode: 2,
        bondLythoshi: "9000",
        sealRosterPending: true,
      },
    };
    const call = vi.fn(async (_method: string, _params?: unknown) => response);
    const client = {
      call: async <T>(method: string, params?: unknown): Promise<T> => call(method, params) as Promise<T>,
    };

    const view = await readClusterJoinRequest(client, { clusterId: 7, operatorIdHex });

    expect(call).toHaveBeenCalledWith("lyth_getClusterJoinRequest", [7, operatorIdHex]);
    expect(view.status).toBe("admitted");
    expect(view.voteCount).toBe(7);
    expect(view.owner).toBe("mono1candidateowner");
  });

  it("rejects malformed CJ-1 inputs before any signer path can use them", () => {
    expect(() =>
      encodeRequestClusterJoinCalldata({
        clusterId: 1,
        operatorPubkeyHex: "0x" + "44".repeat(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES - 1),
      }),
    ).toThrow(/1952 bytes/u);
    expect(() =>
      encodeRequestClusterJoinCalldata({
        clusterId: "4294967296",
        operatorPubkeyHex,
      }),
    ).toThrow(/uint32/u);
    expect(() =>
      encodeVoteClusterAdmitCalldata({
        clusterId: 1,
        operatorIdHex: "0x1234",
        voterPubkeyHex,
      }),
    ).toThrow(/operatorId.*32 bytes/u);
    expect(() =>
      encodeVoteClusterAdmitCalldata({
        clusterId: 1,
        operatorIdHex,
        voterPubkeyHex: "0xzz",
      }),
    ).toThrow(/invalid hex/u);
  });
});

describe("CJ-1 cluster-admission tx field builders", () => {
  it("builds requestClusterJoin with native bond value and clamped tip", () => {
    const tx = buildRequestClusterJoinTxFields({
      chainId: 69420n,
      nonce: 5n,
      fee,
      clusterId: 7,
      operatorPubkeyHex,
      bondLythoshi: "5000000000000000000000",
    });

    expect(DEFAULT_CLUSTER_JOIN_EXECUTION_UNIT_LIMIT).toBe(1_000_000n);
    expect(tx.gasLimit).toBe(1_000_000n);
    expect(tx.maxFeePerGas).toBe(800n);
    expect(tx.maxPriorityFeePerGas).toBe(800n);
    expect(tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(tx.value).toBe(5000000000000000000000n);
    expect(typeof tx.input).toBe("string");
    if (typeof tx.input !== "string") throw new Error("request input must be hex");
    expect(tx.input.startsWith(REQUEST_CLUSTER_JOIN_SELECTOR)).toBe(true);
  });

  it("rejects malformed request bond values before building tx fields", () => {
    expect(() =>
      buildRequestClusterJoinTxFields({
        chainId: 69420n,
        nonce: 5n,
        fee,
        clusterId: 7,
        operatorPubkeyHex,
        bondLythoshi: "-1",
      }),
    ).toThrow(/256-bit range/u);
  });

  it("builds voteClusterAdmit as a zero-value node-registry tx", () => {
    const tx = buildVoteClusterAdmitTxFields({
      chainId: 69420n,
      nonce: 6n,
      fee,
      clusterId: 7,
      operatorIdHex,
      voterPubkeyHex,
      executionUnitLimit: 310_000n,
    });

    expect(tx.gasLimit).toBe(310_000n);
    expect(tx.maxFeePerGas).toBe(800n);
    expect(tx.maxPriorityFeePerGas).toBe(800n);
    expect(tx.to).toBe("0x0000000000000000000000000000000000001005");
    expect(tx.value).toBe(0n);
    expect(typeof tx.input).toBe("string");
    if (typeof tx.input !== "string") throw new Error("vote input must be hex");
    expect(tx.input.startsWith(VOTE_CLUSTER_ADMIT_SELECTOR)).toBe(true);
  });
});
