import { describe, expect, it } from "vitest";
import {
  CHARTER_DEFAULT_DELEGATOR_SHARE_BPS,
  CHARTER_DEFAULT_MEMBER_SHARE_BPS,
  CharterDraftError,
  FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS,
  FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS,
  FORM_CLUSTER_MEMBER_COUNT,
  bpsToPct,
  charterSeatLabel,
  defaultMemberShareStrings,
  memberShareStringsFrom,
  memberShareSum,
  memberShareSumIsExact,
  validateCharterDraft,
} from "./charterShare";

describe("charter share model", () => {
  it("the equal default split sums to exactly 10000 across ten seats", () => {
    const rows = defaultMemberShareStrings();
    expect(rows).toHaveLength(FORM_CLUSTER_MEMBER_COUNT);
    expect(rows.every((r) => r === String(CHARTER_DEFAULT_MEMBER_SHARE_BPS))).toBe(true);
    expect(memberShareSum(rows)).toBe(FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS);
    expect(memberShareSumIsExact(rows)).toBe(true);
  });

  it("labels seats in member-declaration order (7 active then 3 standby)", () => {
    expect(charterSeatLabel(0)).toBe("active 1");
    expect(charterSeatLabel(6)).toBe("active 7");
    expect(charterSeatLabel(7)).toBe("standby 1");
    expect(charterSeatLabel(9)).toBe("standby 3");
  });

  it("renders bps as a percentage", () => {
    expect(bpsToPct(1234)).toBe("12.3%");
    expect(bpsToPct(10000)).toBe("100.0%");
    expect(bpsToPct(2000, 0)).toBe("20%");
  });

  it("memberShareSum is NaN when any row is not a non-negative integer", () => {
    expect(Number.isNaN(memberShareSum(["1000", "abc"]))).toBe(true);
    expect(Number.isNaN(memberShareSum(["1000", "-5"]))).toBe(true);
    expect(memberShareSum(["1000", "2000"])).toBe(3000);
  });

  it("seeds editor rows from decoded member shares", () => {
    const shares = [3000, 1000, 1000, 1000, 1000, 1000, 1000, 400, 300, 300];
    expect(memberShareStringsFrom(shares)).toEqual([
      "3000",
      "1000",
      "1000",
      "1000",
      "1000",
      "1000",
      "1000",
      "400",
      "300",
      "300",
    ]);
  });
});

describe("validateCharterDraft — the chain's guardrails, client-side", () => {
  const valid = defaultMemberShareStrings();

  it("accepts a 10000-bps split with a delegator share at/above the floor", () => {
    const draft = validateCharterDraft({
      memberShareRows: valid,
      delegatorShareBps: CHARTER_DEFAULT_DELEGATOR_SHARE_BPS,
    });
    expect(draft.memberShareBps).toHaveLength(FORM_CLUSTER_MEMBER_COUNT);
    expect(draft.memberShareBps.reduce((a, b) => a + b, 0)).toBe(
      FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS,
    );
    expect(draft.delegatorShareBps).toBe(CHARTER_DEFAULT_DELEGATOR_SHARE_BPS);
  });

  it("accepts an unequal split that still sums to exactly 10000", () => {
    const rows = ["3000", "1000", "1000", "1000", "1000", "1000", "1000", "400", "300", "300"];
    expect(memberShareSum(rows)).toBe(10000);
    const draft = validateCharterDraft({ memberShareRows: rows, delegatorShareBps: 2000 });
    expect(draft.memberShareBps[0]).toBe(3000);
  });

  it("rejects member shares that do not sum to exactly 10000 (code share-sum)", () => {
    const overRows = [...valid];
    overRows[0] = "2000"; // sum = 11000
    let code: string | undefined;
    try {
      validateCharterDraft({ memberShareRows: overRows, delegatorShareBps: 5000 });
    } catch (err) {
      code = (err as CharterDraftError).code;
    }
    expect(code).toBe("share-sum");

    const underRows = [...valid];
    underRows[0] = "0"; // sum = 9000
    expect(() =>
      validateCharterDraft({ memberShareRows: underRows, delegatorShareBps: 5000 }),
    ).toThrow(/sum to exactly 10000/u);
  });

  it("rejects a wrong number of member shares (code share-count)", () => {
    let code: string | undefined;
    try {
      validateCharterDraft({ memberShareRows: valid.slice(0, 9), delegatorShareBps: 5000 });
    } catch (err) {
      code = (err as CharterDraftError).code;
    }
    expect(code).toBe("share-count");
  });

  it("rejects a non-integer / out-of-range member share (code share-range)", () => {
    const badRows = [...valid];
    badRows[1] = "abc";
    let code: string | undefined;
    try {
      validateCharterDraft({ memberShareRows: badRows, delegatorShareBps: 5000 });
    } catch (err) {
      code = (err as CharterDraftError).code;
    }
    expect(code).toBe("share-range");
  });

  it("rejects a delegator share below the protocol floor (code delegator-floor)", () => {
    let code: string | undefined;
    try {
      validateCharterDraft({
        memberShareRows: valid,
        delegatorShareBps: FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS - 1,
      });
    } catch (err) {
      code = (err as CharterDraftError).code;
    }
    expect(code).toBe("delegator-floor");
  });

  it("accepts a delegator share exactly at the floor (boundary)", () => {
    const draft = validateCharterDraft({
      memberShareRows: valid,
      delegatorShareBps: FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS,
    });
    expect(draft.delegatorShareBps).toBe(FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS);
  });

  it("rejects a delegator share above 10000 (code delegator-ceiling)", () => {
    let code: string | undefined;
    try {
      validateCharterDraft({
        memberShareRows: valid,
        delegatorShareBps: FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS + 1,
      });
    } catch (err) {
      code = (err as CharterDraftError).code;
    }
    expect(code).toBe("delegator-ceiling");
  });

  it("accepts a delegator share at the 10000 ceiling (boundary)", () => {
    const draft = validateCharterDraft({
      memberShareRows: valid,
      delegatorShareBps: FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS,
    });
    expect(draft.delegatorShareBps).toBe(FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS);
  });
});
