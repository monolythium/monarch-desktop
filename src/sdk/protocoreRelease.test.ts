import { describe, expect, it } from "vitest";
import type { RuntimeProvenanceResponse } from "@monolythium/core-sdk";
import {
  binaryShaMatches,
  commitMatches,
  friendlyTagForCommit,
  normalizeSha256,
  protocoreNodeReleaseSummary,
  protocoreUpdateStatus,
  shortCommit,
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
    binarySha256: null,
    signed: true,
    sbom: true,
    installerImage: "ghcr.io/monolythium/monarch-os-installer:v0.1.52-testnet",
    ...overrides,
  };
}

function provenance(
  gitCommit: string | null,
  binarySha256: string | null = "ff".repeat(32),
): RuntimeProvenanceResponse {
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
      binarySha256,
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

  it("reports current on a binary-sha match even when the git commit differs", () => {
    // The release binary self-reports a dirty git-describe string, so the exact
    // release build reports a commit that matches no release. When the manifest
    // publishes a binarySha256 that matches the node's runtime binary sha, the
    // node IS on the release — classify current, not dev-build.
    const sha = "0c7dd293".repeat(8);
    const status = protocoreUpdateStatus({
      release: release({ binarySha256: `0x${sha.toUpperCase()}` }),
      provenance: provenance(NODE_COMMIT_DIFFER, sha),
    });
    expect(status.state).toBe("current");
    expect(status.className).toBe("halo halo--ok");
    expect(status.title).toContain("despite a differing git-describe string");
  });

  it("still reports dev-build when neither the commit nor the binary sha match", () => {
    const status = protocoreUpdateStatus({
      release: release({ binarySha256: `0x${"0c7dd293".repeat(8)}` }),
      provenance: provenance(NODE_COMMIT_DIFFER, "ab".repeat(32)),
    });
    expect(status.state).toBe("dev-build");
  });

  it("normalizes and compares binary shas case- and 0x-insensitively", () => {
    const sha = "0c7dd293".repeat(8);
    expect(normalizeSha256(`0x${sha.toUpperCase()}`)).toBe(sha);
    expect(normalizeSha256("not-a-sha")).toBeNull();
    expect(normalizeSha256(null)).toBeNull();
    expect(binaryShaMatches(`0x${sha}`, sha.toUpperCase())).toBe(true);
    expect(binaryShaMatches(sha, "ab".repeat(32))).toBe(false);
    // Two absent shas never match (absence is not confirmation).
    expect(binaryShaMatches(null, null)).toBe(false);
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

describe("commitMatches (commit normalization)", () => {
  // The release manifest carries a full 40-hex commit (often mixed case); the
  // node reports a full 40-hex `runtime.gitCommit`. They must compare equal on
  // the normalized first-12.
  const FULL_40 = "B4257F14ABCD9999deadbeefcafef00d12345678"; // 40 hex, upper-ish
  const SHORT_12 = "b4257f14abcd"; // first 12, lowercase

  it("matches a full 40-hex commit against a 12-hex target (case-insensitive)", () => {
    expect(commitMatches(FULL_40, SHORT_12)).toBe(true);
    expect(commitMatches(SHORT_12, FULL_40)).toBe(true);
  });

  it("ignores surrounding whitespace and case on both sides", () => {
    expect(commitMatches("  B4257F14ABCD9999  ", "b4257f14abcd")).toBe(true);
    expect(commitMatches("\tB4257F14ABCDxxxx\n", "B4257F14ABCD")).toBe(true);
  });

  it("does NOT match when the first 12 differ", () => {
    expect(commitMatches("b4257f14abcd9999", "000000000000ffff")).toBe(false);
  });

  it("never matches when either side is absent (absence is not confirmation)", () => {
    expect(commitMatches(null, SHORT_12)).toBe(false);
    expect(commitMatches(SHORT_12, undefined)).toBe(false);
    expect(commitMatches(null, null)).toBe(false);
    expect(commitMatches("", SHORT_12)).toBe(false);
    expect(commitMatches("   ", SHORT_12)).toBe(false);
  });

  it("shortCommit lowercases, trims, then slices to 12", () => {
    expect(shortCommit("  B4257F14ABCD9999  ")).toBe("b4257f14abcd");
    expect(shortCommit("abc")).toBe("abc");
    expect(shortCommit(null)).toBeNull();
    expect(shortCommit("")).toBeNull();
  });
});

describe("friendlyTagForCommit", () => {
  const releases: LatestProtocoreRelease[] = [
    release({ tag: "v0.1.60-testnet", monoCoreCommit: "45743855AAAA1111" }),
    release({ tag: "v0.1.52-testnet", monoCoreCommit: "a40ea06ebbbb2222" }),
  ];

  it("resolves a known commit (full 40-hex, mixed case) to its release tag", () => {
    expect(friendlyTagForCommit(releases, "45743855aaaa1111ffffffffffffffffffffffff")).toBe(
      "v0.1.60-testnet",
    );
    expect(friendlyTagForCommit(releases, "A40EA06EBBBB2222")).toBe("v0.1.52-testnet");
  });

  it("returns null for an unknown commit or an empty/absent commit", () => {
    expect(friendlyTagForCommit(releases, "ffffffffffff0000")).toBeNull();
    expect(friendlyTagForCommit(releases, null)).toBeNull();
    expect(friendlyTagForCommit(releases, "")).toBeNull();
    expect(friendlyTagForCommit([], "45743855aaaa1111")).toBeNull();
  });
});
