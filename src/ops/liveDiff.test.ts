import { describe, expect, it } from "vitest";
import { liveDiffRows } from "./liveDiff";
import type { OpRequest } from "./types";

function req(partial: Partial<OpRequest> & { kind: OpRequest["kind"] }): OpRequest {
  return {
    title: "t",
    sub: "s",
    intro: "i",
    fields: [],
    ...partial,
  };
}

describe("liveDiffRows", () => {
  it("returns null when the kind has no live input yet (drawer falls back to catalog)", () => {
    expect(liveDiffRows(req({ kind: "operator-register" }))).toBeNull();
    expect(liveDiffRows(req({ kind: "operator-start" }))).toBeNull();
  });

  it("renders the operator's real register values, not placeholders", () => {
    const rows = liveDiffRows(
      req({
        kind: "operator-register",
        registerInput: {
          endpoint: "https://node.example",
          capabilities: 0x0003,
          bondLythoshi: (5000n * 10n ** 18n).toString(),
        },
      }),
    );
    expect(rows).not.toBeNull();
    const byKey = Object.fromEntries((rows ?? []).map((row) => [row.key, row.value]));
    expect(byKey["endpoint"]).toBe("https://node.example");
    expect(byKey["capabilities"]).toBe("0x0003");
    expect(byKey["bond"]).toContain("5,000");
    expect(byKey["bond"]).not.toContain("operator-supplied");
  });

  it("renders the real redelegate route and weight percentage", () => {
    const rows = liveDiffRows(
      req({
        kind: "redelegate",
        redelegateInput: { fromCluster: 0, toCluster: 1, weightBps: 2500 },
      }),
    );
    const byKey = Object.fromEntries((rows ?? []).map((row) => [row.key, row.value]));
    expect(byKey["route"]).toBe("C-000 → C-001");
    expect(byKey["weight"]).toBe("25.00%");
  });

  it("marks unset values explicitly instead of inventing them", () => {
    const rows = liveDiffRows(
      req({
        kind: "cluster-request-join",
        clusterJoinRequestInput: { clusterId: "", operatorPubkeyHex: "", bondLythoshi: "0" },
      }),
    );
    const byKey = Object.fromEntries((rows ?? []).map((row) => [row.key, row.value]));
    expect(byKey["cluster"]).toBe("(not set)");
    expect(byKey["pubkey"]).toBe("(not set)");
  });

  it("summarises the cluster-form roster from the live textarea contents", () => {
    const rows = liveDiffRows(
      req({
        kind: "cluster-form",
        clusterFormInput: { activePubkeysHex: "", standbyPubkeysHex: "", signaturesHex: "" },
      }),
    );
    const byKey = Object.fromEntries((rows ?? []).map((row) => [row.key, row.value]));
    expect(byKey["roster"]).toBe("0 active + 0 standby (0 consents)");
    expect(byKey["digest"]).toBe("(roster incomplete)");
  });

  it("shows the resignation nonce and expedite flag verbatim", () => {
    const rows = liveDiffRows(
      req({
        kind: "cluster-resign",
        clusterResignationInput: { clusterId: "", nonce: "7", expedite: false },
      }),
    );
    const byKey = Object.fromEntries((rows ?? []).map((row) => [row.key, row.value]));
    expect(byKey["nonce"]).toBe("7");
    expect(byKey["expedite"]).toBe("off");
  });
});
