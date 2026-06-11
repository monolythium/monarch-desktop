import { describe, expect, it } from "vitest";
import { matchSelfMember } from "./useSelfOperator";

const MEMBERS = [
  { operatorId: "0xAAaa00000000000000000000000000000000000000000000000000000000aaaa" },
  { operatorId: "0xbbbb00000000000000000000000000000000000000000000000000000000bbbb" },
  { operatorId: "0xcccc00000000000000000000000000000000000000000000000000000000cccc" },
];

describe("matchSelfMember (YOU badge resolution)", () => {
  it("finds the seat index case-insensitively", () => {
    expect(
      matchSelfMember(
        MEMBERS,
        "0xaaAA00000000000000000000000000000000000000000000000000000000AAAA",
      ),
    ).toBe(0);
    expect(matchSelfMember(MEMBERS, MEMBERS[2]?.operatorId)).toBe(2);
  });

  it("returns null when the local operator holds no seat", () => {
    expect(matchSelfMember(MEMBERS, "0xdddd")).toBeNull();
  });

  it("returns null — never member[0] — when no key identity exists", () => {
    expect(matchSelfMember(MEMBERS, null)).toBeNull();
    expect(matchSelfMember(MEMBERS, undefined)).toBeNull();
    expect(matchSelfMember(MEMBERS, "  ")).toBeNull();
  });
});
