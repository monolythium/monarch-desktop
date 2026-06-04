import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const script = "scripts/check-release-e2e-inputs.mjs";
const validPeer = "/ip4/127.0.0.1/tcp/41001/p2p/12D3KooWReleasePeer";
const validDigest = "a".repeat(64);

function mnemonic(prefix: string): string {
  return Array.from({ length: 24 }, (_, index) => `${prefix}${index + 1}`).join(" ");
}

function key(byte: number): string {
  return byte.toString(16).padStart(2, "0").repeat(1952);
}

function dkgAttestation(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: "monarch-dkg-reshare-attestation/v1",
    intent_id: "7",
    consensus_public_keys_hex: "0x" + [1, 2, 3, 4, 5].map(key).join(""),
    threshold_sig_hex: "0x" + "cc".repeat(5 * 3309),
    signer_count: 5,
    ...overrides,
  });
}

function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MONARCH_E2E_OPERATOR_MNEMONIC: mnemonic("operator"),
    MONARCH_E2E_PEER_OPERATOR_MNEMONIC: mnemonic("peer"),
    MONARCH_E2E_CLUSTER_ID: "42",
    MONARCH_E2E_CHAT_BOOTSTRAP_PEERS: validPeer,
    MONARCH_E2E_EXPECTED_DIGEST: validDigest,
    MONARCH_E2E_DKG_RESHARE_ATTESTATION: dkgAttestation(),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function run(overrides: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: validEnv(overrides),
    encoding: "utf8",
  });
}

describe("release e2e input validator", () => {
  it("accepts distinct operator inputs, cluster/chat inputs, digest, and DKG attestation", () => {
    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("\"release_e2e_inputs\":\"valid\"");
    expect(result.stderr).toBe("");
  });

  it("accepts legacy DKG re-share public-key field names", () => {
    const result = run({
      MONARCH_E2E_DKG_RESHARE_ATTESTATION: dkgAttestation({
        consensus_public_keys_hex: undefined,
        bls_public_keys_hex: "0x" + [1, 2, 3, 4, 5].map(key).join(""),
      }),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("\"release_e2e_inputs\":\"valid\"");
    expect(result.stderr).toBe("");
  });

  it("allows chat peers to be discovered from live operator metadata", () => {
    const result = run({
      MONARCH_E2E_CHAT_BOOTSTRAP_PEERS: undefined,
      MONARCH_E2E_ALLOW_DISCOVERED_CHAT_PEERS: "true",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("\"release_e2e_inputs\":\"valid\"");
    expect(result.stderr).toBe("");
  });

  it("accepts file-backed mnemonics, chat peers, and DKG attestation", () => {
    const dir = mkdtempSync(join(tmpdir(), "monarch-e2e-inputs-"));
    try {
      const operatorPath = join(dir, "operator.mnemonic");
      const peerPath = join(dir, "peer.mnemonic");
      const peersPath = join(dir, "chat-peers.txt");
      const dkgPath = join(dir, "dkg.json");
      writeFileSync(operatorPath, mnemonic("operator"), "utf8");
      writeFileSync(peerPath, mnemonic("peer"), "utf8");
      writeFileSync(peersPath, `${validPeer}\n`, "utf8");
      writeFileSync(dkgPath, dkgAttestation(), "utf8");

      const result = run({
        MONARCH_E2E_OPERATOR_MNEMONIC: undefined,
        MONARCH_E2E_PEER_OPERATOR_MNEMONIC: undefined,
        MONARCH_E2E_CHAT_BOOTSTRAP_PEERS: undefined,
        MONARCH_E2E_DKG_RESHARE_ATTESTATION: undefined,
        MONARCH_E2E_OPERATOR_MNEMONIC_FILE: operatorPath,
        MONARCH_E2E_PEER_OPERATOR_MNEMONIC_FILE: peerPath,
        MONARCH_E2E_CHAT_BOOTSTRAP_PEERS_FILE: peersPath,
        MONARCH_E2E_DKG_RESHARE_ATTESTATION_FILE: dkgPath,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("\"release_e2e_inputs\":\"valid\"");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing peer mnemonic", () => {
    const result = run({ MONARCH_E2E_PEER_OPERATOR_MNEMONIC: undefined });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MONARCH_E2E_PEER_OPERATOR_MNEMONIC");
  });

  it("rejects reused operator and peer mnemonics", () => {
    const sameMnemonic = mnemonic("same");
    const result = run({
      MONARCH_E2E_OPERATOR_MNEMONIC: sameMnemonic,
      MONARCH_E2E_PEER_OPERATOR_MNEMONIC: sameMnemonic,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be distinct");
  });

  it("rejects malformed cluster, bootstrap peer, or digest input", () => {
    const result = run({
      MONARCH_E2E_CLUSTER_ID: "cluster-42",
      MONARCH_E2E_CHAT_BOOTSTRAP_PEERS: "/ip4/127.0.0.1/tcp/41001",
      MONARCH_E2E_EXPECTED_DIGEST: "not-a-digest",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MONARCH_E2E_CLUSTER_ID");
    expect(result.stderr).toContain("invalid chat bootstrap peer");
    expect(result.stderr).toContain("MONARCH_E2E_EXPECTED_DIGEST");
  });

  it("rejects missing or malformed DKG re-share attestation input", () => {
    const missing = run({ MONARCH_E2E_DKG_RESHARE_ATTESTATION: undefined });

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("MONARCH_E2E_DKG_RESHARE_ATTESTATION");

    const malformed = run({
      MONARCH_E2E_DKG_RESHARE_ATTESTATION: dkgAttestation({
        consensus_public_keys_hex: "0x" + [1, 1, 2, 3, 4].map(key).join(""),
        signer_count: 5,
      }),
    });

    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("duplicate signer pubkeys");
  });
});
