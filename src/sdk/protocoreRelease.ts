// Signed protocore release feed (frontend facade).
//
// The app's own binary is kept current by the Tauri updater
// (`updater.ts`). This surface answers the separate question of whether the
// operator's protocore NODE is running the latest SIGNED release published
// on GitHub.
//
// The actual GitHub fetch happens in the Rust `latest_protocore_release`
// command (CSP + rate-limit live there); this module wraps it behind an
// `isTauri()` guard and returns `null` on any failure — failing to reach
// GitHub is not user-actionable and a noisy banner is worse than silence,
// mirroring `updater.ts`.
//
// The node identity is read from `lyth_runtimeProvenance`. CRITICAL: the
// only reliable cross-release identity is the git commit. `runtime.version`
// is the crate version ("0.1.0") and does NOT track the release tag;
// `runtime.binarySha256` is the BINARY sha and is NOT the manifest's TARBALL
// sha. We compare ONLY the first 12 chars of the release's
// `monoCoreCommit` against `runtime.gitCommit`.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeProvenanceResponse } from "@monolythium/core-sdk";

export interface LatestProtocoreRelease {
  tag: string;
  name: string;
  publishedAt: string;
  /** Release body / changelog. */
  notes: string;
  htmlUrl: string;
  /** `compatibility.mono_core_commit` from the release manifest, when present.
   *  The only reliable cross-release identity. */
  monoCoreCommit: string | null;
  /** `platforms.x86_64-linux.sha256` from the manifest — the TARBALL sha
   *  (display-only; never compared against the runtime binary sha). */
  tarballSha256: string | null;
  /** `platforms.x86_64-linux.binary_sha256` from the manifest — the sha256 of
   *  the EXTRACTED protocore binary. This IS comparable to the node's
   *  `runtime.binarySha256`, so it is a fallback build identity when the git
   *  commit comparison fails (the release binary self-reports a dirty
   *  git-describe string). `null` when the manifest does not publish it. */
  binarySha256: string | null;
  /** Whether the release carries BOTH a cosign `.sig` and `.pem`. PRESENCE
   *  on the published release, NOT an on-device verification. */
  signed: boolean;
  /** Whether an SBOM (`*.spdx.json`) asset is present. */
  sbom: boolean;
  /** The matching Monarch OS installer image, derived from the tag. */
  installerImage: string;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const COMMIT_PREFIX = 12;

/** Normalize a git commit to the comparable identity: lowercase + trim, then the
 *  first {@link COMMIT_PREFIX} chars. The ONLY safe way to compare a release's
 *  `monoCoreCommit` (often full 40-hex, mixed case) against `runtime.gitCommit`
 *  (full 40-hex) — never compare the raw strings (length AND case differ). */
export function shortCommit(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed.slice(0, COMMIT_PREFIX) : null;
}

/** Normalize a sha256 to a comparable identity: lowercase, trimmed, `0x`
 *  stripped. Used to compare the release manifest's `binarySha256` against the
 *  node's `runtime.binarySha256` (a full 64-hex string). */
export function normalizeSha256(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase().replace(/^0x/u, "");
  return /^[0-9a-f]{64}$/u.test(trimmed) ? trimmed : null;
}

/** True when a release's binary sha and the node's runtime binary sha refer to
 *  the same build. Both go through {@link normalizeSha256}; two unreadable shas
 *  never match (an absent sha is not a confirmation). */
export function binaryShaMatches(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizeSha256(a);
  const right = normalizeSha256(b);
  return left !== null && right !== null && left === right;
}

/** True when two commits refer to the same build (normalized first-12 match).
 *  Both sides go through {@link shortCommit}, so a 40-hex `runtime.gitCommit`
 *  and a 12-hex target compare equal, case- and whitespace-insensitively. Two
 *  unreadable commits never match (`null !== null` here is intentional — an
 *  absent commit is not a confirmation). */
export function commitMatches(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = shortCommit(a);
  const right = shortCommit(b);
  return left !== null && right !== null && left === right;
}

/** Resolve a known commit to its friendly release tag, given the release feed.
 *  Returns the matching release `tag` when the commit equals some release's
 *  `monoCoreCommit` (first-12, normalized), else `null`. Use this everywhere a
 *  version would otherwise render as a bare `dev <commit>` / `0.1.0+<gitsha>`:
 *  a commit the feed knows always shows as its tag. Pure. */
export function friendlyTagForCommit(
  releases: LatestProtocoreRelease[],
  commit: string | null | undefined,
): string | null {
  const target = shortCommit(commit);
  if (!target) return null;
  const match = releases.find((r) => shortCommit(r.monoCoreCommit) === target);
  return match ? match.tag : null;
}

/** Discover the latest signed protocore release. Returns `null` outside a
 *  Tauri runtime or on any error (silent — mirrors `checkForUpdate`). */
export async function fetchLatestProtocoreRelease(
  channel?: string,
): Promise<LatestProtocoreRelease | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<LatestProtocoreRelease>("latest_protocore_release", { channel });
  } catch {
    return null;
  }
}

/** Discover the most recent signed protocore releases (newest first) for the
 *  channel — backs the topbar update dropdown. Returns `[]` outside a Tauri
 *  runtime or on any error (silent, like {@link fetchLatestProtocoreRelease}).
 *  `limit` is advisory; the Rust side clamps it. */
export async function fetchRecentProtocoreReleases(
  channel?: string,
  limit?: number,
): Promise<LatestProtocoreRelease[]> {
  if (!isTauri()) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<LatestProtocoreRelease[]>("recent_protocore_releases", {
      channel,
      limit,
    });
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

export type ProtocoreUpdateState =
  | "current"
  | "update-available"
  | "dev-build"
  | "unknown";

export type ProtocoreUpdateStatus = {
  state: ProtocoreUpdateState;
  className: string;
  text: string;
  title: string;
  /** The running node's git commit (first 12), when it reported one. Present
   *  for the `dev-build`/`current`/`update-available` states; `null` when the
   *  node did not report an identity (the `unknown` state). */
  nodeCommit: string | null;
};

export type ProtocoreUpdateStatusInput = {
  release: LatestProtocoreRelease | null;
  provenance: RuntimeProvenanceResponse | null;
};

/** Compare the running node's git commit against the latest signed release.
 *  Pure. HONEST: we never assert the node is "outdated". When the node reports
 *  a real commit that matches no signed release, it is named a `dev-build`
 *  (running an unreleased build) rather than collapsed into "unknown" — the two
 *  are genuinely different states. */
export function protocoreUpdateStatus({
  release,
  provenance,
}: ProtocoreUpdateStatusInput): ProtocoreUpdateStatus {
  const nodeCommit = shortCommit(provenance?.runtime.gitCommit);

  if (!release || !provenance) {
    return {
      state: "unknown",
      className: "halo halo--info",
      text: "release check unavailable",
      title: !release
        ? "Could not read the latest signed protocore release."
        : "Runtime provenance is not available from the connected node.",
      nodeCommit,
    };
  }

  if (!nodeCommit) {
    return {
      state: "unknown",
      className: "halo halo--info",
      text: "release check unavailable",
      title: "The running node did not report a git commit in lyth_runtimeProvenance.",
      nodeCommit: null,
    };
  }

  const releaseCommit = shortCommit(release.monoCoreCommit);
  if (!releaseCommit) {
    return {
      state: "unknown",
      className: "halo halo--info",
      text: "release check unavailable",
      title: `${release.tag} has no manifest commit to compare against the running node.`,
      nodeCommit,
    };
  }

  if (releaseCommit === nodeCommit) {
    return {
      state: "current",
      className: "halo halo--ok",
      text: "node is current",
      title: `Node is running the latest signed release (${release.tag}, commit ${releaseCommit}).`,
      nodeCommit,
    };
  }

  // Commit mismatch, but fall back to the binary sha before naming it a dev
  // build. The release binary self-reports a dirty git-describe string, so the
  // exact release build reports a commit that does not match the manifest's
  // mono_core_commit. When the manifest publishes a binarySha256 and it matches
  // the node's runtime binary sha, the node IS running the release — classify it
  // "current" despite the differing git-describe strings.
  if (binaryShaMatches(release.binarySha256, provenance.runtime.binarySha256)) {
    const sha = normalizeSha256(release.binarySha256);
    return {
      state: "current",
      className: "halo halo--ok",
      text: "node is current",
      title: `Node binary matches the latest signed release (${release.tag}, binary sha ${sha?.slice(0, 12)}…) despite a differing git-describe string.`,
      nodeCommit,
    };
  }

  // The node reported a real commit that does not match the latest signed
  // release. This is an unreleased / dev build — name it honestly instead of
  // the alarming "could not match". The latest signed release is still offered
  // to apply so the operator can move onto a signed build.
  return {
    state: "dev-build",
    className: "halo halo--info",
    text: `running unreleased build ${nodeCommit}`,
    title: `Node is running an unreleased build (${nodeCommit}); the latest signed release is ${release.tag} (commit ${releaseCommit}). Apply it to move onto a signed build.`,
    nodeCommit,
  };
}

/** What kind of build the running node is on, relative to the signed releases:
 *   - `matched`     — the node's commit matches a listed release,
 *   - `dev-build`   — the node reported a commit that matches no release
 *                     (a known but unreleased / dev build),
 *   - `unidentified`— the node reported no commit at all (truly unknown). */
export type NodeReleaseKind = "matched" | "dev-build" | "unidentified";

/** The running node's position within a list of recent releases. PURE so the
 *  topbar dropdown and tests share one source of truth. */
export type NodeReleaseSummary = {
  /** Discriminant for the three states above. */
  kind: NodeReleaseKind;
  /** Release the running node is on (its `monoCoreCommit` first-12 matches
   *  `runtime.gitCommit`), or `null` when no listed release matches. */
  current: LatestProtocoreRelease | null;
  /** The running node's git commit (first 12), or `null` when the node did not
   *  report one. Lets the chip name a dev build (`node: dev <commit>`). */
  nodeCommit: string | null;
  /** Display label for the running node's build: the matching release tag,
   *  `dev <commit>` for an unreleased build, or "unknown build" when the node
   *  reported no identity at all. */
  label: string;
  /** Whether the list contains a release NEWER than the node's current one.
   *  Newest-first ordering means: any release ahead of the matched index, or —
   *  when the node matches nothing but the list is non-empty — a newer build
   *  exists to move to. HONEST: this means "a different/newer signed release is
   *  available", never "the node is outdated". */
  updateAvailable: boolean;
  /** The newest release in the list, if any (the dropdown's headline). */
  latest: LatestProtocoreRelease | null;
};

/** Locate the running node within a newest-first release list and report
 *  whether a newer signed release exists. Pure. The caller passes releases
 *  already ordered newest-first (as the Rust feed returns them). */
export function protocoreNodeReleaseSummary(
  releases: LatestProtocoreRelease[],
  provenance: RuntimeProvenanceResponse | null,
): NodeReleaseSummary {
  const latest = releases[0] ?? null;
  const nodeCommit = shortCommit(provenance?.runtime.gitCommit);

  if (!nodeCommit) {
    // No node identity to compare — truly unidentified. Never claim an update
    // is available, since we can't reason about what the node runs.
    return {
      kind: "unidentified",
      current: null,
      nodeCommit: null,
      label: "unknown build",
      updateAvailable: false,
      latest,
    };
  }

  const current =
    releases.find((r) => shortCommit(r.monoCoreCommit) === nodeCommit) ?? null;
  if (!current) {
    // The node reported a real commit that matches no listed release — a known
    // dev / unreleased build. Name it honestly (`dev <commit>`); a newer signed
    // build exists to move to as long as the list is non-empty.
    return {
      kind: "dev-build",
      current: null,
      nodeCommit,
      label: `dev ${nodeCommit}`,
      updateAvailable: latest !== null,
      latest,
    };
  }

  // Newest-first: anything before the matched index is newer than the node.
  const index = releases.indexOf(current);
  return {
    kind: "matched",
    current,
    nodeCommit,
    label: current.tag,
    updateAvailable: index > 0,
    latest,
  };
}

/** The resolution state of a derived installer image tag on ghcr. */
export type InstallerImageExistence = "checking" | "exists" | "absent" | "unverified";

/** HEAD the ghcr manifest for a derived installer image. Returns `true`/`false`
 *  for a resolvable/absent tag, or `null` outside Tauri or on any error (the
 *  caller renders that as "could not verify"). */
export async function fetchInstallerImageExists(image: string): Promise<boolean | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ image: string; exists: boolean }>("installer_image_exists", {
      image,
    });
    return result.exists;
  } catch {
    return null;
  }
}

/** Resolve whether a derived installer image tag exists on ghcr, once per image
 *  ref. Backs the OTA Apply guard: a tag that 404s must disable Apply so the
 *  flow never dead-ends at an image pull. */
export function useInstallerImageExists(image: string | null): InstallerImageExistence {
  const [state, setState] = useState<InstallerImageExistence>("checking");

  useEffect(() => {
    if (!image) {
      setState("checking");
      return;
    }
    let cancelled = false;
    setState("checking");
    fetchInstallerImageExists(image)
      .then((exists) => {
        if (cancelled) return;
        setState(exists === null ? "unverified" : exists ? "exists" : "absent");
      })
      .catch(() => {
        if (!cancelled) setState("unverified");
      });
    return () => {
      cancelled = true;
    };
  }, [image]);

  return state;
}

export type LatestProtocoreReleaseHook = {
  data: LatestProtocoreRelease | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/** Fetch the latest signed release once on mount, plus a manual `refresh()`.
 *  Deliberately NOT a tight poll: the unauthenticated GitHub limit is 60/hr,
 *  so this never sits on an interval. */
export function useLatestProtocoreRelease(channel?: string): LatestProtocoreReleaseHook {
  const [data, setData] = useState<LatestProtocoreRelease | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchLatestProtocoreRelease(channel)
      .then((result) => {
        if (cancelled || !mounted.current) return;
        setData(result);
        if (result === null) setError("release feed unavailable");
        setLoading(false);
      })
      .catch(() => {
        if (cancelled || !mounted.current) return;
        setData(null);
        setError("release feed unavailable");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channel, nonce]);

  return { data, loading, error, refresh };
}

export type RecentProtocoreReleasesHook = {
  data: LatestProtocoreRelease[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/** Fetch the recent signed releases once on mount, plus a manual `refresh()`.
 *  Like {@link useLatestProtocoreRelease}, deliberately NOT a tight poll — the
 *  unauthenticated GitHub limit is 60/hr — so it never sits on an interval. */
export function useRecentProtocoreReleases(
  channel?: string,
  limit?: number,
): RecentProtocoreReleasesHook {
  const [data, setData] = useState<LatestProtocoreRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRecentProtocoreReleases(channel, limit)
      .then((result) => {
        if (cancelled || !mounted.current) return;
        setData(result);
        if (result.length === 0) setError("release feed unavailable");
        setLoading(false);
      })
      .catch(() => {
        if (cancelled || !mounted.current) return;
        setData([]);
        setError("release feed unavailable");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channel, limit, nonce]);

  return { data, loading, error, refresh };
}
