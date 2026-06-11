// formCluster consent-digest parity fixtures.
//
// The SAME fixture digests are pinned in three places:
//   1. mono-core `cluster_form.rs::form_cluster_message` (V1) /
//      `form_cluster_message_v2` (V2) — the chain-side verifier;
//   2. Rust `src-tauri/src/chat.rs::build_form_cluster_consent_digest`
//      (test `consent_digest_matches_mono_core_parity_fixture`) — what
//      `chat_sign_form_cluster_consent` signs;
//   3. here — the TS SDK mirror (`formClusterConsentMessageHex`) plus an
//      independent @noble/hashes blake3 implementation of the byte layout.
//
// If any implementation drifts, a ceremony consent signature would stop
// verifying at `formCluster` execution — these fixtures catch that at
// test time instead.

import { describe, expect, it } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
import { formClusterMessageV2Hex } from "@monolythium/core-sdk";
import {
  FORM_CLUSTER_ACTIVE_COUNT,
  FORM_CLUSTER_STANDBY_COUNT,
  FORM_CLUSTER_THRESHOLD,
  formClusterConsentMessageHex,
} from "./clusterFormOps";
import { NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES } from "./operatorKeys";

const V1_DOMAIN = "PROTOCORE_NODE_REGISTRY_CLUSTER_FORM_V1\0";
const V2_DOMAIN = "PROTOCORE_NODE_REGISTRY_CLUSTER_FORM_V2\0";

/** Deterministic roster: active i = 1952×(0x10+i); standby j = 1952×(0x20+j). */
function fixtureRoster(): { active: Uint8Array[]; standby: Uint8Array[] } {
  const active = Array.from({ length: 7 }, (_, i) =>
    new Uint8Array(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES).fill(0x10 + i),
  );
  const standby = Array.from({ length: 3 }, (_, j) =>
    new Uint8Array(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES).fill(0x20 + j),
  );
  return { active, standby };
}

/**
 * 30-byte V2 charter wire fixture (mono-core `CLUSTER_CHARTER_LEN`):
 * 10×u16 BE member shares of 1,000 bps (sum 10,000) ‖ u16 BE delegator
 * 5,000 bps ‖ u64 BE expires_ms = 1,750,000,000,000.
 */
const FIXTURE_CHARTER_HEX =
  "0x03e803e803e803e803e803e803e803e803e803e81388000001977420dc00";

const EXPECTED_V1_DIGEST =
  "0xf73436fbf014fea20304103fe1d48d2f0120f08f9ac64ed76fb27381f7752507";
const EXPECTED_V2_DIGEST =
  "0xbfcfc213e135d53b9ff4ccfea08e2f5bc5ec7e8f2e1e4cff8ea0838d1f868029";

function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function u16BE(value: number): Uint8Array {
  return Uint8Array.from([(value >>> 8) & 0xff, value & 0xff]);
}

function u32BE(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Independent mirror of mono-core `form_cluster_message[_v2]`. */
function referenceDigest(domain: string, charter: Uint8Array | null): string {
  const { active, standby } = fixtureRoster();
  const activeBytes = concat(active);
  const standbyBytes = concat(standby);
  const parts = [
    new TextEncoder().encode(domain),
    u16BE(FORM_CLUSTER_ACTIVE_COUNT),
    u16BE(FORM_CLUSTER_STANDBY_COUNT),
    u16BE(FORM_CLUSTER_THRESHOLD),
    u32BE(activeBytes.length),
    activeBytes,
    u32BE(standbyBytes.length),
    standbyBytes,
  ];
  if (charter) {
    parts.push(u32BE(charter.length), charter);
  }
  return bytesToHex(blake3(concat(parts)));
}

describe("formCluster consent digest parity (Rust chat.rs ↔ TS SDK ↔ mono-core)", () => {
  it("V1: the SDK digest matches the pinned mono-core fixture", () => {
    const { active, standby } = fixtureRoster();
    const digest = formClusterConsentMessageHex({
      activePubkeysHex: active.map(bytesToHex).join("\n"),
      standbyPubkeysHex: standby.map(bytesToHex).join("\n"),
    });
    expect(digest).toBe(EXPECTED_V1_DIGEST);
    // Independent byte-layout mirror agrees.
    expect(referenceDigest(V1_DOMAIN, null)).toBe(EXPECTED_V1_DIGEST);
  });

  it("V2: the charter-committing digest matches the pinned fixture", () => {
    const charter = hexToBytes(FIXTURE_CHARTER_HEX);
    expect(charter).toHaveLength(30);
    expect(referenceDigest(V2_DOMAIN, charter)).toBe(EXPECTED_V2_DIGEST);
    // Domain separation: V1 consents can never replay as V2.
    expect(EXPECTED_V1_DIGEST).not.toBe(EXPECTED_V2_DIGEST);
    expect(referenceDigest(V1_DOMAIN, charter)).not.toBe(EXPECTED_V2_DIGEST);
  });

  it("V2: the live wiring (core-sdk + desktop mirror) matches the pinned fixture", () => {
    const { active, standby } = fixtureRoster();
    // The core-sdk encoder the ceremony reducer/exporter rides on.
    expect(
      formClusterMessageV2Hex(concat(active), concat(standby), hexToBytes(FIXTURE_CHARTER_HEX)),
    ).toBe(EXPECTED_V2_DIGEST);
    // The desktop mirror used by the ops drawer summary/executor — the
    // same digest `chat_sign_form_cluster_consent` signs Rust-side for
    // this exact fixture (chat.rs parity test).
    expect(
      formClusterConsentMessageHex({
        activePubkeysHex: active.map(bytesToHex).join("\n"),
        standbyPubkeysHex: standby.map(bytesToHex).join("\n"),
        charterHex: FIXTURE_CHARTER_HEX,
      }),
    ).toBe(EXPECTED_V2_DIGEST);
  });

  it("pins the topology constants the digest commits to", () => {
    expect(FORM_CLUSTER_ACTIVE_COUNT).toBe(7);
    expect(FORM_CLUSTER_STANDBY_COUNT).toBe(3);
    expect(FORM_CLUSTER_THRESHOLD).toBe(7);
    expect(NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES).toBe(1952);
  });
});
