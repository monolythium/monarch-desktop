import {
  desktopReleaseReadiness,
  type DesktopReleaseReadinessInput,
  type DesktopReleaseReadinessReport,
} from "./releaseReadiness";
import requiredE2eRoutes from "../nav/e2eRequiredRoutes.json";

export const DESKTOP_E2E_EVIDENCE_SCHEMA = "monarch-desktop-e2e-evidence/v1";

const REQUIRED_ROUTES = requiredE2eRoutes;
const REQUIRED_COMMANDS = [
  "talos_config_info",
  "talos_protocore_readiness",
  "talos_service_action:restart",
  "chat_initialize",
  "chat_subscribe_channel",
  "chat_send_message",
] as const;
const TALOSCTL_PROBES = new Set(["talosctl_ok", "talosctl_secure_ok"]);
const MIN_ROUTE_SCREENSHOT_BYTES = 1024;
const MIN_ROUTE_SCREENSHOT_WIDTH = 320;
const MIN_ROUTE_SCREENSHOT_HEIGHT = 240;

export type DesktopReleaseE2eEvidence = {
  schema_version: typeof DESKTOP_E2E_EVIDENCE_SCHEMA;
  source: {
    kind: "tauri-gui-e2e";
    runner: string;
    generated_at: string;
    app_version: string;
    commit: string;
    windows_observed: number;
    routes_visited: string[];
    route_screenshots: Array<{
      route: string;
      path: string;
      sha256: string;
      bytes: number;
      width: number;
      height: number;
    }>;
    commands_observed: string[];
  };
  os_smoke: {
    status: string;
    raw_image: string;
    talos_api_probe: string;
    require_talos_api_probe: string | boolean;
    machine_config_applied: string | boolean;
    extension_service_name: string;
    extension_service_check: string;
    protocore_rpc_probe: string;
    substrate_runtime_proof: string;
    release_metadata: string;
    expected_protocore_digest: string;
  };
  desktop_readiness: DesktopReleaseReadinessInput;
};

export type DesktopReleaseE2eEvidenceReport = {
  ok: boolean;
  blockers: string[];
  readiness: DesktopReleaseReadinessReport | null;
};

export function verifyDesktopReleaseE2eEvidence(
  evidence: unknown,
): DesktopReleaseE2eEvidenceReport {
  const blockers: string[] = [];
  if (!isRecord(evidence)) {
    return { ok: false, blockers: ["Evidence root must be an object."], readiness: null };
  }

  const schema = stringValue(evidence.schema_version);
  if (schema !== DESKTOP_E2E_EVIDENCE_SCHEMA) {
    blockers.push(`Unsupported evidence schema: ${schema || "missing"}.`);
  }

  const source = evidence.source;
  if (!isRecord(source)) {
    blockers.push("Evidence source is missing.");
  } else {
    checkSource(source, blockers);
  }

  const osSmoke = evidence.os_smoke;
  if (!isRecord(osSmoke)) {
    blockers.push("OS QEMU smoke evidence is missing.");
  } else {
    checkOsSmoke(osSmoke, blockers);
  }

  const desktopReadiness = evidence.desktop_readiness;
  let readiness: DesktopReleaseReadinessReport | null = null;
  if (!isRecord(desktopReadiness)) {
    blockers.push("Desktop readiness evidence is missing.");
  } else {
    try {
      readiness = desktopReleaseReadiness(
        desktopReadiness as unknown as DesktopReleaseReadinessInput,
      );
      for (const blocker of readiness.blockers) {
        blockers.push(`Desktop ${blocker.id}: ${blocker.summary}`);
      }
    } catch (err) {
      blockers.push(`Desktop readiness evidence is malformed: ${errorMessage(err)}.`);
    }
  }
  if (isRecord(osSmoke) && isRecord(desktopReadiness)) {
    checkReleaseDigestBinding(osSmoke, desktopReadiness, blockers);
  }

  return {
    ok: blockers.length === 0,
    blockers,
    readiness,
  };
}

function checkSource(source: Record<string, unknown>, blockers: string[]) {
  if (source.kind !== "tauri-gui-e2e") {
    blockers.push("Evidence must be collected by the Tauri GUI e2e harness.");
  }
  for (const key of ["runner", "app_version", "commit"] as const) {
    if (!stringValue(source[key])) {
      blockers.push(`Evidence source.${key} is required.`);
    }
  }

  const generatedAt = stringValue(source.generated_at);
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    blockers.push("Evidence source.generated_at must be an ISO timestamp.");
  }

  const windowsObserved = numberValue(source.windows_observed);
  if (windowsObserved < 2) {
    blockers.push("Evidence must observe two Tauri windows for the chat exchange.");
  }

  const routes = stringArray(source.routes_visited);
  for (const route of REQUIRED_ROUTES) {
    if (!routes.includes(route)) {
      blockers.push(`Evidence did not visit required route: ${route}.`);
    }
  }
  checkRouteScreenshots(source, blockers);

  const commands = stringArray(source.commands_observed);
  for (const command of REQUIRED_COMMANDS) {
    if (!commands.includes(command)) {
      blockers.push(`Evidence did not observe required Tauri command: ${command}.`);
    }
  }
}

function checkRouteScreenshots(source: Record<string, unknown>, blockers: string[]) {
  if (!Array.isArray(source.route_screenshots)) {
    blockers.push("Evidence source.route_screenshots is required.");
    return;
  }

  const screenshotsByRoute = new Map<string, Record<string, unknown>>();
  for (const item of source.route_screenshots) {
    if (!isRecord(item)) {
      blockers.push("Evidence route screenshot metadata must be an object.");
      continue;
    }
    const route = stringValue(item.route);
    if (!REQUIRED_ROUTES.includes(route)) {
      blockers.push(`Evidence route screenshot references an unknown route: ${route || "missing"}.`);
      continue;
    }
    if (screenshotsByRoute.has(route)) {
      blockers.push(`Evidence contains duplicate route screenshot metadata: ${route}.`);
      continue;
    }
    screenshotsByRoute.set(route, item);
  }

  for (const route of REQUIRED_ROUTES) {
    const screenshot = screenshotsByRoute.get(route);
    if (!screenshot) {
      blockers.push(`Evidence did not capture required route screenshot: ${route}.`);
      continue;
    }
    if (!isSafeRelativePngPath(stringValue(screenshot.path))) {
      blockers.push(`Evidence route screenshot for ${route} is missing a safe relative PNG path.`);
    }
    if (!normalizeDigest(stringValue(screenshot.sha256))) {
      blockers.push(`Evidence route screenshot for ${route} is missing a valid sha256 digest.`);
    }
    if (numberValue(screenshot.bytes) < MIN_ROUTE_SCREENSHOT_BYTES) {
      blockers.push(`Evidence route screenshot for ${route} is too small.`);
    }
    if (numberValue(screenshot.width) < MIN_ROUTE_SCREENSHOT_WIDTH) {
      blockers.push(`Evidence route screenshot for ${route} is narrower than ${MIN_ROUTE_SCREENSHOT_WIDTH}px.`);
    }
    if (numberValue(screenshot.height) < MIN_ROUTE_SCREENSHOT_HEIGHT) {
      blockers.push(`Evidence route screenshot for ${route} is shorter than ${MIN_ROUTE_SCREENSHOT_HEIGHT}px.`);
    }
  }
}

function checkOsSmoke(osSmoke: Record<string, unknown>, blockers: string[]) {
  const status = stringValue(osSmoke.status);
  if (status !== "ok") {
    blockers.push(`QEMU smoke status is not ok: ${status || "missing"}.`);
  }

  const rawImage = stringValue(osSmoke.raw_image);
  if (!/^monarch-os-talos-v[0-9][^-]*-[a-z0-9_]+\.raw$/u.test(rawImage)) {
    blockers.push(`QEMU smoke raw image is not a Monarch OS raw artifact: ${rawImage || "missing"}.`);
  }

  const requireProbe = boolish(osSmoke.require_talos_api_probe);
  if (!requireProbe) {
    blockers.push("QEMU smoke did not require a Talos API probe.");
  }

  const probe = stringValue(osSmoke.talos_api_probe);
  if (!TALOSCTL_PROBES.has(probe)) {
    blockers.push(`QEMU smoke did not prove Talos API through talosctl: ${probe || "missing"}.`);
  }

  if (!boolish(osSmoke.machine_config_applied)) {
    blockers.push("QEMU smoke did not apply a Talos machine config.");
  }
  if (osSmoke.extension_service_name !== "ext-protocore") {
    blockers.push("QEMU smoke did not target ext-protocore.");
  }
  if (osSmoke.extension_service_check !== "ok") {
    blockers.push("QEMU smoke did not verify ext-protocore service.");
  }
  if (osSmoke.protocore_rpc_probe !== "ok") {
    blockers.push("QEMU smoke did not verify Protocore RPC.");
  }
  if (osSmoke.substrate_runtime_proof !== "ok") {
    blockers.push("QEMU smoke did not verify runtime substrate proof.");
  }

  const releaseMetadata = stringValue(osSmoke.release_metadata);
  if (!/^monarch-os-talos-v[0-9][^-]*-[a-z0-9_]+\.release\.json$/u.test(releaseMetadata)) {
    blockers.push(`QEMU smoke release metadata is not a Monarch OS metadata artifact: ${releaseMetadata || "missing"}.`);
  }
  if (!normalizeDigest(stringValue(osSmoke.expected_protocore_digest))) {
    blockers.push("QEMU smoke did not provide a valid expected Protocore digest from release metadata.");
  }
}

function checkReleaseDigestBinding(
  osSmoke: Record<string, unknown>,
  desktopReadiness: Record<string, unknown>,
  blockers: string[],
) {
  const osDigest = normalizeDigest(stringValue(osSmoke.expected_protocore_digest));
  const attestation = desktopReadiness.releaseAttestation;
  if (!isRecord(attestation) || !osDigest) return;

  const expectedDigest = normalizeDigest(stringValue(attestation.expectedDigest));
  const liveDigest = normalizeDigest(stringValue(attestation.liveDigest));
  if (!expectedDigest) {
    blockers.push("Desktop release-attestation: Expected digest evidence is missing.");
  } else if (expectedDigest !== osDigest) {
    blockers.push("Desktop release-attestation: Expected digest does not match the Monarch OS release metadata digest.");
  }
  if (!liveDigest) {
    blockers.push("Desktop release-attestation: Live runtime digest evidence is missing.");
  } else if (liveDigest !== osDigest) {
    blockers.push("Desktop release-attestation: Live runtime digest does not match the Monarch OS release metadata digest.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function boolish(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function isSafeRelativePngPath(value: string): boolean {
  if (!value.endsWith(".png")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) return false;
  return !value.split(/[\\/]+/u).includes("..");
}

function normalizeDigest(value: string): string {
  const digest = value.trim().replace(/^sha256:/iu, "").replace(/^0x/iu, "").toLowerCase();
  return /^[0-9a-f]{64}$/u.test(digest) ? digest : "";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
