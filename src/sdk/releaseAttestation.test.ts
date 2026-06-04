import { describe, expect, it } from "vitest";
import type { RuntimeProvenanceResponse } from "@monolythium/core-sdk";
import type { TalosServiceInfo } from "./bridge";
import {
  normalizeReleaseDigest,
  releaseAttestationStatus,
  validateReleaseDigest,
} from "./releaseAttestation";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

function provenance(binarySha256: string | null): RuntimeProvenanceResponse {
  return {
    schemaVersion: 1,
    chainId: 69420,
    genesisHash: `0x${"00".repeat(32)}`,
    latestHeight: 1234,
    runtime: {
      clientName: "protocore",
      version: "0.4.0",
      gitCommit: "feedface",
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
  };
}

function failedService(): TalosServiceInfo {
  return {
    id: "ext-protocore",
    state: "Failed",
    displayState: "failed",
    severity: "err",
    summary: "release digest mismatch",
    healthy: false,
    healthUnknown: false,
    healthMessage: "release verify failed",
    lastEvent: {
      message: "release verify failed",
      state: "Failed",
      timestamp: null,
    },
    events: [],
  };
}

function status(overrides: Partial<Parameters<typeof releaseAttestationStatus>[0]> = {}) {
  return releaseAttestationStatus({
    expectedDigest: digestA,
    service: null,
    provenance: provenance(digestA),
    provenanceLoading: false,
    provenanceError: null,
    provenanceNotExposed: false,
    rpcEndpoint: "http://127.0.0.1:8545",
    ...overrides,
  });
}

describe("release attestation status", () => {
  it("normalizes and validates supported digest forms", () => {
    expect(normalizeReleaseDigest(`sha256:${digestA.toUpperCase()}`)).toBe(digestA);
    expect(validateReleaseDigest(`0x${digestB}`)).toBe(digestB);
    expect(() => validateReleaseDigest("not-a-digest")).toThrow(/64-character SHA-256/);
  });

  it("reports missing expected digests before checking live provenance", () => {
    expect(status({ expectedDigest: "" })).toMatchObject({
      className: "halo halo--warn",
      text: "release digest missing",
    });
  });

  it("keeps Talos release verification failures fatal", () => {
    expect(status({ service: failedService() })).toMatchObject({
      className: "halo halo--err",
      text: "release verify failed",
    });
  });

  it("warns when runtime provenance cannot be read", () => {
    expect(status({ provenance: null, provenanceNotExposed: true })).toMatchObject({
      className: "halo halo--warn",
      text: "runtime provenance unavailable",
    });
    expect(status({ provenance: null, provenanceError: "connection refused" })).toMatchObject({
      className: "halo halo--warn",
      text: "runtime provenance unavailable",
    });
  });

  it("fails closed on runtime digest mismatch", () => {
    expect(status({ provenance: provenance(digestB) })).toMatchObject({
      className: "halo halo--err",
      text: "runtime digest mismatch",
    });
  });

  it("passes only when the stored digest matches live runtime provenance", () => {
    expect(status()).toMatchObject({
      className: "halo halo--ok",
      text: "runtime digest matched",
    });
  });
});
