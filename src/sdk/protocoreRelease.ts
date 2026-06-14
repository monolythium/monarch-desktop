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
