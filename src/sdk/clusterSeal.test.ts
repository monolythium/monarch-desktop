import { describe, expect, it } from "vitest";
import { clusterSealKeysSourceFromGenesisToml } from "./clusterSeal";

const ek1 = "11".repeat(1184);
const ek2 = "22".repeat(1184);
const ek3 = "33".repeat(1184);

function genesisToml(): string {
  return `
[[clusters]]
id = 0
threshold = 2

[[clusters.members]]
active = true
seal_ek_hex = "${ek1}"

[[clusters.members]]
active = true
seal_ek_hex = "${ek2}"

[[clusters.members]]
active = false
seal_ek_hex = "${ek3}"
`;
}

describe("cluster seal roster resolution", () => {
  it("extracts the full cluster seal roster from genesis TOML", () => {
    const source = clusterSealKeysSourceFromGenesisToml(genesisToml());

    expect(source.clusterId).toBe(0);
    expect(source.epoch).toBe(0);
    expect(source.t).toBe(2);
    expect(source.n).toBe(3);
    expect(source.roster).toEqual([
      { operatorIndex: 1, mlKemEk: `0x${ek1}` },
      { operatorIndex: 2, mlKemEk: `0x${ek2}` },
      { operatorIndex: 3, mlKemEk: `0x${ek3}` },
    ]);
  });

  it("rejects a mismatched pinned genesis hash", () => {
    expect(() =>
      clusterSealKeysSourceFromGenesisToml(genesisToml(), {
        expectedGenesisHash: `0x${"00".repeat(32)}`,
      }),
    ).toThrow(/genesis hash mismatch/u);
  });
});
