import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ChatChannel, ChatInitResult, ChatMessage } from "./chat";
import type {
  ProtocoreReadiness,
  TalosCertificateInfo,
  TalosConfigInfo,
  TalosServiceInfo,
  TalosStatus,
} from "./bridge";
import { withOperationReceiptAuditHash, type OperationReceipt } from "../ops/receipts";
import type { ReleaseAttestationStatus } from "./releaseAttestation";
import type { ReleaseChatMembershipEvidence } from "./releaseReadiness";
import {
  DESKTOP_E2E_DKG_RESHARE_ATTESTATION_SCHEMA,
  DESKTOP_E2E_EVIDENCE_SCHEMA,
  type DesktopReleaseE2eEvidence,
  verifyDesktopReleaseE2eEvidence,
} from "./releaseE2eEvidence";
import requiredE2eRoutes from "../nav/e2eRequiredRoutes.json";

const rpcEndpoint = "http://127.0.0.1:8545";
const releaseDigest = "a".repeat(64);
const screenshotWidth = 1280;
const screenshotHeight = 800;
const screenshotLength = 2048;

function hex(ch: string, bytes: number): string {
  return `0x${ch.repeat(bytes * 2)}`;
}

function blsKey(byte: number): string {
  return byte.toString(16).padStart(2, "0").repeat(1952);
}

function certificate(overrides: Partial<TalosCertificateInfo> = {}): TalosCertificateInfo {
  return {
    role: "client",
    subject: "CN=monarch-operator",
    issuer: "CN=talos-ca",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: "2027-01-01T00:00:00Z",
    sha256Fingerprint: "aa:bb:cc",
    expired: false,
    notYetValid: false,
    expiresInDays: 365,
    dnsNames: [],
    ipAddresses: ["127.0.0.1"],
    ...overrides,
  };
}

function talosConfig(overrides: Partial<TalosConfigInfo> = {}): TalosConfigInfo {
  return {
    path: "/tmp/talosconfig",
    context: "monarch",
    endpoint: "https://127.0.0.1:50000",
    serverName: "127.0.0.1",
    caFingerprint: "ca:01",
    trustedCaFingerprint: "ca:01",
    caPinStatus: "matched",
    endpoints: ["https://127.0.0.1:50000"],
    nodes: ["https://127.0.0.1:50000"],
    certificates: [certificate()],
    warnings: [],
    ...overrides,
  };
}

function talosStatus(overrides: Partial<TalosStatus> = {}): TalosStatus {
  return {
    configured: true,
    reachable: true,
    endpoint: "https://127.0.0.1:50000",
    nodeAddress: "127.0.0.1",
    configPath: "/tmp/talosconfig",
    clientMode: "native",
    version: "v1.13.0",
    lastError: null,
    ...overrides,
  };
}

function service(overrides: Partial<TalosServiceInfo> = {}): TalosServiceInfo {
  return {
    id: "ext-protocore",
    state: "Running",
    displayState: "running",
    severity: "ok",
    summary: "ext-protocore is running",
    healthy: true,
    healthUnknown: false,
    healthMessage: null,
    lastEvent: null,
    events: [],
    ...overrides,
  };
}

function protocore(overrides: Partial<ProtocoreReadiness> = {}): ProtocoreReadiness {
  return {
    service: service(),
    rpcEndpoint,
    displayState: "serving-rpc",
    severity: "ok",
    summary: "Protocore RPC is serving chain_id 69420 at block 42",
    chainId: 69420,
    blockNumber: 42,
    clientVersion: "protocore/0.4.0",
    listening: true,
    syncing: false,
    checks: [],
    ...overrides,
  };
}

function attestation(overrides: Partial<ReleaseAttestationStatus> = {}): ReleaseAttestationStatus {
  return {
    className: "halo halo--ok",
    text: "runtime digest matched",
    title: "live abcdef",
    expectedDigest: releaseDigest,
    liveDigest: releaseDigest,
    ...overrides,
  };
}

function receipt(overrides: Partial<OperationReceipt> = {}): OperationReceipt {
  return withOperationReceiptAuditHash({
    id: "receipt-1",
    createdAt: "2026-01-01T00:00:00Z",
    kind: "operator-restart",
    title: "Graceful restart",
    status: "ok",
    message: "submitted",
    transport: "talos",
    service: "ext-protocore",
    action: "restart",
    endpoint: "https://127.0.0.1:50000",
    nodeAddress: "127.0.0.1",
    ...overrides,
  });
}

function channel(overrides: Partial<ChatChannel> = {}): ChatChannel {
  return {
    channel_id: "cluster-1",
    name: "Cluster 1",
    sub: "cluster",
    kind: "cluster",
    cluster_id: 1,
    subscribed: true,
    last_read_ts: 0,
    unread_count: 0,
    ...overrides,
  };
}

function chatInit(overrides: Partial<ChatInitResult> = {}): ChatInitResult {
  return {
    address_hex: "0x1111111111111111111111111111111111111111",
    public_key_hex: "aa".repeat(32),
    rpc_endpoint: rpcEndpoint,
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    msg_id: hex("a", 32),
    channel_id: "cluster-1",
    cluster_id: 1,
    sender_address: "0x1111111111111111111111111111111111111111",
    sender_pubkey_hex: hex("c", 32),
    body: "hello",
    timestamp_ms: 1_000,
    nonce_hex: hex("d", 16),
    signature_hex: hex("b", 64),
    verified: true,
    from_me: true,
    ...overrides,
  };
}

function membership(
  overrides: Partial<ReleaseChatMembershipEvidence> = {},
): ReleaseChatMembershipEvidence {
  return {
    source: "lyth_clusterStatus+lyth_operatorInfo",
    clusterId: 1,
    checkedAt: "2026-06-01T00:00:00Z",
    membersChecked: 10,
    proofs: [
      {
        source: "lyth_clusterStatus+lyth_operatorInfo",
        clusterId: 1,
        senderAddress: "0x1111111111111111111111111111111111111111",
        operatorId: hex("c", 32),
        chainAddress: "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at",
        chainAddressHex: "0x1111111111111111111111111111111111111111",
      },
      {
        source: "lyth_clusterStatus+lyth_operatorInfo",
        clusterId: 1,
        senderAddress: "0x2222222222222222222222222222222222222222",
        operatorId: hex("d", 32),
        chainAddress: "0x2222222222222222222222222222222222222222",
        chainAddressHex: "0x2222222222222222222222222222222222222222",
      },
    ],
    ...overrides,
  };
}

function dkgReshareAttestation(): DesktopReleaseE2eEvidence["dkg_reshare_attestation"] {
  return {
    schema_version: DESKTOP_E2E_DKG_RESHARE_ATTESTATION_SCHEMA,
    created_at: "2026-06-01T00:00:00Z",
    intent_id: "7",
    consensus_public_keys_hex: "0x" + [1, 2, 3, 4, 5].map(blsKey).join(""),
    threshold_sig_hex: "0x" + "c".repeat(5 * 3309 * 2),
    signer_count: 5,
  };
}

function routeSlug(route: string): string {
  const slug = route === "/" ? "root" : route.slice(1);
  return slug.replace(/[^a-z0-9._-]+/giu, "_") || "route";
}

function screenshotBytes(route: string): Uint8Array {
  const bytes = new Uint8Array(screenshotLength);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  writeU32(bytes, 16, screenshotWidth);
  writeU32(bytes, 20, screenshotHeight);
  bytes.set([8, 2, 0, 0, 0], 24);
  for (let i = 33; i < bytes.length; i += 1) {
    bytes[i] = (route.charCodeAt(i % route.length) + i) & 0xff;
  }
  return bytes;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function routeScreenshot(route: string): DesktopReleaseE2eEvidence["source"]["route_screenshots"][number] {
  const bytes = screenshotBytes(route);
  return {
    route,
    path: `${routeSlug(route)}.png`,
    sha256: bytesToHex(sha256(bytes)),
    bytes: bytes.length,
    width: screenshotWidth,
    height: screenshotHeight,
  };
}

function routeScreenshots(): DesktopReleaseE2eEvidence["source"]["route_screenshots"] {
  return requiredE2eRoutes.map(routeScreenshot);
}

function writeRouteScreenshotFiles(dir: string, value: DesktopReleaseE2eEvidence): void {
  for (const screenshot of value.source.route_screenshots) {
    writeBinaryFile(join(dir, screenshot.path), screenshotBytes(screenshot.route));
  }
}

function writeBinaryFile(file: string, bytes: Uint8Array): void {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "require('fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'))",
      file,
      btoa(binaryString(bytes)),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `failed to write binary fixture ${file}`);
  }
}

function binaryString(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function evidence(overrides: Partial<DesktopReleaseE2eEvidence> = {}): DesktopReleaseE2eEvidence {
  return {
    schema_version: DESKTOP_E2E_EVIDENCE_SCHEMA,
    source: {
      kind: "tauri-gui-e2e",
      runner: "webdriver",
      generated_at: "2026-06-01T00:00:00Z",
      app_version: "0.0.1",
      commit: "abcdef123456",
      windows_observed: 2,
      routes_visited: requiredE2eRoutes,
      route_screenshots: routeScreenshots(),
      commands_observed: [
        "talos_config_info",
        "talos_protocore_readiness",
        "talos_service_action:restart",
        "chat_initialize",
        "chat_subscribe_channel",
        "chat_send_message",
      ],
    },
    os_smoke: {
      status: "ok",
      raw_image: "monarch-os-talos-v1.13.0-amd64.raw",
      talos_api_probe: "talosctl_ok",
      require_talos_api_probe: "true",
      machine_config_applied: "true",
      extension_service_name: "ext-protocore",
      extension_service_check: "ok",
      protocore_rpc_probe: "ok",
      substrate_runtime_proof: "ok",
      release_metadata: "monarch-os-talos-v1.13.0-amd64.release.json",
      expected_protocore_digest: releaseDigest,
    },
    dkg_reshare_attestation: dkgReshareAttestation(),
    desktop_readiness: {
      expectedChainId: 69420,
      expectedRpcEndpoint: rpcEndpoint,
      talosStatus: talosStatus(),
      talosConfig: talosConfig(),
      protocore: protocore(),
      releaseAttestation: attestation(),
      operationReceipts: [receipt()],
      requiredOperationActions: ["restart"],
      chat: {
        init: chatInit(),
        channels: [channel()],
        activeChannelId: "cluster-1",
        messages: [
          message({ msg_id: hex("a", 32), from_me: true }),
          message({
            msg_id: hex("b", 32),
            from_me: false,
            sender_address: "0x2222222222222222222222222222222222222222",
          }),
        ],
        bootstrapPeers: ["/ip4/127.0.0.1/tcp/41001/p2p/peer-a"],
        membership: membership(),
      },
    },
    ...overrides,
  };
}

describe("Desktop release e2e evidence", () => {
  it("passes only with QEMU smoke proof and Tauri GUI readiness evidence", () => {
    const report = verifyDesktopReleaseE2eEvidence(evidence());

    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.readiness?.ok).toBe(true);
  });

  it("rejects browser/manual evidence that did not run through the Tauri GUI harness", () => {
    const report = verifyDesktopReleaseE2eEvidence(evidence({
      source: {
        ...evidence().source,
        kind: "tauri-gui-e2e",
        windows_observed: 1,
        routes_visited: ["/home", "/operations"],
        commands_observed: ["talos_config_info"],
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContain("Evidence must observe two Tauri windows for the chat exchange.");
    expect(report.blockers).toContain("Evidence did not visit required route: /operator.");
    expect(report.blockers).toContain("Evidence did not observe required Tauri command: chat_send_message.");
  });

  it("requires screenshot evidence for every required route", () => {
    const report = verifyDesktopReleaseE2eEvidence(evidence({
      source: {
        ...evidence().source,
        route_screenshots: routeScreenshots().filter((item) => item.route !== "/operator"),
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContain("Evidence did not capture required route screenshot: /operator.");
  });

  it("rejects incomplete Monarch OS smoke evidence", () => {
    const report = verifyDesktopReleaseE2eEvidence(evidence({
      os_smoke: {
        ...evidence().os_smoke,
        talos_api_probe: "tcp_only",
        protocore_rpc_probe: "failed",
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContain(
      "QEMU smoke did not prove Talos API through talosctl: tcp_only.",
    );
    expect(report.blockers).toContain("QEMU smoke did not verify Protocore RPC.");
  });

  it("binds Desktop release attestation to the OS release metadata digest", () => {
    const report = verifyDesktopReleaseE2eEvidence(evidence({
      desktop_readiness: {
        ...evidence().desktop_readiness,
        releaseAttestation: attestation({
          expectedDigest: "b".repeat(64),
          liveDigest: releaseDigest,
        }),
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContain(
      "Desktop release-attestation: Expected digest does not match the Monarch OS release metadata digest.",
    );
  });

  it("requires a valid DKG re-share attestation artifact", () => {
    const withoutDkg: Record<string, unknown> = { ...evidence() };
    delete withoutDkg.dkg_reshare_attestation;
    const missing = verifyDesktopReleaseE2eEvidence(withoutDkg);
    expect(missing.ok).toBe(false);
    expect(missing.blockers).toContain("DKG re-share attestation evidence is missing.");

    const duplicate = verifyDesktopReleaseE2eEvidence(evidence({
      dkg_reshare_attestation: {
        ...dkgReshareAttestation(),
        consensus_public_keys_hex: "0x" + [1, 1, 2, 3, 4].map(blsKey).join(""),
      },
    }));
    expect(duplicate.ok).toBe(false);
    expect(duplicate.blockers).toContain(
      "DKG re-share attestation signer pubkeys must be unique.",
    );
  });

  it("surfaces Desktop readiness blockers inside the e2e report", () => {
    const valid = evidence();
    const chat = valid.desktop_readiness.chat;
    if (!chat) throw new Error("fixture chat evidence is required");
    const report = verifyDesktopReleaseE2eEvidence(evidence({
      desktop_readiness: {
        ...valid.desktop_readiness,
        chat: {
          ...chat,
          messages: [message({ msg_id: hex("a", 32), from_me: true })],
        },
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContain(
      "Desktop chat-exchange: Chat has not proved a two-party signed exchange.",
    );
  });

  it("rejects e2e evidence with Talos certificates inside the rotation window", () => {
    const valid = evidence();
    const report = verifyDesktopReleaseE2eEvidence(evidence({
      desktop_readiness: {
        ...valid.desktop_readiness,
        talosConfig: talosConfig({
          certificates: [certificate({ expiresInDays: 2 })],
        }),
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContain(
      "Desktop talos-identity: Talos config has 1 certificate(s) inside the 14-day rotation window.",
    );
  });

  it("rejects chat evidence where own and peer messages use the same sender address", () => {
    const valid = evidence();
    const chat = valid.desktop_readiness.chat;
    if (!chat) throw new Error("fixture chat evidence is required");
    const report = verifyDesktopReleaseE2eEvidence(evidence({
      desktop_readiness: {
        ...valid.desktop_readiness,
        chat: {
          ...chat,
          messages: [
            message({ msg_id: hex("a", 32), from_me: true }),
            message({ msg_id: hex("b", 32), from_me: false }),
          ],
        },
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContain(
      "Desktop chat-exchange: Chat has not proved two distinct signed operator identities.",
    );
  });

  it("rejects chat evidence without sender membership proof", () => {
    const valid = evidence();
    const chat = valid.desktop_readiness.chat;
    if (!chat) throw new Error("fixture chat evidence is required");
    const report = verifyDesktopReleaseE2eEvidence(evidence({
      desktop_readiness: {
        ...valid.desktop_readiness,
        chat: {
          ...chat,
          membership: null,
        },
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.blockers).toContain(
      "Desktop chat-exchange: Chat sender membership has not been proven against the cluster registry.",
    );
  });

  it("standalone verifier accepts route screenshot artifacts", () => {
    const valid = evidence();
    const dir = mkdtempSync(join(tmpdir(), "monarch-e2e-evidence-"));
    try {
      const file = join(dir, "evidence.json");
      writeRouteScreenshotFiles(dir, valid);
      writeFileSync(file, JSON.stringify(valid), "utf8");
      const result = spawnSync(process.execPath, ["scripts/verify-release-e2e-evidence.mjs", file], {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("\"ok\":true");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("standalone verifier rejects chat messages missing signed-envelope fields", () => {
    const bad = evidence();
    const chat = bad.desktop_readiness.chat;
    if (!chat) throw new Error("fixture chat evidence is required");
    const peer = chat.messages[1] as unknown as Record<string, unknown>;
    delete peer.sender_pubkey_hex;
    delete peer.nonce_hex;

    const dir = mkdtempSync(join(tmpdir(), "monarch-e2e-evidence-"));
    try {
      const file = join(dir, "evidence.json");
      writeRouteScreenshotFiles(dir, bad);
      writeFileSync(file, JSON.stringify(bad), "utf8");
      const result = spawnSync(process.execPath, ["scripts/verify-release-e2e-evidence.mjs", file], {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Desktop chat-exchange: Chat history contains stale, unsigned, or unverified messages.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("standalone verifier rejects chat evidence without a peer-perspective message", () => {
    const bad = evidence();
    const chat = bad.desktop_readiness.chat;
    if (!chat) throw new Error("fixture chat evidence is required");
    chat.messages = chat.messages.map((item) => ({ ...item, from_me: true }));

    const dir = mkdtempSync(join(tmpdir(), "monarch-e2e-evidence-"));
    try {
      const file = join(dir, "evidence.json");
      writeRouteScreenshotFiles(dir, bad);
      writeFileSync(file, JSON.stringify(bad), "utf8");
      const result = spawnSync(process.execPath, ["scripts/verify-release-e2e-evidence.mjs", file], {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Desktop chat-exchange: Chat has not proved both local and peer signed messages.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("standalone verifier rejects missing DKG re-share attestation evidence", () => {
    const bad: Record<string, unknown> = { ...evidence() };
    delete bad.dkg_reshare_attestation;

    const dir = mkdtempSync(join(tmpdir(), "monarch-e2e-evidence-"));
    try {
      const file = join(dir, "evidence.json");
      writeRouteScreenshotFiles(dir, bad as DesktopReleaseE2eEvidence);
      writeFileSync(file, JSON.stringify(bad), "utf8");
      const result = spawnSync(process.execPath, ["scripts/verify-release-e2e-evidence.mjs", file], {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("DKG re-share attestation evidence is missing.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
