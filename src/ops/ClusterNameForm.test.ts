import { describe, expect, it } from "vitest";
import { isClusterNameInputComplete } from "./ClusterNameForm";

describe("cluster name form validation", () => {
  it("requires a uint64 cluster id and lowercase name", () => {
    expect(isClusterNameInputComplete(undefined)).toBe(false);
    expect(isClusterNameInputComplete({ clusterId: "", name: "athena" })).toBe(false);
    expect(isClusterNameInputComplete({ clusterId: "-1", name: "athena" })).toBe(false);
    expect(isClusterNameInputComplete({ clusterId: "0", name: "ab" })).toBe(false);
    expect(isClusterNameInputComplete({ clusterId: "0", name: "a".repeat(33) })).toBe(false);
    expect(isClusterNameInputComplete({ clusterId: "0", name: "Athena" })).toBe(false);
    expect(isClusterNameInputComplete({ clusterId: "0", name: "athena7" })).toBe(false);
    expect(isClusterNameInputComplete({ clusterId: "0", name: "athena" })).toBe(true);
  });
});
