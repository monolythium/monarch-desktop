import { TESTNET_69420 } from "@monolythium/core-sdk";
import type { ClusterSealKeysSource } from "@monolythium/core-sdk/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";

const TESTNET_GENESIS_URL =
  "https://raw.githubusercontent.com/monolythium/chain-registry/master/chains/genesis/testnet-69420.genesis.toml";

const HEX_RE = /^[0-9a-fA-F]+$/u;

export async function resolveTestnetClusterSealKeysSource(args?: {
  fetch?: typeof fetch;
}): Promise<ClusterSealKeysSource> {
  const fetchImpl = args?.fetch ?? fetch;
  const res = await fetchImpl(TESTNET_GENESIS_URL);
  if (!res.ok) {
    throw new Error(`failed to fetch testnet genesis: HTTP ${res.status}`);
  }
  const genesisToml = await res.text();
  return clusterSealKeysSourceFromGenesisToml(genesisToml, {
    expectedGenesisHash: TESTNET_69420.genesis_hash,
  });
}

export function clusterSealKeysSourceFromGenesisToml(
  genesisToml: string,
  args?: { expectedGenesisHash?: string },
): ClusterSealKeysSource {
  if (args?.expectedGenesisHash !== undefined) {
    const actual = hex(keccak_256(new TextEncoder().encode(genesisToml)));
    if (actual.toLowerCase() !== args.expectedGenesisHash.toLowerCase()) {
      throw new Error(
        `testnet genesis hash mismatch: expected ${args.expectedGenesisHash}, got ${actual}`,
      );
    }
  }

  const cluster = firstClusterBlock(genesisToml);
  const threshold = numberField(cluster.header, "threshold");
  const members = cluster.memberBlocks.map((block, index) => ({
    operatorIndex: index + 1,
    mlKemEk: prefixedHex(stringField(block, "seal_ek_hex"), "seal_ek_hex"),
  }));

  if (members.length === 0) {
    throw new Error("testnet genesis has no cluster seal members");
  }

  return {
    clusterId: numberField(cluster.header, "id"),
    epoch: 0,
    t: threshold,
    n: members.length,
    roster: members,
  };
}

function firstClusterBlock(genesisToml: string): {
  header: string;
  memberBlocks: string[];
} {
  const start = genesisToml.indexOf("[[clusters]]");
  if (start < 0) throw new Error("testnet genesis has no cluster block");
  const rest = genesisToml.slice(start);
  const nextCluster = rest.indexOf("\n[[clusters]]", 1);
  const block = nextCluster >= 0 ? rest.slice(0, nextCluster) : rest;
  const firstMember = block.indexOf("[[clusters.members]]");
  if (firstMember < 0) throw new Error("testnet genesis cluster has no members");

  const header = block.slice(0, firstMember);
  const memberTail = block.slice(firstMember);
  const memberBlocks = memberTail
    .split(/\n(?=\[\[clusters\.members\]\])/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return { header, memberBlocks };
}

function numberField(block: string, field: string): number {
  const raw = stringLikeField(block, field);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${field} in testnet genesis`);
  }
  return value;
}

function stringField(block: string, field: string): string {
  const raw = stringLikeField(block, field);
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  throw new Error(`invalid ${field} in testnet genesis`);
}

function stringLikeField(block: string, field: string): string {
  const line = fieldLine(block, field);
  if (line === null) throw new Error(`missing ${field} in testnet genesis`);
  const raw = line.split("=", 2)[1]?.trim();
  if (!raw) throw new Error(`missing ${field} in testnet genesis`);
  return raw;
}

function fieldLine(block: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = block.match(new RegExp(`^\\s*${escaped}\\s*=\\s*.+$`, "mu"));
  return match?.[0] ?? null;
}

function prefixedHex(value: string, field: string): string {
  const raw = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (raw.length === 0 || raw.length % 2 !== 0 || !HEX_RE.test(raw)) {
    throw new Error(`invalid ${field} in testnet genesis`);
  }
  return `0x${raw}`;
}

function hex(bytes: Uint8Array): string {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
