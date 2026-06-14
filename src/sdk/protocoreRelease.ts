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

const COMMIT_PREFIX = 12;

function shortCommit(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, COMMIT_PREFIX) : null;
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

export type ProtocoreUpdateState = "current" | "update-available" | "unknown";

export type ProtocoreUpdateStatus = {
  state: ProtocoreUpdateState;
  className: string;
  text: string;
  title: string;
};

export type ProtocoreUpdateStatusInput = {
  release: LatestProtocoreRelease | null;
  provenance: RuntimeProvenanceResponse | null;
};

/** Compare the running node's git commit against the latest signed release.
 *  Pure. HONEST: we never assert the node is "outdated" — only that the build
 *  "differs from / an update is available", because the commit is the single
 *  cross-release identity we can trust. */
export function protocoreUpdateStatus({
  release,
  provenance,
}: ProtocoreUpdateStatusInput): ProtocoreUpdateStatus {
  if (!release || !provenance) {
    return {
      state: "unknown",
      className: "halo halo--info",
      text: "release check unavailable",
      title: !release
        ? "Could not read the latest signed protocore release."
        : "Runtime provenance is not available from the connected node.",
    };
  }

  const releaseCommit = shortCommit(release.monoCoreCommit);
  if (!releaseCommit) {
    return {
      state: "unknown",
      className: "halo halo--info",
      text: "release check unavailable",
      title: `${release.tag} has no manifest commit to compare against the running node.`,
    };
  }

  const nodeCommit = shortCommit(provenance.runtime.gitCommit);
  if (!nodeCommit) {
    return {
      state: "unknown",
      className: "halo halo--info",
      text: "release check unavailable",
      title: "The running node did not report a git commit in lyth_runtimeProvenance.",
    };
  }

  if (releaseCommit === nodeCommit) {
    return {
      state: "current",
      className: "halo halo--ok",
      text: "node is current",
      title: `Node is running the latest signed release (${release.tag}, commit ${releaseCommit}).`,
    };
  }

  return {
    state: "update-available",
    className: "halo halo--warn",
    text: "update available",
    title: `Node build differs from the latest signed release — ${release.tag} available (release ${releaseCommit}, node ${nodeCommit}).`,
  };
}

/** The running node's position within a list of recent releases. PURE so the
 *  topbar dropdown and tests share one source of truth. */
export type NodeReleaseSummary = {
  /** Release the running node is on (its `monoCoreCommit` first-12 matches
   *  `runtime.gitCommit`), or `null` when no listed release matches. */
  current: LatestProtocoreRelease | null;
  /** Display label for the running node's build: the matching release tag, or
   *  "unknown build" when nothing matches / provenance is missing. */
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
    // No node identity to compare — never claim an update is available.
    return { current: null, label: "unknown build", updateAvailable: false, latest };
  }

  const current =
    releases.find((r) => shortCommit(r.monoCoreCommit) === nodeCommit) ?? null;
  if (!current) {
    // The node build matches no listed release. A newer signed build exists to
    // move to as long as the list is non-empty, but we cannot name the node's
    // own release, so the label stays "unknown build".
    return {
      current: null,
      label: "unknown build",
      updateAvailable: latest !== null,
      latest,
    };
  }

  // Newest-first: anything before the matched index is newer than the node.
  const index = releases.indexOf(current);
  return {
    current,
    label: current.tag,
    updateAvailable: index > 0,
    latest,
  };
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
