import type { RuntimeProvenanceResponse } from "@monolythium/core-sdk";
import type { TalosServiceInfo } from "./bridge";

const RELEASE_DIGEST_RE = /^(?:sha256:|0x)?[a-fA-F0-9]{64}$/;

export type ReleaseAttestationStatus = {
  className: string;
  text: string;
  title: string;
  expectedDigest: string;
  liveDigest: string;
};

export type ReleaseAttestationInput = {
  expectedDigest: string;
  service: TalosServiceInfo | null;
  provenance: RuntimeProvenanceResponse | null;
  provenanceLoading: boolean;
  provenanceError: string | null;
  provenanceNotExposed: boolean;
  rpcEndpoint: string;
};

export function normalizeReleaseDigest(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^sha256:/i, "").replace(/^0x/i, "").toLowerCase();
}

export function validateReleaseDigest(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!RELEASE_DIGEST_RE.test(trimmed)) {
    throw new Error("Expected Protocore digest must be a 64-character SHA-256 hex value.");
  }
  return normalizeReleaseDigest(trimmed);
}

export function releaseAttestationStatus({
  expectedDigest,
  service,
  provenance,
  provenanceLoading,
  provenanceError,
  provenanceNotExposed,
  rpcEndpoint,
}: ReleaseAttestationInput): ReleaseAttestationStatus {
  const eventText = `${service?.lastEvent?.message ?? ""} ${service?.summary ?? ""}`.trim();
  if (/release verify|digest|attestat/i.test(eventText) && service?.severity === "err") {
    return {
      className: "halo halo--err",
      text: "release verify failed",
      title: eventText,
      expectedDigest: normalizeReleaseDigest(expectedDigest),
      liveDigest: "",
    };
  }

  const expected = normalizeReleaseDigest(expectedDigest);
  if (!expected) {
    return {
      className: "halo halo--warn",
      text: "release digest missing",
      title: "Store the expected Protocore SHA-256 digest before production operation.",
      expectedDigest: "",
      liveDigest: "",
    };
  }

  if (provenanceLoading && !provenance) {
    return {
      className: "halo halo--info",
      text: "runtime digest checking",
      title: `Reading lyth_runtimeProvenance from ${rpcEndpoint}.`,
      expectedDigest: expected,
      liveDigest: "",
    };
  }

  if (provenanceNotExposed) {
    return {
      className: "halo halo--warn",
      text: "runtime provenance unavailable",
      title: `The connected RPC endpoint does not expose lyth_runtimeProvenance: ${rpcEndpoint}.`,
      expectedDigest: expected,
      liveDigest: "",
    };
  }

  if (provenanceError) {
    return {
      className: "halo halo--warn",
      text: "runtime provenance unavailable",
      title: provenanceError,
      expectedDigest: expected,
      liveDigest: "",
    };
  }

  if (!provenance) {
    return {
      className: "halo halo--warn",
      text: "runtime provenance unavailable",
      title: `No runtime provenance response from ${rpcEndpoint}.`,
      expectedDigest: expected,
      liveDigest: "",
    };
  }

  const liveDigest = normalizeReleaseDigest(provenance.runtime.binarySha256 ?? "");
  const runtime = runtimeLabel(provenance);
  if (!liveDigest) {
    return {
      className: "halo halo--warn",
      text: "runtime digest unavailable",
      title: `lyth_runtimeProvenance did not include runtime.binarySha256. ${runtime}`,
      expectedDigest: expected,
      liveDigest: "",
    };
  }

  if (expected !== liveDigest) {
    return {
      className: "halo halo--err",
      text: "runtime digest mismatch",
      title: `expected ${shortDigest(expected)}; live ${shortDigest(liveDigest)}. ${runtime}`,
      expectedDigest: expected,
      liveDigest,
    };
  }

  return {
    className: "halo halo--ok",
    text: "runtime digest matched",
    title: `live ${shortDigest(liveDigest)}. ${runtime}`,
    expectedDigest: expected,
    liveDigest,
  };
}

function shortDigest(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function runtimeLabel(provenance: RuntimeProvenanceResponse): string {
  const runtime = provenance.runtime;
  const git = runtime.gitDirty ? `${runtime.gitCommit}+dirty` : runtime.gitCommit;
  return [
    runtime.clientName,
    runtime.version,
    git,
    `chain ${provenance.chainId}`,
    `height ${provenance.latestHeight}`,
  ]
    .filter(Boolean)
    .join(" ");
}
