// Pure tests for the Logs Freeze (pause) helpers. No DOM / Tauri — every
// function here is deterministic over plain arrays.

import { describe, expect, it } from "vitest";
import { freezeView, newSinceFreeze } from "./freezeView";

describe("freezeView", () => {
  it("returns the live array unchanged (same reference) when not frozen", () => {
    const live = [1, 2, 3];
    expect(freezeView(live, null)).toBe(live);
  });

  it("returns the snapshot verbatim while frozen, ignoring the live array", () => {
    const snapshot = [1, 2, 3];
    const live = [1, 2, 3, 4, 5];
    expect(freezeView(live, snapshot)).toBe(snapshot);
  });

  it("renders an empty snapshot rather than falling through to live", () => {
    const live = [1, 2, 3];
    expect(freezeView(live, [])).toEqual([]);
  });
});

describe("newSinceFreeze", () => {
  it("is 0 when not frozen", () => {
    expect(newSinceFreeze([1, 2, 3], null)).toBe(0);
  });

  it("is 0 immediately after freezing (snapshot === live)", () => {
    const snapshot = [1, 2, 3];
    expect(newSinceFreeze(snapshot, snapshot)).toBe(0);
  });

  it("counts lines appended after the snapshot", () => {
    const a = { id: 1 };
    const b = { id: 2 };
    const c = { id: 3 };
    const d = { id: 4 };
    const snapshot = [a, b];
    const live = [a, b, c, d];
    expect(newSinceFreeze(live, snapshot)).toBe(2);
  });

  it("treats every live line as new when the snapshot was empty", () => {
    const live = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(newSinceFreeze(live, [])).toBe(3);
  });

  it("counts correctly when the FIFO evicted older lines but kept the snapshot tail", () => {
    // Snapshot tail (c) survives; a/b were evicted and e/f appended.
    const c = { id: 3 };
    const d = { id: 4 };
    const e = { id: 5 };
    const f = { id: 6 };
    const snapshot = [{ id: 1 }, { id: 2 }, c];
    const live = [c, d, e, f];
    expect(newSinceFreeze(live, snapshot)).toBe(3);
  });

  it("falls back to the whole live buffer when the snapshot tail was evicted", () => {
    const snapshot = [{ id: 1 }, { id: 2 }];
    // None of the snapshot objects remain in live (high churn).
    const live = [{ id: 3 }, { id: 4 }, { id: 5 }];
    expect(newSinceFreeze(live, snapshot)).toBe(3);
  });

  it("honours a custom equality (value-based instead of identity)", () => {
    const snapshot = [{ ts: "a" }, { ts: "b" }];
    // Fresh objects with the same field values — identity would miss the tail.
    const live = [{ ts: "a" }, { ts: "b" }, { ts: "c" }];
    expect(newSinceFreeze(live, snapshot, (x, y) => x.ts === y.ts)).toBe(1);
  });
});
