import { describe, expect, it } from "vitest";
import type {
  SeatAdvertisedEvent,
  SeatClosedEvent,
  SeatFilledEvent,
} from "@monolythium/core-sdk";
import {
  decodedToSeatAdvertised,
  foldSeatEvents,
  openSeatsAvailable,
  resolveSeatDiscoveryRange,
  SEAT_DISCOVERY_WINDOW_BLOCKS,
  SEAT_PRIMITIVE_ACTIVATION_HEIGHT,
  type SeatEventBatch,
} from "./seatReads";

const FIVE_K = 5_000n * 10n ** 18n;

function advertised(overrides: Partial<SeatAdvertisedEvent> = {}): SeatAdvertisedEvent {
  return {
    clusterId: 7,
    seatId: 1,
    advertiser: "0x" + "ab".repeat(32),
    kind: 0,
    seatCount: 1,
    minBondLythoshi: FIVE_K,
    capabilityMask: 0x0001,
    termsHash: "0x" + "00".repeat(32),
    ...overrides,
  };
}

function filled(overrides: Partial<SeatFilledEvent> = {}): SeatFilledEvent {
  return {
    clusterId: 7,
    seatId: 1,
    operatorId: "0x" + "cd".repeat(32),
    filledCount: 1,
    seatCount: 1,
    ...overrides,
  };
}

function closed(overrides: Partial<SeatClosedEvent> = {}): SeatClosedEvent {
  return { clusterId: 7, seatId: 1, status: 3, ...overrides };
}

function batch(overrides: Partial<SeatEventBatch> = {}): SeatEventBatch {
  return { advertised: [], filled: [], closed: [], ...overrides };
}

describe("foldSeatEvents", () => {
  it("projects a fresh advertised listing as open with zero filled", () => {
    const seat = foldSeatEvents(batch({ advertised: [advertised()] }))[0]!;
    expect(seat).toMatchObject({
      clusterId: 7,
      seatId: 1,
      kind: "active",
      seatCount: 1,
      filledCount: 0,
      status: "open",
      minBondLythoshi: FIVE_K,
    });
  });

  it("flips a single-seat listing to filled when a fill lands", () => {
    const seat = foldSeatEvents(
      batch({ advertised: [advertised()], filled: [filled()] }),
    )[0]!;
    expect(seat.filledCount).toBe(1);
    expect(seat.status).toBe("filled");
  });

  it("keeps a multi-seat listing open until every seat is filled", () => {
    const seat = foldSeatEvents(
      batch({
        advertised: [advertised({ seatCount: 3 })],
        filled: [filled({ filledCount: 2, seatCount: 3 })],
      }),
    )[0]!;
    expect(seat.filledCount).toBe(2);
    expect(seat.seatCount).toBe(3);
    expect(seat.status).toBe("open");
  });

  it("marks a rescinded listing closed", () => {
    const seat = foldSeatEvents(
      batch({ advertised: [advertised()], closed: [closed()] }),
    )[0]!;
    expect(seat.status).toBe("closed");
  });

  it("ignores fill/close events with no matching advertised listing", () => {
    const seats = foldSeatEvents(
      batch({ filled: [filled({ seatId: 99 })], closed: [closed({ seatId: 42 })] }),
    );
    expect(seats).toEqual([]);
  });

  it("sorts the listings by cluster then seat id", () => {
    const seats = foldSeatEvents(
      batch({
        advertised: [
          advertised({ clusterId: 9, seatId: 2 }),
          advertised({ clusterId: 7, seatId: 5 }),
          advertised({ clusterId: 7, seatId: 1 }),
        ],
      }),
    );
    expect(seats.map((s) => [s.clusterId, s.seatId])).toEqual([
      [7, 1],
      [7, 5],
      [9, 2],
    ]);
  });
});

describe("openSeatsAvailable", () => {
  it("keeps only open listings with a remaining vacancy", () => {
    const seats = foldSeatEvents(
      batch({
        advertised: [
          advertised({ seatId: 1 }),
          advertised({ seatId: 2 }),
          advertised({ seatId: 3, seatCount: 2 }),
        ],
        filled: [filled({ seatId: 2 })],
        closed: [closed({ seatId: 1 })],
      }),
    );
    // seat 1 closed, seat 2 filled, seat 3 open with 1 of 2 left
    expect(openSeatsAvailable(seats).map((s) => s.seatId)).toEqual([3]);
  });
});

describe("resolveSeatDiscoveryRange", () => {
  it("returns null below the activation height", () => {
    expect(resolveSeatDiscoveryRange(SEAT_PRIMITIVE_ACTIVATION_HEIGHT - 1)).toBeNull();
    expect(resolveSeatDiscoveryRange(null)).toBeNull();
  });

  it("clamps the lower bound to the activation height for a recent chain", () => {
    const range = resolveSeatDiscoveryRange(SEAT_PRIMITIVE_ACTIVATION_HEIGHT + 10);
    expect(range).toEqual({
      fromBlock: SEAT_PRIMITIVE_ACTIVATION_HEIGHT,
      toBlock: SEAT_PRIMITIVE_ACTIVATION_HEIGHT + 10,
    });
  });

  it("uses a bounded window once the chain is far past activation", () => {
    const height = SEAT_PRIMITIVE_ACTIVATION_HEIGHT + 10 * SEAT_DISCOVERY_WINDOW_BLOCKS;
    const range = resolveSeatDiscoveryRange(height);
    expect(range).toEqual({
      fromBlock: height - SEAT_DISCOVERY_WINDOW_BLOCKS,
      toBlock: height,
    });
  });
});

describe("decodedToSeatAdvertised", () => {
  it("reads snake_case projection fields", () => {
    const event = decodedToSeatAdvertised({
      block_height: 1,
      tx_index: 0,
      sequence: 0,
      family: "node_registry",
      event_name: "SeatAdvertised",
      payload_hash: "0x00",
      cluster_id: 7,
      seat_id: 2,
      advertiser: "0x" + "ab".repeat(32),
      kind: 1,
      seat_count: 2,
      min_bond_lythoshi: FIVE_K.toString(),
      capability_mask: 5,
      terms_hash: "0x" + "11".repeat(32),
    });
    expect(event).toMatchObject({
      clusterId: 7,
      seatId: 2,
      kind: 1,
      seatCount: 2,
      minBondLythoshi: FIVE_K,
      capabilityMask: 5,
    });
  });

  it("reads camelCase projection fields", () => {
    const event = decodedToSeatAdvertised({
      block_height: 1,
      tx_index: 0,
      sequence: 0,
      family: "node_registry",
      event_name: "SeatAdvertised",
      payload_hash: "0x00",
      clusterId: 7,
      seatId: 3,
      advertiser: "0x" + "ab".repeat(32),
      kind: 0,
      seatCount: 1,
      minBondLythoshi: "0x" + FIVE_K.toString(16),
      capabilityMask: 1,
      termsHash: "0x" + "22".repeat(32),
    });
    expect(event?.minBondLythoshi).toBe(FIVE_K);
    expect(event?.seatId).toBe(3);
  });

  it("returns null when an essential field is missing", () => {
    const event = decodedToSeatAdvertised({
      block_height: 1,
      tx_index: 0,
      sequence: 0,
      family: "node_registry",
      event_name: "SeatAdvertised",
      payload_hash: "0x00",
      cluster_id: 7,
      // seat_id missing
      advertiser: "0x" + "ab".repeat(32),
    });
    expect(event).toBeNull();
  });
});
