#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "monarch-desktop-e2e-evidence/v1";
const REQUIRED_ROUTES = readRequiredRoutes();
const REQUIRED_COMMANDS = [
  "talos_config_info",
  "talos_protocore_readiness",
  "talos_service_action:restart",
  "chat_initialize",
  "chat_subscribe_channel",
  "chat_send_message",
];
const TALOSCTL_PROBES = new Set(["talosctl_ok", "talosctl_secure_ok"]);
const MIN_ROUTE_SCREENSHOT_BYTES = 1024;
const MIN_ROUTE_SCREENSHOT_WIDTH = 320;
const MIN_ROUTE_SCREENSHOT_HEIGHT = 240;
const OPERATION_RECEIPT_AUDIT_SCHEMA = "monarch-desktop-operation-receipt/v1";
const HASH32_RE = /^[0-9a-f]{64}$/u;
const TALOS_CERT_MIN_VALIDITY_DAYS = 14;

const file = process.argv.slice(2).find((arg) => arg !== "--") ?? process.env.MONARCH_DESKTOP_E2E_EVIDENCE;
if (!file) {
  fail(["usage: verify-release-e2e-evidence.mjs <evidence.json>"]);
}
const evidencePath = path.resolve(file);

let evidence;
try {
  evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
} catch (err) {
  fail([`failed to read evidence JSON: ${errorMessage(err)}`]);
}

const blockers = verify(evidence);
if (blockers.length > 0) {
  fail(blockers);
}

const resolved = path.relative(process.cwd(), path.resolve(file));
console.log(JSON.stringify({ ok: true, evidence: resolved || file }));

function readRequiredRoutes() {
  const manifest = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "src", "nav", "e2eRequiredRoutes.json");
  const routes = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (!Array.isArray(routes) || routes.some((route) => typeof route !== "string" || !route.startsWith("/"))) {
    throw new Error(`required route manifest is invalid: ${manifest}`);
  }
  return routes;
}

function verify(root) {
  const out = [];
  if (!isRecord(root)) return ["Evidence root must be an object."];

  if (stringValue(root.schema_version) !== SCHEMA) {
    out.push(`Unsupported evidence schema: ${stringValue(root.schema_version) || "missing"}.`);
  }

  if (!isRecord(root.source)) {
    out.push("Evidence source is missing.");
  } else {
    checkSource(root.source, out, path.dirname(evidencePath));
  }

  if (!isRecord(root.os_smoke)) {
    out.push("OS QEMU smoke evidence is missing.");
  } else {
    checkOsSmoke(root.os_smoke, out);
  }

  if (!isRecord(root.desktop_readiness)) {
    out.push("Desktop readiness evidence is missing.");
  } else {
    checkDesktopReadiness(root.desktop_readiness, out);
  }
  if (isRecord(root.os_smoke) && isRecord(root.desktop_readiness)) {
    checkReleaseDigestBinding(root.os_smoke, root.desktop_readiness, out);
  }

  return out;
}

function checkSource(source, out, evidenceDir) {
  if (source.kind !== "tauri-gui-e2e") {
    out.push("Evidence must be collected by the Tauri GUI e2e harness.");
  }
  for (const key of ["runner", "app_version", "commit"]) {
    if (!stringValue(source[key])) out.push(`Evidence source.${key} is required.`);
  }
  const generatedAt = stringValue(source.generated_at);
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    out.push("Evidence source.generated_at must be an ISO timestamp.");
  }
  if (numberValue(source.windows_observed) < 2) {
    out.push("Evidence must observe two Tauri windows for the chat exchange.");
  }
  const routes = stringArray(source.routes_visited);
  for (const route of REQUIRED_ROUTES) {
    if (!routes.includes(route)) out.push(`Evidence did not visit required route: ${route}.`);
  }
  checkRouteScreenshots(source, out, evidenceDir);
  const commands = stringArray(source.commands_observed);
  for (const command of REQUIRED_COMMANDS) {
    if (!commands.includes(command)) {
      out.push(`Evidence did not observe required Tauri command: ${command}.`);
    }
  }
}

function checkRouteScreenshots(source, out, evidenceDir) {
  if (!Array.isArray(source.route_screenshots)) {
    out.push("Evidence source.route_screenshots is required.");
    return;
  }

  const screenshotsByRoute = new Map();
  for (const item of source.route_screenshots) {
    if (!isRecord(item)) {
      out.push("Evidence route screenshot metadata must be an object.");
      continue;
    }
    const route = stringValue(item.route);
    if (!REQUIRED_ROUTES.includes(route)) {
      out.push(`Evidence route screenshot references an unknown route: ${route || "missing"}.`);
      continue;
    }
    if (screenshotsByRoute.has(route)) {
      out.push(`Evidence contains duplicate route screenshot metadata: ${route}.`);
      continue;
    }
    screenshotsByRoute.set(route, item);
  }

  for (const route of REQUIRED_ROUTES) {
    const screenshot = screenshotsByRoute.get(route);
    if (!screenshot) {
      out.push(`Evidence did not capture required route screenshot: ${route}.`);
      continue;
    }
    const relativePath = stringValue(screenshot.path);
    const digest = normalizeDigest(stringValue(screenshot.sha256));
    const expectedBytes = numberValue(screenshot.bytes);
    const expectedWidth = numberValue(screenshot.width);
    const expectedHeight = numberValue(screenshot.height);

    if (!isSafeRelativePngPath(relativePath)) {
      out.push(`Evidence route screenshot for ${route} is missing a safe relative PNG path.`);
      continue;
    }
    if (!digest) {
      out.push(`Evidence route screenshot for ${route} is missing a valid sha256 digest.`);
    }
    if (expectedBytes < MIN_ROUTE_SCREENSHOT_BYTES) {
      out.push(`Evidence route screenshot for ${route} is too small.`);
    }
    if (expectedWidth < MIN_ROUTE_SCREENSHOT_WIDTH) {
      out.push(`Evidence route screenshot for ${route} is narrower than ${MIN_ROUTE_SCREENSHOT_WIDTH}px.`);
    }
    if (expectedHeight < MIN_ROUTE_SCREENSHOT_HEIGHT) {
      out.push(`Evidence route screenshot for ${route} is shorter than ${MIN_ROUTE_SCREENSHOT_HEIGHT}px.`);
    }

    const screenshotPath = path.resolve(evidenceDir, relativePath);
    if (!screenshotPath.startsWith(`${evidenceDir}${path.sep}`)) {
      out.push(`Evidence route screenshot for ${route} resolves outside the evidence directory.`);
      continue;
    }

    let bytes;
    try {
      bytes = fs.readFileSync(screenshotPath);
    } catch (err) {
      out.push(`Evidence route screenshot for ${route} could not be read: ${errorMessage(err)}.`);
      continue;
    }

    if (bytes.length !== expectedBytes) {
      out.push(`Evidence route screenshot for ${route} byte count does not match metadata.`);
    }
    if (digest && sha256Hex(bytes) !== digest) {
      out.push(`Evidence route screenshot for ${route} sha256 does not match metadata.`);
    }

    const dimensions = pngDimensions(bytes);
    if (!dimensions) {
      out.push(`Evidence route screenshot for ${route} is not a PNG screenshot.`);
      continue;
    }
    if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
      out.push(`Evidence route screenshot for ${route} dimensions do not match metadata.`);
    }
    if (dimensions.width < MIN_ROUTE_SCREENSHOT_WIDTH) {
      out.push(`Evidence route screenshot for ${route} PNG width is below ${MIN_ROUTE_SCREENSHOT_WIDTH}px.`);
    }
    if (dimensions.height < MIN_ROUTE_SCREENSHOT_HEIGHT) {
      out.push(`Evidence route screenshot for ${route} PNG height is below ${MIN_ROUTE_SCREENSHOT_HEIGHT}px.`);
    }
  }
}

function checkOsSmoke(osSmoke, out) {
  if (stringValue(osSmoke.status) !== "ok") {
    out.push(`QEMU smoke status is not ok: ${stringValue(osSmoke.status) || "missing"}.`);
  }
  const rawImage = stringValue(osSmoke.raw_image);
  if (!/^monarch-os-talos-v[0-9][^-]*-[a-z0-9_]+\.raw$/u.test(rawImage)) {
    out.push(`QEMU smoke raw image is not a Monarch OS raw artifact: ${rawImage || "missing"}.`);
  }
  if (!boolish(osSmoke.require_talos_api_probe)) {
    out.push("QEMU smoke did not require a Talos API probe.");
  }
  const probe = stringValue(osSmoke.talos_api_probe);
  if (!TALOSCTL_PROBES.has(probe)) {
    out.push(`QEMU smoke did not prove Talos API through talosctl: ${probe || "missing"}.`);
  }
  if (!boolish(osSmoke.machine_config_applied)) {
    out.push("QEMU smoke did not apply a Talos machine config.");
  }
  if (osSmoke.extension_service_name !== "ext-protocore") {
    out.push("QEMU smoke did not target ext-protocore.");
  }
  if (osSmoke.extension_service_check !== "ok") {
    out.push("QEMU smoke did not verify ext-protocore service.");
  }
  if (osSmoke.protocore_rpc_probe !== "ok") {
    out.push("QEMU smoke did not verify Protocore RPC.");
  }
  if (osSmoke.substrate_runtime_proof !== "ok") {
    out.push("QEMU smoke did not verify runtime substrate proof.");
  }
  const releaseMetadata = stringValue(osSmoke.release_metadata);
  if (!/^monarch-os-talos-v[0-9][^-]*-[a-z0-9_]+\.release\.json$/u.test(releaseMetadata)) {
    out.push(`QEMU smoke release metadata is not a Monarch OS metadata artifact: ${releaseMetadata || "missing"}.`);
  }
  if (!normalizeDigest(stringValue(osSmoke.expected_protocore_digest))) {
    out.push("QEMU smoke did not provide a valid expected Protocore digest from release metadata.");
  }
}

function checkDesktopReadiness(readiness, out) {
  checkTalos(readiness, out);
  checkProtocore(readiness, out);
  checkReleaseAttestation(readiness.releaseAttestation, out);
  checkOperationReceipts(readiness, out);
  checkChat(readiness, out);
}

function checkTalos(readiness, out) {
  const config = readiness.talosConfig;
  const status = readiness.talosStatus;
  if (!isRecord(config)) {
    out.push("Desktop talos-identity: Talos config has not been inspected.");
    return;
  }
  if (config.caPinStatus !== "matched") {
    out.push("Desktop talos-identity: Trusted Talos CA pin is not matched.");
  }
  if (!Array.isArray(config.certificates) || config.certificates.length === 0) {
    out.push("Desktop talos-identity: Talos config exposes no certificates to validate.");
  } else {
    const invalidCerts = config.certificates.filter((cert) =>
      isRecord(cert) && (cert.expired || cert.notYetValid));
    const missingExpiryHorizon = config.certificates.filter((cert) =>
      !isRecord(cert) ||
      typeof cert.expiresInDays !== "number" ||
      !Number.isFinite(cert.expiresInDays));
    const expiringCerts = config.certificates.filter((cert) =>
      isRecord(cert) &&
      cert.expired !== true &&
      cert.notYetValid !== true &&
      typeof cert.expiresInDays === "number" &&
      Number.isFinite(cert.expiresInDays) &&
      cert.expiresInDays < TALOS_CERT_MIN_VALIDITY_DAYS);
    if (invalidCerts.length > 0) {
      out.push("Desktop talos-identity: Talos config has expired or not-yet-valid certificate(s).");
    }
    if (missingExpiryHorizon.length > 0) {
      out.push("Desktop talos-identity: Talos config has certificate(s) without expiry-horizon evidence.");
    }
    if (expiringCerts.length > 0) {
      out.push(`Desktop talos-identity: Talos config has ${expiringCerts.length} certificate(s) inside the ${TALOS_CERT_MIN_VALIDITY_DAYS}-day rotation window.`);
    }
  }
  const endpoint = stringValue(config.endpoint);
  const endpoints = stringArray(config.endpoints);
  const nodes = stringArray(config.nodes);
  if (!endpoints.includes(endpoint) && !nodes.includes(endpoint)) {
    out.push("Desktop talos-identity: Selected Talos endpoint is outside the active context.");
  }
  if (isRecord(status)) {
    const statusEndpoint = stringValue(status.endpoint);
    if (status.reachable !== true || (statusEndpoint && trimEndpoint(statusEndpoint) !== trimEndpoint(endpoint))) {
      out.push("Desktop talos-identity: Talos status is unreachable or points at another endpoint.");
    }
  }
}

function checkProtocore(readiness, out) {
  const protocore = readiness.protocore;
  const expectedChainId = numberValue(readiness.expectedChainId) || 69420;
  if (!isRecord(protocore)) {
    out.push("Desktop protocore-readiness: Protocore readiness has not been checked.");
    return;
  }
  const service = protocore.service;
  if (!isRecord(service) || service.id !== "ext-protocore" || service.severity !== "ok") {
    out.push("Desktop protocore-readiness: Talos service ext-protocore is not healthy.");
  }
  if (protocore.displayState !== "serving-rpc" || protocore.severity !== "ok") {
    out.push("Desktop protocore-readiness: Protocore is not serving RPC in a healthy state.");
  }
  if (protocore.chainId !== expectedChainId) {
    out.push(`Desktop protocore-readiness: Protocore chain id is not ${expectedChainId}.`);
  }
  if (numberValue(protocore.blockNumber) < 0 || typeof protocore.blockNumber !== "number") {
    out.push("Desktop protocore-readiness: Protocore block number is unavailable.");
  }
  if (!stringValue(protocore.clientVersion)) {
    out.push("Desktop protocore-readiness: Protocore client version is unavailable.");
  }
  if (protocore.listening !== true) {
    out.push("Desktop protocore-readiness: Protocore P2P listener is not confirmed.");
  }
  if (protocore.syncing !== false) {
    out.push("Desktop protocore-readiness: Protocore has not reported eth_syncing=false.");
  }
}

function checkReleaseAttestation(attestation, out) {
  if (!isRecord(attestation)) {
    out.push("Desktop release-attestation: Release digest attestation has not been evaluated.");
    return;
  }
  if (!stringValue(attestation.className).includes("halo--ok") || !/matched/iu.test(stringValue(attestation.text))) {
    out.push("Desktop release-attestation: Live runtime digest does not match the expected release digest.");
  }
}

function checkReleaseDigestBinding(osSmoke, readiness, out) {
  const osDigest = normalizeDigest(stringValue(osSmoke.expected_protocore_digest));
  const attestation = readiness.releaseAttestation;
  if (!isRecord(attestation) || !osDigest) return;

  const expectedDigest = normalizeDigest(stringValue(attestation.expectedDigest));
  const liveDigest = normalizeDigest(stringValue(attestation.liveDigest));
  if (!expectedDigest) {
    out.push("Desktop release-attestation: Expected digest evidence is missing.");
  } else if (expectedDigest !== osDigest) {
    out.push("Desktop release-attestation: Expected digest does not match the Monarch OS release metadata digest.");
  }
  if (!liveDigest) {
    out.push("Desktop release-attestation: Live runtime digest evidence is missing.");
  } else if (liveDigest !== osDigest) {
    out.push("Desktop release-attestation: Live runtime digest does not match the Monarch OS release metadata digest.");
  }
}

function checkOperationReceipts(readiness, out) {
  const receipts = Array.isArray(readiness.operationReceipts) ? readiness.operationReceipts : [];
  const required = Array.isArray(readiness.requiredOperationActions) && readiness.requiredOperationActions.length > 0
    ? readiness.requiredOperationActions
    : ["restart"];
  const missing = required.filter((action) => {
    const kind = `operator-${action}`;
    return !receipts.some((receipt) =>
      isRecord(receipt) &&
      receipt.kind === kind &&
      receipt.status === "ok" &&
      receipt.transport === "talos" &&
      receipt.service === "ext-protocore" &&
      receipt.action === action &&
      Boolean(receipt.endpoint) &&
      Boolean(receipt.nodeAddress) &&
      receipt.auditPayloadSchema === OPERATION_RECEIPT_AUDIT_SCHEMA &&
      HASH32_RE.test(String(receipt.auditPayloadHash || "")));
  });
  if (missing.length > 0) {
    out.push(`Desktop operation-receipts: Missing audit-ready successful Talos receipt(s) for: ${missing.join(", ")}.`);
  }
}

function checkChat(readiness, out) {
  const chat = readiness.chat;
  if (!isRecord(chat)) {
    out.push("Desktop chat-exchange: Chat evidence has not been collected.");
    return;
  }
  const init = chat.init;
  if (!isRecord(init) || !stringValue(init.address_hex) || !stringValue(init.public_key_hex)) {
    out.push("Desktop chat-exchange: Chat identity has not initialized.");
  }
  const expectedRpc = stringValue(readiness.expectedRpcEndpoint);
  if (expectedRpc && isRecord(init) && trimEndpoint(stringValue(init.rpc_endpoint)) !== trimEndpoint(expectedRpc)) {
    out.push("Desktop chat-exchange: Chat initialized against a different RPC endpoint.");
  }
  if (chat.requireBootstrapPeers !== false && stringArray(chat.bootstrapPeers).length === 0) {
    out.push("Desktop chat-exchange: Chat bootstrap peers are not configured.");
  }
  const activeId = stringValue(chat.activeChannelId);
  const channels = Array.isArray(chat.channels) ? chat.channels : [];
  const active = channels.find((channel) => isRecord(channel) && channel.channel_id === activeId);
  if (!isSubscribedClusterChannel(active)) {
    out.push("Desktop chat-exchange: No subscribed active cluster channel is selected.");
  }
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const activeVerifiedMessages = messages.filter((message) => isSignedActiveChatMessage(message, active));
  const allActiveAndVerified = messages.every((message) =>
    isRecord(message) &&
    isSignedActiveChatMessage(message, active));
  if (!allActiveAndVerified) {
    out.push("Desktop chat-exchange: Chat history contains stale, unsigned, or unverified messages.");
  }
  const distinctSenders = new Set(activeVerifiedMessages
    .map((message) => normalizeHex(stringValue(message.sender_address))));
  const ownSenders = new Set(activeVerifiedMessages
    .filter((message) => message.from_me === true)
    .map((message) => normalizeHex(stringValue(message.sender_address))));
  const peerSenders = new Set(activeVerifiedMessages
    .filter((message) => message.from_me === false)
    .map((message) => normalizeHex(stringValue(message.sender_address))));
  const localAddress = isRecord(init) ? normalizeHex(stringValue(init.address_hex)) : "";
  const perspectiveMatchesIdentity = Boolean(localAddress) && activeVerifiedMessages.every((message) =>
    (normalizeHex(stringValue(message.sender_address)) === localAddress) === (message.from_me === true));
  if (activeVerifiedMessages.length < 2) {
    out.push("Desktop chat-exchange: Chat has not proved a two-party signed exchange.");
  }
  if (distinctSenders.size < 2) {
    out.push("Desktop chat-exchange: Chat has not proved two distinct signed operator identities.");
  }
  if (ownSenders.size === 0 || peerSenders.size === 0) {
    out.push("Desktop chat-exchange: Chat has not proved both local and peer signed messages.");
  }
  if (!perspectiveMatchesIdentity) {
    out.push("Desktop chat-exchange: Chat message perspective does not match the initialized identity.");
  }
  if (!isRecord(chat.membership)) {
    out.push("Desktop chat-exchange: Chat sender membership has not been proven against the cluster registry.");
  } else if (!chatMembershipCoversSenders(chat.membership, active, distinctSenders)) {
    out.push("Desktop chat-exchange: Chat sender membership proof does not cover every signed sender.");
  }
}

function chatMembershipCoversSenders(membership, active, senders) {
  if (!isRecord(active)) return false;
  if (membership.source !== "lyth_clusterStatus+lyth_operatorInfo") return false;
  if (membership.clusterId !== active.cluster_id) return false;
  const checkedAt = stringValue(membership.checkedAt);
  if (!checkedAt || Number.isNaN(Date.parse(checkedAt))) return false;
  if (typeof membership.membersChecked !== "number" || membership.membersChecked < senders.size) {
    return false;
  }

  const covered = new Set();
  const proofs = Array.isArray(membership.proofs) ? membership.proofs : [];
  for (const proof of proofs) {
    if (!isRecord(proof)) continue;
    if (proof.source !== membership.source || proof.clusterId !== active.cluster_id) continue;
    if (!isHexBytes(stringValue(proof.operatorId), 32)) continue;
    const sender = normalizeHex(stringValue(proof.senderAddress));
    const chainAddress = normalizeHex(stringValue(proof.chainAddressHex));
    if (!isAddressHex(sender) || !isAddressHex(chainAddress) || sender !== chainAddress) continue;
    covered.add(sender);
  }

  for (const sender of senders) {
    if (!covered.has(sender)) return false;
  }
  return true;
}

function isSubscribedClusterChannel(channel) {
  if (!isRecord(channel)) return false;
  if (channel.subscribed !== true || channel.kind !== "cluster") return false;
  if (typeof channel.cluster_id !== "number" || !Number.isFinite(channel.cluster_id)) return false;
  return channel.channel_id === `cluster-${channel.cluster_id}`;
}

function isSignedActiveChatMessage(message, active) {
  return Boolean(
    isRecord(message) &&
    isRecord(active) &&
    message.channel_id === active.channel_id &&
    message.cluster_id === active.cluster_id &&
    message.verified === true &&
    isHexBytes(stringValue(message.msg_id), 32) &&
    isHexBytes(stringValue(message.signature_hex)) &&
    isHexBytes(stringValue(message.sender_pubkey_hex)) &&
    isHexBytes(stringValue(message.nonce_hex)) &&
    isAddressHex(stringValue(message.sender_address)) &&
    stringValue(message.body).length > 0 &&
    typeof message.timestamp_ms === "number" &&
    Number.isFinite(message.timestamp_ms) &&
    typeof message.from_me === "boolean",
  );
}

function isAddressHex(value) {
  return /^[0-9a-f]{40}$/u.test(normalizeHex(value));
}

function isHexBytes(value, byteLength) {
  const hex = normalizeHex(value);
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(hex)) return false;
  return typeof byteLength === "number" ? hex.length === byteLength * 2 : true;
}

function normalizeHex(value) {
  return value.trim().replace(/^0x/iu, "").toLowerCase();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function boolish(value) {
  return value === true || value === "true" || value === "1";
}

function isSafeRelativePngPath(value) {
  if (!value.endsWith(".png")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) return false;
  return !value.split(/[\\/]+/u).includes("..");
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function pngDimensions(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!Buffer.isBuffer(bytes) || bytes.length < 33) return null;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return null;
  }
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function trimEndpoint(value) {
  return value.trim().replace(/\/+$/u, "");
}

function normalizeDigest(value) {
  const digest = value.trim().replace(/^sha256:/iu, "").replace(/^0x/iu, "").toLowerCase();
  return /^[0-9a-f]{64}$/u.test(digest) ? digest : "";
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}
