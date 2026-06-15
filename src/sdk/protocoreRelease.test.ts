import { describe, expect, it } from "vitest";
import type { RuntimeProvenanceResponse } from "@monolythium/core-sdk";
import {
  protocoreNodeReleaseSummary,
  protocoreUpdateStatus,
  type LatestProtocoreRelease,
} from "./protocoreRelease";

const RELEASE_COMMIT = "b4257f14abcd9999";
const NODE_COMMIT_MATCH = "b4257f14abcd0000"; // same first 12 chars
const NODE_COMMIT_DIFFER = "0000000000009999";

function release(overrides: Partial<LatestProtocoreRelease> = {}): LatestProtocoreRelease {
  return {
    tag: "v0.1.52-testnet",
    name: "v0.1.52-testnet",
    publishedAt: "2026-06-13T00:00:00Z",
    notes: "changelog",
    htmlUrl: "https://github.com/monolythium/protocore/releases/tag/v0.1.52-testnet",
    monoCoreCommit: RELEASE_COMMIT,
    tarballSha256: "deadbeef".repeat(8),
    signed: true,
    sbom: true,
    installerImage: "ghcr.io/monolythium/monarch-os-installer:v0.1.52-testnet",
    ...overrides,
  };
}

function provenance(gitCommit: string | null): RuntimeProvenanceResponse {
  return {
    schemaVersion: 1,
    chainId: 69420,
    genesisHash: `0x${"00".repeat(32)}`,
    latestHeight: 1234,
    runtime: {
      clientName: "protocore",
      version: "0.1.0",
      gitCommit: gitCommit ?? "",
      gitDirty: false,
      buildTimestampUtc: 1_763_165_000,
      rustc: "rustc 1.90.0",
      target: "x86_64-unknown-linux-gnu",
      profile: "release",
      features: "mdbx",
      p2pProtocolVersion: 5,
      binarySha256: "ff".repeat(32),
      stateMigrations: [],
    },
    upgrade: null,
  } as RuntimeProvenanceResponse;
}

describe("protocore update status", () => {
  it("reports current when the release commit matches the node commit (first 12)", () => {
    expect(
      protocoreUpdateStatus({ release: release(), provenance: provenance(NODE_COMMIT_MATCH) }),
    ).toMatchObject({
      state: "current",
      className: "halo halo--ok",
    });
  });

  it("reports a dev-build when the node commit matches no signed release", () => {
    const status = protocoreUpdateStatus({
      release: release(),
      provenance: provenance(NODE_COMMIT_DIFFER),
    });
    // The node reported a real commit that matches no release → honest
    // "unreleased build", not the alarming "could not match".
    expect(status.state).toBe("dev-build");
    expect(status.className).toBe("halo halo--info");
    expect(status.nodeCommit).toBe(NODE_COMMIT_DIFFER.slice(0, 12));
    expect(status.text).toContain("unreleased build");
    expect(status.text).toContain(NODE_COMMIT_DIFFER.slice(0, 12));
    // HONEST: never asserts "outdated".
    expect(status.title.toLowerCase()).not.toContain("outdated");
    expect(status.title.toLowerCase()).toContain("unreleased build");
  });

  it("is unknown when the release is missing", () => {
    expect(
      protocoreUpdateStatus({ release: null, provenance: provenance(NODE_COMMIT_MATCH) }),
    ).toMatchObject({ state: "unknown", className: "halo halo--info" });
  });

  it("is unknown when provenance is missing", () => {
    expect(
      protocoreUpdateStatus({ release: release(), provenance: null }),
    ).toMatchObject({ state: "unknown", className: "halo halo--info" });
  });

  it("is unknown (no error) when the release manifest commit is null", () => {
    expect(
      protocoreUpdateStatus({
        release: release({ monoCoreCommit: null }),
        provenance: provenance(NODE_COMMIT_MATCH),
      }),
    ).toMatchObject({ state: "unknown", className: "halo halo--info" });
  });

  it("is unknown when the node reports no git commit", () => {
    expect(
      protocoreUpdateStatus({ release: release(), provenance: provenance(null) }),
    ).toMatchObject({ state: "unknown", className: "halo halo--info" });
  });
});

describe("protocore node release summary", () => {
  // Newest-first list: v0.1.52 (newest) → v0.1.51 → v0.1.50 (oldest).
  const NEWEST = "aaaaaaaaaaaa0000";
  const MIDDLE = "bbbbbbbbbbbb0000";
  const OLDEST = "cccccccccccc0000";

  function list(): LatestProtocoreRelease[] {
    return [
      release({ tag: "v0.1.52-testnet", monoCoreCommit: NEWEST }),
      release({ tag: "v0.1.51-testnet", monoCoreCommit: MIDDLE }),
      release({ tag: "v0.1.50-testnet", monoCoreCommit: OLDEST }),
    ];
  }

  it("labels the running release and reports no update when node is on the newest", () => {
    // Node commit shares the first 12 chars of the newest release.
    const summary = protocoreNodeReleaseSummary(list(), provenance("aaaaaaaaaaaa9999"));
    expect(summary.kind).toBe("matched");
    expect(summary.label).toBe("v0.1.52-testnet");
    expect(summary.nodeCommit).toBe("aaaaaaaaaaaa");
    expect(summary.current?.tag).toBe("v0.1.52-testnet");
    expect(summary.updateAvailable).toBe(false);
    expect(summary.latest?.tag).toBe("v0.1.52-testnet");
  });

  it("flags update available when the node is on an older listed release", () => {
    const summary = protocoreNodeReleaseSummary(list(), provenance(OLDEST));
    expect(summary.label).toBe("v0.1.50-testnet");
    expect(summary.current?.tag).toBe("v0.1.50-testnet");
    expect(summary.updateAvailable).toBe(true);
  });

  it("middle release sees a newer one but is not the latest", () => {
    const summary = protocoreNodeReleaseSummary(list(), provenance(MIDDLE));
    expect(summary.label).toBe("v0.1.51-testnet");
    expect(summary.updateAvailable).toBe(true);
  });

  it("names a dev build (still offers a move) when no listed release matches", () => {
    const summary = protocoreNodeReleaseSummary(list(), provenance("ffffffffffff0000"));
    expect(summary.kind).toBe("dev-build");
    expect(summary.current).toBeNull();
    expect(summary.nodeCommit).toBe("ffffffffffff");
    // The build is named honestly by its commit, not collapsed into "unknown".
    expect(summary.label).toBe("dev ffffffffffff");
    // A newer signed build exists to move to, since the list is non-empty.
    expect(summary.updateAvailable).toBe(true);
    expect(summary.latest?.tag).toBe("v0.1.52-testnet");
  });

  it("is unidentified (never claims an update) when provenance is missing", () => {
    const summary = protocoreNodeReleaseSummary(list(), null);
    expect(summary.kind).toBe("unidentified");
    expect(summary.current).toBeNull();
    expect(summary.nodeCommit).toBeNull();
    expect(summary.label).toBe("unknown build");
    expect(summary.updateAvailable).toBe(false);
  });

  it("is unidentified (never claims an update) when the node reports no git commit", () => {
    const summary = protocoreNodeReleaseSummary(list(), provenance(null));
    expect(summary.kind).toBe("unidentified");
    expect(summary.nodeCommit).toBeNull();
    expect(summary.label).toBe("unknown build");
    expect(summary.updateAvailable).toBe(false);
  });

  it("empty release list with a node commit yields a dev build, no update, no latest", () => {
    const summary = protocoreNodeReleaseSummary([], provenance(NEWEST));
    expect(summary.kind).toBe("dev-build");
    expect(summary.current).toBeNull();
    expect(summary.nodeCommit).toBe(NEWEST.slice(0, 12));
    expect(summary.label).toBe(`dev ${NEWEST.slice(0, 12)}`);
    // No release to move to.
    expect(summary.updateAvailable).toBe(false);
    expect(summary.latest).toBeNull();
  });

  it("HONEST: never describes the node as outdated", () => {
    const summary = protocoreNodeReleaseSummary(list(), provenance(OLDEST));
    expect(JSON.stringify(summary).toLowerCase()).not.toContain("outdated");
  });
});
