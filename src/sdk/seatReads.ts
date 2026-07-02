// Open-seat discovery read-model.
//
// The L6 open-seat primitive (#147) ships NO on-chain `getOpenSeat` view
// selector — discovery is event/indexer backed. A cluster advertises a
// vacancy (`SeatAdvertised`), applicants escrow their full self-bond
// (`SeatApplied`), admission fills it (`SeatFilled`), and an advertiser can
// rescind (`SeatClosed`).
// This module projects those native events into the `OpenSeatView` shape the
// SDK defines, folding fill/close state over the base advertised listing.
//
// The fold (`foldSeatEvents`) is pure and unit-tested. The live read
// (`readOpenSeats`) is best-effort: it queries the node's native-event history
// and degrades to an empty list / `notExposed` when the node runs without the
// event projection (e.g. the public testnet profile with the indexer disabled),
// so the browse surface shows an honest blocker rather than a fabricated row.

import {
  openSeatFromAdvertised,
  seatStatusFromByte,
  SEAT_STATUS_CODES,
  type NativeDecodedEvent,
  type OpenSeatView,
  type SeatAdvertisedEvent,
  type SeatClosedEvent,
  type SeatFilledEvent,
} from "@monolythium/core-sdk";

/**
 * Default block window the discovery scan looks back over from the chain head.
 * Open-seat listings are short-lived (advertised, then filled or rescinded), so
 * a bounded recent window keeps the native-event read cheap without missing
 * live vacancies. The window is not tied to any chain-specific activation
 * height — the seat marketplace activates at a height that moves with each
 * re-genesis, so the scan simply covers the recent window from the head.
 */
export const SEAT_DISCOVERY_WINDOW_BLOCKS = 50_000;

/** The native-event names the discovery scan reads, mirroring the L6 events. */
export const SEAT_EVENT_NAMES = {
  advertised: "SeatAdvertised",
  applied: "SeatApplied",
  filled: "SeatFilled",
  closed: "SeatClosed",
} as const;

export type SeatEventBatch = {
  advertised: SeatAdvertisedEvent[];
  filled: SeatFilledEvent[];
  closed: SeatClosedEvent[];
};

export type SeatEventReadClient = {
  lythNativeEventsTyped: (filter: {
    fromBlock: number | bigint | string;
    toBlock: number | bigint | string;
    eventName?: string | null;
    limit?: number | bigint | string | null;
  }) => Promise<{ events: Array<{ decoded: NativeDecodedEvent }> }>;
};

function seatKey(clusterId: number, seatId: number): string {
  return `${clusterId}:${seatId}`;
}

/**
 * Fold a batch of decoded seat events into the live `OpenSeatView` listings.
 *
 * Each `SeatAdvertised` seeds a fresh `Open` listing (via the SDK projector);
 * later `SeatFilled` events advance `filledCount` (flipping the status to
 * `filled` once the listing is full), and a `SeatClosed` marks it `closed`.
 * Events are matched on `(clusterId, seatId)`. The result is sorted by cluster
 * then seat id for a stable render order. Pure — no I/O.
 */
export function foldSeatEvents(batch: SeatEventBatch): OpenSeatView[] {
  const seats = new Map<string, OpenSeatView>();

  for (const event of batch.advertised) {
    seats.set(seatKey(event.clusterId, event.seatId), openSeatFromAdvertised(event));
  }

  for (const event of batch.filled) {
    const seat = seats.get(seatKey(event.clusterId, event.seatId));
    if (!seat) continue;
    // The fill event carries the authoritative running counts.
    const filledCount = Math.max(seat.filledCount, event.filledCount);
    const seatCount = Math.max(seat.seatCount, event.seatCount);
    seats.set(seatKey(event.clusterId, event.seatId), {
      ...seat,
      filledCount,
      seatCount,
      status: seat.status === "closed"
        ? "closed"
        : filledCount >= seatCount
          ? "filled"
          : seat.status,
    });
  }

  for (const event of batch.closed) {
    const seat = seats.get(seatKey(event.clusterId, event.seatId));
    if (!seat) continue;
    const decodedStatus = seatStatusFromByte(event.status);
    seats.set(seatKey(event.clusterId, event.seatId), {
      ...seat,
      status: decodedStatus === "none" ? "closed" : decodedStatus,
    });
  }

  return [...seats.values()].sort(
    (a, b) => a.clusterId - b.clusterId || a.seatId - b.seatId,
  );
}

/** Listings an operator can still apply to: an open active or standby vacancy. */
export function openSeatsAvailable(seats: readonly OpenSeatView[]): OpenSeatView[] {
  return seats.filter(
    (seat) => seat.status === "open" && seat.filledCount < seat.seatCount,
  );
}

function firstDefined(record: NativeDecodedEvent, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) return Number(value.trim());
  return null;
}

function asBigInt(value: unknown): bigint | null {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^0x[0-9a-fA-F]+$/u.test(trimmed) || /^\d+$/u.test(trimmed)) return BigInt(trimmed);
    }
  } catch {
    return null;
  }
  return null;
}

function asHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^0x[0-9a-fA-F]*$/u.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Adapt a node-decoded native event into a `SeatAdvertisedEvent`. The node
 * projects fields in either camelCase or snake_case depending on its indexer
 * version, so every field is read defensively; a row missing an essential
 * field is skipped (returns null) rather than rendered as a partial listing.
 */
export function decodedToSeatAdvertised(decoded: NativeDecodedEvent): SeatAdvertisedEvent | null {
  const clusterId = asNumber(firstDefined(decoded, ["clusterId", "cluster_id"]));
  const seatId = asNumber(firstDefined(decoded, ["seatId", "seat_id"]));
  const advertiser = asHex(firstDefined(decoded, ["advertiser"]));
  const kind = asNumber(firstDefined(decoded, ["kind", "seat_kind", "seatKind"]));
  const seatCount = asNumber(firstDefined(decoded, ["seatCount", "seat_count"]));
  const minBond = asBigInt(
    firstDefined(decoded, ["minBondLythoshi", "min_bond_lythoshi", "minBond", "min_bond"]),
  );
  const capabilityMask = asNumber(
    firstDefined(decoded, ["capabilityMask", "capability_mask"]),
  );
  const termsHash = asHex(firstDefined(decoded, ["termsHash", "terms_hash"]));
  if (
    clusterId === null ||
    seatId === null ||
    advertiser === null ||
    kind === null ||
    seatCount === null ||
    minBond === null ||
    capabilityMask === null ||
    termsHash === null
  ) {
    return null;
  }
  return { clusterId, seatId, advertiser, kind, seatCount, minBondLythoshi: minBond, capabilityMask, termsHash };
}

export function decodedToSeatFilled(decoded: NativeDecodedEvent): SeatFilledEvent | null {
  const clusterId = asNumber(firstDefined(decoded, ["clusterId", "cluster_id"]));
  const seatId = asNumber(firstDefined(decoded, ["seatId", "seat_id"]));
  const operatorId = asHex(firstDefined(decoded, ["operatorId", "operator_id"]));
  const filledCount = asNumber(firstDefined(decoded, ["filledCount", "filled_count"]));
  const seatCount = asNumber(firstDefined(decoded, ["seatCount", "seat_count"]));
  if (clusterId === null || seatId === null || filledCount === null || seatCount === null) {
    return null;
  }
  return { clusterId, seatId, operatorId: operatorId ?? "0x", filledCount, seatCount };
}

export function decodedToSeatClosed(decoded: NativeDecodedEvent): SeatClosedEvent | null {
  const clusterId = asNumber(firstDefined(decoded, ["clusterId", "cluster_id"]));
  const seatId = asNumber(firstDefined(decoded, ["seatId", "seat_id"]));
  const status = asNumber(firstDefined(decoded, ["status"]));
  if (clusterId === null || seatId === null) return null;
  return { clusterId, seatId, status: status ?? SEAT_STATUS_CODES.closed };
}

export type SeatDiscoveryRange = {
  fromBlock: number;
  toBlock: number;
  limit?: number;
};

/**
 * Resolve the discovery scan range from the current chain head: a bounded
 * recent window ending at the head. Returns `null` only when there is no head
 * yet (nothing to scan) — never based on a hardcoded activation height, so the
 * scan works against whatever height the marketplace activated at. The seat
 * events themselves are the source of truth for what exists in the window.
 */
export function resolveSeatDiscoveryRange(
  chainHeight: number | null,
  windowBlocks = SEAT_DISCOVERY_WINDOW_BLOCKS,
): SeatDiscoveryRange | null {
  if (chainHeight === null || chainHeight < 0) return null;
  const fromBlock = Math.max(0, chainHeight - windowBlocks);
  return { fromBlock, toBlock: chainHeight };
}

/** Read the seat-event batch for a block range via the node's native-event history. */
export async function readSeatEventBatch(
  client: SeatEventReadClient,
  range: SeatDiscoveryRange,
): Promise<SeatEventBatch> {
  const base = { fromBlock: range.fromBlock, toBlock: range.toBlock, limit: range.limit ?? null };
  const [advertised, filled, closed] = await Promise.all([
    client.lythNativeEventsTyped({ ...base, eventName: SEAT_EVENT_NAMES.advertised }),
    client.lythNativeEventsTyped({ ...base, eventName: SEAT_EVENT_NAMES.filled }),
    client.lythNativeEventsTyped({ ...base, eventName: SEAT_EVENT_NAMES.closed }),
  ]);
  return {
    advertised: advertised.events
      .map((row) => decodedToSeatAdvertised(row.decoded))
      .filter((event): event is SeatAdvertisedEvent => event !== null),
    filled: filled.events
      .map((row) => decodedToSeatFilled(row.decoded))
      .filter((event): event is SeatFilledEvent => event !== null),
    closed: closed.events
      .map((row) => decodedToSeatClosed(row.decoded))
      .filter((event): event is SeatClosedEvent => event !== null),
  };
}

/** Read + fold the live open-seat listings for a block range. */
export async function readOpenSeats(
  client: SeatEventReadClient,
  range: SeatDiscoveryRange,
): Promise<OpenSeatView[]> {
  return foldSeatEvents(await readSeatEventBatch(client, range));
}
