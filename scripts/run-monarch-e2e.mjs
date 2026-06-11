#!/usr/bin/env node
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL , fileURLToPath } from "node:url";
import { resolveDesktopRpcEndpoint as resolveDesktopRpcEndpointPure } from "./lib/desktop-rpc-endpoint.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_OS_REPO = path.resolve(ROOT, "..", "monarch-os-talos");
const DEFAULT_OS_CONFIG_DIR = "_out/smoke-qemu-config";
const DEFAULT_OUTPUT = path.join(ROOT, "_out", "monarch-desktop-e2e-evidence.json");

const mainModule = isMainModule();
const options = mainModule ? parseArgs(process.argv.slice(2)) : {};

if (mainModule) {
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  await main().catch((err) => {
    console.error(errorMessage(err));
    process.exitCode = 1;
  });
}

async function main() {
  const osRepo = path.resolve(firstNonEmpty(options.osRepo, env("MONARCH_OS_REPO"), DEFAULT_OS_REPO));
  const outputPath = path.resolve(firstNonEmpty(options.output, env("MONARCH_DESKTOP_E2E_OUTPUT"), DEFAULT_OUTPUT));
  const osConfigDir = firstNonEmpty(options.osConfigDir, env("MONARCH_OS_SMOKE_CONFIG_DIR"), DEFAULT_OS_CONFIG_DIR);
  assertDir(osRepo, "Monarch OS repo");

  if (options.skipSmokeConfig !== true) {
    await runChecked("make", ["smoke-qemu-config"], {
      cwd: osRepo,
      env: {
        ...process.env,
        SMOKE_CONFIG_DIR: osConfigDir,
        PROTOCORE_REQUIRE_ENROLLMENT: firstNonEmpty(env("PROTOCORE_REQUIRE_ENROLLMENT"), "true"),
        PROTOCORE_EXPECTED_DIGEST_FILE: firstNonEmpty(
          env("PROTOCORE_EXPECTED_DIGEST_FILE"),
          "/var/lib/protocore/enrollment/protocore.sha256",
        ),
        PROTOCORE_REQUIRE_TPM_BINDING: firstNonEmpty(env("PROTOCORE_REQUIRE_TPM_BINDING"), "true"),
      },
    });
  }

  await alignTalosconfigForSmoke(osRepo, osConfigDir);

  const { smoke, smokeEnv } = await startSmokeAndReadLiveEnv(osRepo, osConfigDir);
  const desktopRpcEndpoint = resolveDesktopRpcEndpoint(options, smokeEnv);
  try {
    if (options.buildApp || env("MONARCH_E2E_BUILD_APP") === "true") {
      await runChecked("pnpm", ["tauri", "build", "--debug", "--no-bundle", "--ci"], {
        cwd: ROOT,
        env: {
          ...process.env,
          ...smokeEnv,
          VITE_MONARCH_E2E_RECORDER: "true",
          VITE_RPC_ENDPOINT: desktopRpcEndpoint,
          TAURI_RPC_ENDPOINT: desktopRpcEndpoint,
        },
      });
    }

    const e2eArgs = [
      "run",
      "e2e:tauri",
      "--",
      "--os-smoke",
      smokeEnv.MONARCH_OS_SMOKE_RESULT,
      "--talos-endpoint",
      smokeEnv.MONARCH_E2E_TALOS_ENDPOINT,
      "--talos-config",
      smokeEnv.MONARCH_E2E_TALOSCONFIG,
      "--expected-rpc-endpoint",
      desktopRpcEndpoint,
      "--protocore-rpc-endpoint",
      smokeEnv.MONARCH_E2E_RPC_ENDPOINT,
      "--trust-talos-config",
      "--output",
      outputPath,
    ];

    const expectedDigest = firstNonEmpty(
      options.expectedDigest,
      env("MONARCH_E2E_EXPECTED_DIGEST"),
      smokeEnv.MONARCH_E2E_EXPECTED_DIGEST,
    );
    if (!expectedDigest) {
      throw new Error("Expected Protocore digest missing; pass --expected-digest or provide Monarch OS release metadata for smoke-qemu.");
    }

    appendOptionalArg(e2eArgs, "--app", options.app ?? env("MONARCH_DESKTOP_APP"));
    appendOptionalArg(e2eArgs, "--expected-digest", expectedDigest);
    appendOptionalArg(e2eArgs, "--cluster-id", options.clusterId ?? env("MONARCH_E2E_CLUSTER_ID"));
    appendOptionalArg(e2eArgs, "--cluster-name", options.clusterName ?? env("MONARCH_E2E_CLUSTER_NAME"));
    appendOptionalArg(e2eArgs, "--chat-body", options.chatBody ?? env("MONARCH_E2E_CHAT_BODY"));
    appendOptionalArg(e2eArgs, "--operator-mnemonic-file", options.operatorMnemonicFile ?? env("MONARCH_E2E_OPERATOR_MNEMONIC_FILE"));
    appendOptionalArg(e2eArgs, "--peer-operator-mnemonic-file", options.peerOperatorMnemonicFile ?? env("MONARCH_E2E_PEER_OPERATOR_MNEMONIC_FILE"));
    appendOptionalArg(e2eArgs, "--peer-chat-body", options.peerChatBody ?? env("MONARCH_E2E_PEER_CHAT_BODY"));
    appendOptionalArg(e2eArgs, "--peer-wait-ms", options.peerWaitMs ?? env("MONARCH_E2E_PEER_WAIT_MS"));
    appendOptionalArg(e2eArgs, "--chat-bootstrap-peers-file", options.chatBootstrapPeersFile ?? env("MONARCH_E2E_CHAT_BOOTSTRAP_PEERS_FILE"));
    appendOptionalArg(e2eArgs, "--chat-bootstrap-peers", options.chatBootstrapPeers ?? env("MONARCH_E2E_CHAT_BOOTSTRAP_PEERS"));
    appendOptionalArg(e2eArgs, "--dkg-reshare-attestation", options.dkgReshareAttestation ?? env("MONARCH_E2E_DKG_RESHARE_ATTESTATION_FILE"));
    appendOptionalArg(e2eArgs, "--dkg-reshare-attestation-json", options.dkgReshareAttestationJson ?? env("MONARCH_E2E_DKG_RESHARE_ATTESTATION"));
    if (
      options.allowMissingBootstrapPeers ||
      truthyEnv("MONARCH_E2E_ALLOW_MISSING_BOOTSTRAP_PEERS") ||
      truthyEnv("MONARCH_E2E_ALLOW_DISCOVERED_CHAT_PEERS")
    ) {
      e2eArgs.push("--allow-missing-bootstrap-peers");
    }

    await runChecked("pnpm", e2eArgs, {
      cwd: ROOT,
      env: {
        ...process.env,
        ...smokeEnv,
        VITE_MONARCH_E2E_RECORDER: "true",
        VITE_RPC_ENDPOINT: desktopRpcEndpoint,
        TAURI_RPC_ENDPOINT: desktopRpcEndpoint,
      },
    });
  } finally {
    await stopChild(smoke);
    await stopSmokeVm(smokeEnv);
  }
}

async function alignTalosconfigForSmoke(osRepo, osConfigDir) {
  const configDirPath = path.resolve(osRepo, osConfigDir);
  const talosconfig = path.join(configDirPath, "talosconfig");
  if (!fs.existsSync(talosconfig)) return;

  const endpoint = smokeTalosEndpoint();
  await runChecked("talosctl", ["--talosconfig", talosconfig, "config", "endpoint", endpoint], {
    cwd: osRepo,
    env: process.env,
  });
  await runChecked("talosctl", ["--talosconfig", talosconfig, "config", "node", smokeTalosNode()], {
    cwd: osRepo,
    env: process.env,
  });
}

function smokeTalosEndpoint() {
  return normalizeTalosEndpoint(
    firstNonEmpty(
      env("MONARCH_E2E_TALOS_ENDPOINT"),
      env("TALOS_ENDPOINT"),
      `127.0.0.1:${firstNonEmpty(env("API_HOST_PORT"), "50000")}`,
    ),
  );
}

function normalizeTalosEndpoint(value) {
  const trimmed = value.trim();
  if (!trimmed) return "https://127.0.0.1:50000";
  if (trimmed.includes("://")) return trimmed.replace(/\/+$/u, "");
  return `https://${trimmed}`.replace(/\/+$/u, "");
}

function smokeTalosNode() {
  const endpoint = smokeTalosEndpoint();
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "127.0.0.1";
  }
}

export function resolveDesktopRpcEndpoint(e2eOptions = {}, smokeEnv = {}, environment = process.env) {
  return resolveDesktopRpcEndpointPure(e2eOptions, smokeEnv, environment);
}

async function startSmokeAndReadLiveEnv(osRepo, osConfigDir) {
  const configDirPath = path.resolve(osRepo, osConfigDir);
  const liveEnvPath = path.resolve(configDirPath, "..", "smoke-qemu", "live-env.sh");
  fs.rmSync(liveEnvPath, { force: true });

  const smoke = childProcess.spawn("make", ["smoke-qemu-artifact"], {
    cwd: osRepo,
    env: {
      ...process.env,
      KEEP_QEMU_ALIVE: "true",
      TIMEOUT_SECONDS: firstNonEmpty(env("TIMEOUT_SECONDS"), "1500"),
      BOOT_HOLD_SECONDS: firstNonEmpty(env("BOOT_HOLD_SECONDS"), "240"),
      POST_APPLY_TIMEOUT_SECONDS: firstNonEmpty(env("POST_APPLY_TIMEOUT_SECONDS"), "1200"),
      EXTENSION_SERVICE_TIMEOUT_SECONDS: firstNonEmpty(env("EXTENSION_SERVICE_TIMEOUT_SECONDS"), "900"),
      PROTOCORE_RPC_TIMEOUT_SECONDS: firstNonEmpty(env("PROTOCORE_RPC_TIMEOUT_SECONDS"), "1200"),
      TALOS_MACHINE_CONFIG_FILE: path.join(osConfigDir, "controlplane.yaml"),
      TALOSCONFIG_FILE: path.join(osConfigDir, "talosconfig"),
      REQUIRE_TALOS_API_PROBE: "true",
      REQUIRE_EXTENSION_SERVICE_CHECK: "true",
      REQUIRE_PROTOCORE_RPC_PROBE: "true",
      REQUIRE_ENROLLMENT_RUNTIME_PROOF: "true",
      REQUIRE_TPM_BINDING_RUNTIME_PROOF: "true",
      REQUIRE_SUBSTRATE_RUNTIME_PROOF: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipeChild(smoke, "os-smoke");

  try {
    await waitForFileOrExit(
      liveEnvPath,
      smoke,
      positiveIntegerMs(firstNonEmpty(options.smokeTimeoutMs, env("MONARCH_E2E_SMOKE_TIMEOUT_MS"), "1800000"), "OS smoke timeout"),
    );
    const smokeEnv = parseEnvFile(liveEnvPath);
    for (const key of [
      "MONARCH_OS_SMOKE_RESULT",
      "MONARCH_E2E_TALOS_ENDPOINT",
      "MONARCH_E2E_TALOSCONFIG",
      "MONARCH_E2E_RPC_ENDPOINT",
    ]) {
      if (!smokeEnv[key]) throw new Error(`OS smoke live env did not include ${key}`);
    }
    return { smoke, smokeEnv };
  } catch (err) {
    await stopChild(smoke);
    throw err;
  }
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--os-repo") out.osRepo = needArg(args, ++i, arg);
    else if (arg === "--os-config-dir") out.osConfigDir = needArg(args, ++i, arg);
    else if (arg === "--output") out.output = needArg(args, ++i, arg);
    else if (arg === "--app") out.app = needArg(args, ++i, arg);
    else if (arg === "--expected-rpc-endpoint") out.expectedRpcEndpoint = needArg(args, ++i, arg);
    else if (arg === "--expected-digest") out.expectedDigest = needArg(args, ++i, arg);
    else if (arg === "--cluster-id") out.clusterId = needArg(args, ++i, arg);
    else if (arg === "--cluster-name") out.clusterName = needArg(args, ++i, arg);
    else if (arg === "--chat-body") out.chatBody = needArg(args, ++i, arg);
    else if (arg === "--operator-mnemonic-file") out.operatorMnemonicFile = needArg(args, ++i, arg);
    else if (arg === "--peer-operator-mnemonic-file") out.peerOperatorMnemonicFile = needArg(args, ++i, arg);
    else if (arg === "--peer-chat-body") out.peerChatBody = needArg(args, ++i, arg);
    else if (arg === "--peer-wait-ms") out.peerWaitMs = needArg(args, ++i, arg);
    else if (arg === "--chat-bootstrap-peers") out.chatBootstrapPeers = needArg(args, ++i, arg);
    else if (arg === "--chat-bootstrap-peers-file") out.chatBootstrapPeersFile = needArg(args, ++i, arg);
    else if (arg === "--dkg-reshare-attestation") out.dkgReshareAttestation = needArg(args, ++i, arg);
    else if (arg === "--dkg-reshare-attestation-json") out.dkgReshareAttestationJson = needArg(args, ++i, arg);
    else if (arg === "--smoke-timeout-ms") out.smokeTimeoutMs = needArg(args, ++i, arg);
    else if (arg === "--build-app") out.buildApp = true;
    else if (arg === "--skip-smoke-config") out.skipSmokeConfig = true;
    else if (arg === "--allow-missing-bootstrap-peers") out.allowMissingBootstrapPeers = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return out;
}

function needArg(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: run-monarch-e2e.mjs [options]

Starts Monarch OS configured QEMU smoke with KEEP_QEMU_ALIVE=true, waits for
_out/smoke-qemu/live-env.sh, runs the Desktop Tauri e2e harness, then stops QEMU.

Options:
  --os-repo <path>      Monarch OS repo. Default: ${path.relative(ROOT, DEFAULT_OS_REPO)}
  --os-config-dir <dir> Smoke config dir relative to OS repo. Default: ${DEFAULT_OS_CONFIG_DIR}
  --build-app           Build a recorder-enabled debug Tauri app after OS smoke
                        exposes its live endpoints.
  --skip-smoke-config   Reuse an existing OS smoke config directory.
  --output <path>       Desktop evidence JSON output path.
  --app <path>          Built Tauri app binary for the Desktop harness.
  --expected-rpc-endpoint <url>
                         Live chain RPC endpoint Desktop should prove against.
                         Defaults to the local smoke RPC after explicit
                         MONARCH_E2E_* overrides, then generic app RPC env.
  --expected-digest <sha256>
                         Expected Protocore runtime digest. Defaults to the
                         Monarch OS smoke live env digest when release metadata exists.
  --cluster-id <id>     Cluster id used for chat evidence.
  --operator-mnemonic-file <path>
                         Ephemeral PQM-1 operator mnemonic file for chat evidence.
  --peer-operator-mnemonic-file <path>
                         Second PQM-1 mnemonic file used by the secondary window.
  --peer-chat-body <text>
                         Message body sent by the secondary window.
  --peer-wait-ms <ms>    Wait after secondary sends before primary collects readiness.
  --chat-bootstrap-peers <peers>
                         Comma/space-separated libp2p peers for chat evidence.
  --chat-bootstrap-peers-file <path>
                         File containing libp2p peers for chat evidence.
  --dkg-reshare-attestation <path>
                         OS-rendered monarch-dkg-reshare-attestation/v1 JSON.
  --dkg-reshare-attestation-json <json>
                         Inline monarch-dkg-reshare-attestation/v1 JSON.
  --allow-missing-bootstrap-peers
                         Do not fail solely on empty chat bootstrap peers.
                         Also enabled by MONARCH_E2E_ALLOW_DISCOVERED_CHAT_PEERS=true.
`);
}

async function waitForFileOrExit(file, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    if (child.exitCode !== null) {
      throw new Error(`OS smoke exited before writing ${file} (exit ${child.exitCode})`);
    }
    await delay(500);
  }
  throw new Error(`timed out waiting for OS smoke live env: ${file}`);
}

async function runChecked(command, args, options) {
  const code = await run(command, args, options);
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${code}`);
  }
}

async function run(command, args, options) {
  const child = childProcess.spawn(command, args, {
    ...options,
    stdio: "inherit",
  });
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function pipeChild(child, label) {
  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await waitForChildExit(child, 10_000);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await waitForChildExit(child, 5_000);
  }
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  return await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

async function stopSmokeVm(smokeEnv) {
  const smokeResult = smokeEnv?.MONARCH_OS_SMOKE_RESULT;
  if (!smokeResult) return;

  const pidFile = path.join(path.dirname(smokeResult), "qemu.pid");
  let rawPid = "";
  try {
    rawPid = fs.readFileSync(pidFile, "utf8").trim();
  } catch {
    return;
  }

  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(250);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The VM may have exited after the final liveness probe.
  }
}

function parseEnvFile(file) {
  const out = {};
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^export\s+([A-Z0-9_]+)=(.*)$/u);
    if (!match) continue;
    out[match[1]] = unquote(match[2]);
  }
  return out;
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function appendOptionalArg(args, flag, value) {
  if (value) args.push(flag, value);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function positiveIntegerMs(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer number of milliseconds`);
  }
  return parsed;
}

function assertDir(dir, label) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`${label} not found: ${dir}`);
  }
}

function env(name) {
  return process.env[name] || "";
}

function truthyEnv(name) {
  return /^(1|true|yes)$/iu.test(env(name).trim());
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
