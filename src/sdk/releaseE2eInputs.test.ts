import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const script = "scripts/check-release-e2e-inputs.mjs";
const validPeer = "/ip4/127.0.0.1/tcp/41001/p2p/12D3KooWReleasePeer";
const validDigest = "a".repeat(64);
const spawnTestTimeoutMs = 30_000;

function mnemonic(prefix: string): string {
  return Array.from({ length: 24 }, (_, index) => `${prefix}${index + 1}`).join(" ");
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
  it("accepts distinct operator inputs, cluster/chat inputs, and digest", () => {
    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("\"release_e2e_inputs\":\"valid\"");
    expect(result.stderr).toBe("");
  }, spawnTestTimeoutMs);

  it("allows chat peers to be discovered from live operator metadata", () => {
    const result = run({
      MONARCH_E2E_CHAT_BOOTSTRAP_PEERS: undefined,
      MONARCH_E2E_ALLOW_DISCOVERED_CHAT_PEERS: "true",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("\"release_e2e_inputs\":\"valid\"");
    expect(result.stderr).toBe("");
  }, spawnTestTimeoutMs);

  it("accepts file-backed mnemonics and chat peers", () => {
    const dir = mkdtempSync(join(tmpdir(), "monarch-e2e-inputs-"));
    try {
      const operatorPath = join(dir, "operator.mnemonic");
      const peerPath = join(dir, "peer.mnemonic");
      const peersPath = join(dir, "chat-peers.txt");
      writeFileSync(operatorPath, mnemonic("operator"), "utf8");
      writeFileSync(peerPath, mnemonic("peer"), "utf8");
      writeFileSync(peersPath, `${validPeer}\n`, "utf8");

      const result = run({
        MONARCH_E2E_OPERATOR_MNEMONIC: undefined,
        MONARCH_E2E_PEER_OPERATOR_MNEMONIC: undefined,
        MONARCH_E2E_CHAT_BOOTSTRAP_PEERS: undefined,
        MONARCH_E2E_OPERATOR_MNEMONIC_FILE: operatorPath,
        MONARCH_E2E_PEER_OPERATOR_MNEMONIC_FILE: peerPath,
        MONARCH_E2E_CHAT_BOOTSTRAP_PEERS_FILE: peersPath,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("\"release_e2e_inputs\":\"valid\"");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, spawnTestTimeoutMs);

  it("rejects missing peer mnemonic", () => {
    const result = run({ MONARCH_E2E_PEER_OPERATOR_MNEMONIC: undefined });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MONARCH_E2E_PEER_OPERATOR_MNEMONIC");
  }, spawnTestTimeoutMs);

  it("rejects reused operator and peer mnemonics", () => {
    const sameMnemonic = mnemonic("same");
    const result = run({
      MONARCH_E2E_OPERATOR_MNEMONIC: sameMnemonic,
      MONARCH_E2E_PEER_OPERATOR_MNEMONIC: sameMnemonic,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be distinct");
  }, spawnTestTimeoutMs);

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
  }, spawnTestTimeoutMs);
});
