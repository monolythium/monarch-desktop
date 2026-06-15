// Topbar "node: <version>" chip + protocore release dropdown.
//
// Always-visible companion to the EndpointChip: it shows the SIGNED protocore
// release the connected node is running and flags when a newer signed release
// has been published. Clicking it opens a dropdown listing the recent
// releases (version · what changed · date · signed-assets indicator); the
// currently-running release is marked, and each NEWER release carries an
// "Apply" button that opens the IDENTICAL guarded OTA drawer
// (preview → passkey → execute) with the installer image PRE-FILLED — the
// operator never types a registry reference.
//
// HONESTY: the node label is the matching release TAG (or "unknown build"),
// never the crate `runtime.version` ("0.1.0"). The "signed" indicator means
// the cosign .sig/.pem + SBOM assets are PRESENT on the published release, NOT
// an on-device cosign verification. "Update available" means a newer/different
// signed release EXISTS, never that the node is "outdated".
//
// Degrades silently: if the release feed or node provenance is unavailable,
// the chip reads a muted "node: unknown" with no badge and never blocks.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  protocoreNodeReleaseSummary,
  useRecentProtocoreReleases,
  useRuntimeProvenance,
  type LatestProtocoreRelease,
} from "../sdk";
import { OP_CATALOG, useOps, type OpRequest } from "../ops";
import { isValidUpgradeImage } from "../ops/OtaApplyForm";

const CHANGELOG_PREVIEW_LINES = 4;

function formatReleaseDate(value: string): string {
  if (!value) return "unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

/** Build the guarded ota-apply OpRequest from a catalog entry + the selected
 *  release's derived installer image. Mirrors `catalogRequest` in
 *  DesignRoutes.tsx — kept local so the chip carries no view-layer import. */
function otaApplyRequest(image: string): OpRequest | null {
  const entry = OP_CATALOG.find((candidate) => candidate.kind === "ota-apply");
  if (!entry) return null;
  return {
    kind: entry.kind,
    title: entry.title,
    sub: entry.sub,
    intro: entry.intro,
    fields: entry.fields,
    effects: entry.effects,
    diff: entry.diff,
    icon: entry.icon,
    risk: entry.risk,
    destructive: entry.destructive,
    needsPasskey: entry.needsPasskey,
    confirmLabel: entry.confirmLabel,
    otaApplyInput: { image, stage: false, rebootMode: "default" },
  };
}

function ReleaseRow({
  release,
  isCurrent,
  isNewer,
  onApply,
}: {
  release: LatestProtocoreRelease;
  isCurrent: boolean;
  isNewer: boolean;
  onApply: (release: LatestProtocoreRelease) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(
    () => release.notes.split(/\r?\n/).filter((line) => line.trim().length > 0),
    [release.notes],
  );
  const hasMore = lines.length > CHANGELOG_PREVIEW_LINES;
  const shown = expanded ? lines : lines.slice(0, CHANGELOG_PREVIEW_LINES);
  const installerOk = isValidUpgradeImage(release.installerImage);

  return (
    <div
      style={{
        padding: "10px 0",
        borderTop: "1px solid var(--glass-stroke)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <b className="mono" style={{ fontSize: 12.5 }}>{release.tag}</b>
        {isCurrent ? (
          <span className="halo halo--ok" title="The connected node is running this release.">
            <span className="dot" /> running
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: "var(--fg-400)" }}>
          {formatReleaseDate(release.publishedAt)}
        </span>
      </div>

      <div style={{ marginTop: 6 }}>
        <span
          className={release.signed ? "halo halo--ok" : "halo halo--warn"}
          title={
            release.signed
              ? "The cosign .sig/.pem and SBOM assets are present on the published GitHub release. This is an assets-present check, not an on-device cosign verification."
              : "The published release is missing a cosign .sig/.pem pair."
          }
        >
          <span className="dot" />{" "}
          {release.signed
            ? release.sbom
              ? "signed assets + SBOM"
              : "signed assets"
            : "unsigned"}
        </span>
      </div>

      <div className="cap" style={{ margin: "8px 0 4px" }}>what changed</div>
      {shown.length > 0 ? (
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--fg-300)",
            fontFamily: "var(--font-mono, monospace)",
          }}
        >
          {shown.join("\n")}
        </pre>
      ) : (
        <div style={{ fontSize: 11, color: "var(--fg-400)" }}>No release notes published.</div>
      )}

      <div className="inline-actions" style={{ marginTop: 8, gap: 8 }}>
        {hasMore ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
        {release.htmlUrl ? (
          <a
            className="btn btn--ghost btn--sm"
            href={release.htmlUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            View on GitHub
          </a>
        ) : null}
        {isNewer ? (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => onApply(release)}
            disabled={!installerOk}
            title={
              installerOk
                ? "Open the guarded OS upgrade drawer pre-filled with this release's installer image."
                : "The derived installer image reference is not a valid upgrade image."
            }
          >
            Apply
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function NodeUpdateChip() {
  const ops = useOps();
  const provenance = useRuntimeProvenance();
  const feed = useRecentProtocoreReleases();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const summary = useMemo(
    () => protocoreNodeReleaseSummary(feed.data, provenance.data),
    [feed.data, provenance.data],
  );

  // Close on outside-click / Escape — same chrome convention as EndpointChip.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const applyRelease = (release: LatestProtocoreRelease) => {
    if (!isValidUpgradeImage(release.installerImage)) return;
    const request = otaApplyRequest(release.installerImage);
    if (!request) return;
    setOpen(false);
    // Opens the IDENTICAL guarded drawer at preview → passkey → execute.
    ops.requestOp(request);
  };

  const releases = feed.data;
  const hasReleases = releases.length > 0;
  // Three states: a matched release tag, a named dev/unreleased build
  // (`dev <commit>`), or a truly unidentified node. Only the last is muted as
  // "unknown" — a dev build is a known build and is shown honestly.
  const isDevBuild = summary.kind === "dev-build";
  const isUnidentified = summary.kind === "unidentified";
  const label = isUnidentified ? "unknown" : summary.label;
  const showBadge = summary.updateAvailable;
  const currentTag = summary.current?.tag ?? null;
  const newerTags = useMemo(() => {
    if (!hasReleases) return new Set<string>();
    if (summary.current) {
      // Newest-first: everything before the current index is newer.
      const idx = releases.findIndex((r) => r.tag === summary.current?.tag);
      return new Set(releases.slice(0, Math.max(idx, 0)).map((r) => r.tag));
    }
    // Node matches no listed release: every listed release is a candidate to
    // move to (a newer/different signed build exists).
    return new Set(releases.map((r) => r.tag));
  }, [releases, hasReleases, summary.current]);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="monarch-topbar__round"
        style={{ cursor: "pointer", gap: 6 }}
        onClick={() => {
          // Opening the dropdown re-checks for a node update on the spot, so the
          // operator never has to restart the app to see whether one is
          // available. (The feed also loads on mount.)
          const next = !open;
          setOpen(next);
          if (next && !feed.loading) feed.refresh();
        }}
        aria-label="Protocore node version and updates"
        title={
          isUnidentified
            ? "Could not match the node's build to a signed release."
            : isDevBuild
              ? `Node is running an unreleased build (${summary.nodeCommit}). A newer signed release is available — open to apply it.`
              : showBadge
                ? `Node is running ${label}. A newer signed release is available.`
                : `Node is running ${label} — the latest signed release.`
        }
      >
        <span style={{ color: "var(--fg-500)" }}>node</span>
        <b
          className="mono"
          style={{
            maxWidth: 150,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: isUnidentified ? "var(--fg-400)" : undefined,
          }}
        >
          {label}
        </b>
        {showBadge ? (
          <span className="halo halo--warn" style={{ padding: "0 6px" }}>
            <span className="dot" /> update
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 380,
            maxHeight: "70vh",
            overflowY: "auto",
            zIndex: 500,
            // Opaque fill (no backdrop blur) — a translucent update dropdown over
            // the dashboard reads as visual noise. Solid panel, content behind it
            // fully occluded.
            background: "var(--ink-200)",
            border: "1px solid var(--glass-stroke-hi)",
            borderRadius: "var(--r-md)",
            boxShadow: "var(--shadow-3)",
            padding: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div className="cap">protocore releases</div>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={feed.refresh}
              disabled={feed.loading}
            >
              {feed.loading ? "Checking…" : "Check for node updates"}
            </button>
          </div>

          <p style={{ fontSize: 11, color: "var(--fg-400)", margin: "6px 0 4px", lineHeight: 1.5 }}>
            {isUnidentified ? (
              "Could not match the node's running build to a published signed release."
            ) : isDevBuild ? (
              <>
                Node running an unreleased build <b className="mono">{summary.nodeCommit}</b> — not a
                published signed release. Apply the latest signed release below to move onto a signed
                build.
              </>
            ) : (
              <>
                Node running <b className="mono">{currentTag}</b>
                {showBadge ? " — a newer signed release is available." : " — latest signed release."}
              </>
            )}
          </p>

          {feed.loading && !hasReleases ? (
            <div style={{ fontSize: 11.5, color: "var(--fg-400)", padding: "10px 0" }}>
              Checking the protocore release feed…
            </div>
          ) : !hasReleases ? (
            <div style={{ fontSize: 11.5, color: "var(--fg-400)", padding: "10px 0" }}>
              Release feed unavailable — could not read recent protocore releases.
            </div>
          ) : (
            <div>
              {releases.map((release) => (
                <ReleaseRow
                  key={release.tag}
                  release={release}
                  isCurrent={release.tag === currentTag}
                  isNewer={newerTags.has(release.tag)}
                  onApply={applyRelease}
                />
              ))}
            </div>
          )}

          <p style={{ fontSize: 10.5, color: "var(--fg-400)", margin: "10px 0 0", lineHeight: 1.5 }}>
            "Apply" opens the guarded OS upgrade drawer (preserve=true) with the installer image
            pre-filled. You still review and confirm. Signed = cosign assets present on the release,
            not an on-device verification.
          </p>
        </div>
      ) : null}
    </div>
  );
}
