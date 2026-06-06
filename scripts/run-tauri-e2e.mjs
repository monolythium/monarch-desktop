#!/usr/bin/env node
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_APP = path.join(ROOT, "src-tauri", "target", "debug", appBinaryName());
const DEFAULT_SMOKE = path.resolve(ROOT, "..", "monarch-os-talos", "_out", "smoke-qemu", "result.json");
const REQUIRED_ROUTES = readRequiredRoutes();

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const appPath = path.resolve(firstNonEmpty(options.app, env("MONARCH_DESKTOP_APP"), DEFAULT_APP));
const osSmokePath = path.resolve(firstNonEmpty(options.osSmoke, env("MONARCH_OS_SMOKE_RESULT"), DEFAULT_SMOKE));
const readinessPath = options.readiness
  ? path.resolve(options.readiness)
  : env("MONARCH_DESKTOP_READINESS_JSON")
    ? path.resolve(env("MONARCH_DESKTOP_READINESS_JSON"))
    : "";
const outputPath = path.resolve(
  firstNonEmpty(options.output, env("MONARCH_DESKTOP_E2E_OUTPUT"), path.join(ROOT, "_out", "monarch-desktop-e2e-evidence.json")),
);
const screenshotsDir = path.resolve(
  firstNonEmpty(
    options.screenshotsDir,
    env("MONARCH_DESKTOP_E2E_SCREENSHOTS_DIR"),
    path.join(path.dirname(outputPath), "monarch-desktop-e2e-screenshots"),
  ),
);
const driverUrl = new URL(firstNonEmpty(options.driverUrl, env("MONARCH_TAURI_DRIVER_URL"), "http://127.0.0.1:4444"));
const driverPort = portNumber(driverUrl, "Tauri driver port", 4444);
const nativePort = positivePort(
  firstNonEmpty(options.nativePort, env("MONARCH_TAURI_NATIVE_DRIVER_PORT"), String(driverPort + 1)),
  "Native WebDriver port",
);
const driverBin = firstNonEmpty(options.driver, env("MONARCH_TAURI_DRIVER"), "tauri-driver");
const externalDriver = options.externalDriver || env("MONARCH_TAURI_DRIVER_EXTERNAL") === "true";
const twoWindows = options.twoWindows ?? env("MONARCH_DESKTOP_E2E_TWO_WINDOWS") !== "false";
const secondaryDriverUrlInput = firstNonEmpty(options.secondaryDriverUrl, env("MONARCH_TAURI_SECONDARY_DRIVER_URL"));
const secondaryDriverUrl = new URL(secondaryDriverUrlInput || (externalDriver ? driverUrl.href : deriveDriverUrl(driverUrl, 2).href));
const secondaryDriverPort = portNumber(secondaryDriverUrl, "Secondary Tauri driver port", driverPort + 2);
const secondaryNativePort = positivePort(
  firstNonEmpty(options.secondaryNativePort, env("MONARCH_TAURI_SECONDARY_NATIVE_DRIVER_PORT"), String(secondaryDriverPort + 1)),
  "Secondary native WebDriver port",
);
const appVersion = firstNonEmpty(options.appVersion, env("MONARCH_DESKTOP_APP_VERSION"), packageVersion());
const commit = firstNonEmpty(options.commit, env("GITHUB_SHA"), gitCommit());
const timeoutMs = positiveIntegerMs(
  firstNonEmpty(options.timeoutMs, env("MONARCH_DESKTOP_E2E_TIMEOUT_MS"), "60000"),
  "Desktop e2e timeout",
);
const skipChatSend = options.skipChatSend || env("MONARCH_E2E_SKIP_CHAT_SEND") === "true";
const skipRestart = options.skipRestart || env("MONARCH_E2E_SKIP_RESTART") === "true";
const allowMissingBootstrapPeers =
  options.allowMissingBootstrapPeers ||
  truthyEnv("MONARCH_E2E_ALLOW_MISSING_BOOTSTRAP_PEERS") ||
  truthyEnv("MONARCH_E2E_ALLOW_DISCOVERED_CHAT_PEERS");
const operatorMnemonic = secretOption(
  options.operatorMnemonic,
  options.operatorMnemonicFile,
  env("MONARCH_E2E_OPERATOR_MNEMONIC"),
  env("MONARCH_E2E_OPERATOR_MNEMONIC_FILE"),
);
const peerOperatorMnemonic = secretOption(
  options.peerOperatorMnemonic,
  options.peerOperatorMnemonicFile,
  env("MONARCH_E2E_PEER_OPERATOR_MNEMONIC"),
  env("MONARCH_E2E_PEER_OPERATOR_MNEMONIC_FILE"),
);
const chatBootstrapPeers = listOption(
  options.chatBootstrapPeers,
  options.chatBootstrapPeersFile,
  env("MONARCH_E2E_CHAT_BOOTSTRAP_PEERS") || env("TAURI_CHAT_BOOTSTRAP_PEERS") || env("VITE_CHAT_BOOTSTRAP_PEERS"),
  env("MONARCH_E2E_CHAT_BOOTSTRAP_PEERS_FILE"),
);
const readinessOptions = {
  expectedChainId: numberOption(options.expectedChainId ?? env("MONARCH_EXPECTED_CHAIN_ID")),
  expectedRpcEndpoint: (options.expectedRpcEndpoint ?? env("MONARCH_E2E_RPC_ENDPOINT")) || undefined,
  protocoreRpcEndpoint: (options.protocoreRpcEndpoint ?? env("MONARCH_E2E_PROTOCORE_RPC_ENDPOINT")) || undefined,
  expectedDigest: (options.expectedDigest ?? env("MONARCH_E2E_EXPECTED_DIGEST")) || undefined,
  talosEndpoint: (options.talosEndpoint ?? env("MONARCH_E2E_TALOS_ENDPOINT")) || undefined,
  talosConfigPath: (options.talosConfigPath ?? env("MONARCH_E2E_TALOSCONFIG")) || undefined,
  trustTalosConfig: options.trustTalosConfig || env("MONARCH_E2E_TRUST_TALOS_CONFIG") === "true" || undefined,
  operatorMnemonic,
  chatBootstrapPeers,
  clusterId: numberOption(options.clusterId ?? env("MONARCH_E2E_CLUSTER_ID")),
  clusterName: (options.clusterName ?? env("MONARCH_E2E_CLUSTER_NAME")) || undefined,
  chatBody: (options.chatBody ?? env("MONARCH_E2E_CHAT_BODY")) || undefined,
  sendChatMessage: skipChatSend ? false : undefined,
  executeRestart: skipRestart ? false : undefined,
  requireBootstrapPeers: allowMissingBootstrapPeers ? false : undefined,
};
const peerWaitMs = positiveIntegerMs(firstNonEmpty(options.peerWaitMs, env("MONARCH_E2E_PEER_WAIT_MS"), "5000"), "Peer wait timeout");
const dkgReshareAttestationPath =
  options.dkgReshareAttestation ?? env("MONARCH_E2E_DKG_RESHARE_ATTESTATION_FILE");
const dkgReshareAttestationJson =
  options.dkgReshareAttestationJson ?? env("MONARCH_E2E_DKG_RESHARE_ATTESTATION");

await main().catch((err) => {
  console.error(errorMessage(err));
  process.exitCode = 1;
});

async function main() {
  assertFile(appPath, "Tauri app binary");
  assertFile(osSmokePath, "Monarch OS smoke result");
  if (readinessPath) assertFile(readinessPath, "Desktop readiness JSON");
  const dkgReshareAttestation = readJsonInput(
    dkgReshareAttestationPath,
    dkgReshareAttestationJson,
    "DKG re-share attestation JSON",
  );

  const osSmoke = readJson(osSmokePath);
  readinessOptions.expectedDigest = firstNonEmpty(
    readinessOptions.expectedDigest,
    stringField(osSmoke, "expected_protocore_digest"),
  ) || undefined;
  if (!readinessOptions.expectedDigest) {
    throw new Error("Expected Protocore digest missing; pass --expected-digest or use an OS smoke result with expected_protocore_digest.");
  }

  const driver = externalDriver ? null : startDriver(driverBin, driverUrl, nativePort);
  const secondaryDriver = !externalDriver && twoWindows ? startDriver(driverBin, secondaryDriverUrl, secondaryNativePort) : null;
  const sessions = [];

  try {
    await waitForDriver(driverUrl, timeoutMs);
    if (twoWindows) await waitForDriver(secondaryDriverUrl, timeoutMs);
    const primary = await createSession(driverUrl, appPath);
    sessions.push(primary);
    let secondary = null;
    if (twoWindows) {
      secondary = await createSession(secondaryDriverUrl, appPath);
      sessions.push(secondary);
    }

    await assertRecorder(primary);
    if (secondary) await assertRecorder(secondary);
    const windowsObserved = secondary ? 2 : 1;
    await setWindowsObserved(primary, windowsObserved);
    if (secondary) await setWindowsObserved(secondary, windowsObserved);

    fs.rmSync(screenshotsDir, { recursive: true, force: true });
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const routeScreenshots = await visitRoutes(primary, REQUIRED_ROUTES, screenshotsDir, path.dirname(outputPath));
    let discoveredChatBootstrapPeers = [];
    if (!readinessPath && peerOperatorMnemonic) {
      if (!secondary) throw new Error("peer chat evidence requires two Tauri windows");
      if (typeof readinessOptions.clusterId !== "number") {
        throw new Error("peer chat evidence requires --cluster-id or MONARCH_E2E_CLUSTER_ID");
      }
      const primaryProbe = await collectReadiness(primary, {
        ...readinessOptions,
        executeRestart: false,
        sendChatMessage: false,
      });
      discoveredChatBootstrapPeers = chatListenAddresses(primaryProbe);
      const peerReadinessOptions = withAdditionalChatBootstrapPeers(readinessOptions, discoveredChatBootstrapPeers);
      await collectReadiness(secondary, {
        ...peerReadinessOptions,
        operatorMnemonic: peerOperatorMnemonic,
        executeRestart: false,
        chatBody: (options.peerChatBody ?? env("MONARCH_E2E_PEER_CHAT_BODY")) || "monarch desktop e2e peer",
      });
      await delay(peerWaitMs);
    }
    const finalReadinessOptions = withAdditionalChatBootstrapPeers(readinessOptions, discoveredChatBootstrapPeers);
    const desktopReadiness = readinessPath
      ? readJson(readinessPath)
      : await collectReadiness(primary, finalReadinessOptions);
    const primarySnapshot = await snapshot(primary);
    const secondarySnapshot = secondary ? await snapshot(secondary) : emptySnapshot();
    const merged = mergeSnapshots(primarySnapshot, secondarySnapshot, windowsObserved);

    const evidence = {
      schema_version: "monarch-desktop-e2e-evidence/v1",
      source: {
        kind: "tauri-gui-e2e",
        runner: "tauri-driver",
        generated_at: new Date().toISOString(),
        app_version: appVersion,
        commit,
        windows_observed: merged.windowsObserved,
        routes_visited: merged.routesVisited,
        route_screenshots: routeScreenshots,
        commands_observed: merged.commandsObserved,
      },
      os_smoke: pickOsSmoke(osSmoke),
      dkg_reshare_attestation: dkgReshareAttestation,
      desktop_readiness: desktopReadiness,
    };

    const tempPath = `${outputPath}.tmp`;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(evidence, null, 2)}\n`);
    try {
      await verifyEvidence(tempPath);
      fs.renameSync(tempPath, outputPath);
      console.log(JSON.stringify({ ok: true, evidence: path.relative(process.cwd(), outputPath) || outputPath }));
    } catch (err) {
      fs.copyFileSync(tempPath, outputPath);
      throw err;
    }
  } finally {
    await Promise.allSettled(sessions.map((session) => deleteSession(session.driverUrl, session.id)));
    await Promise.allSettled([stopProcess(driver), stopProcess(secondaryDriver)]);
  }
}

function chatListenAddresses(readiness) {
  const addresses = readiness?.chat?.init?.listen_addresses;
  if (!Array.isArray(addresses)) return [];
  return addresses
    .filter((addr) => typeof addr === "string")
    .map((addr) => addr.trim())
    .filter(Boolean);
}

function withAdditionalChatBootstrapPeers(options, peers) {
  if (!Array.isArray(peers) || peers.length === 0) return options;
  const merged = [
    ...(Array.isArray(options.chatBootstrapPeers) ? options.chatBootstrapPeers : []),
    ...peers,
  ];
  return {
    ...options,
    chatBootstrapPeers: [...new Set(merged)],
  };
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--app") out.app = needArg(args, ++i, arg);
    else if (arg === "--os-smoke") out.osSmoke = needArg(args, ++i, arg);
    else if (arg === "--readiness") out.readiness = needArg(args, ++i, arg);
    else if (arg === "--output") out.output = needArg(args, ++i, arg);
    else if (arg === "--screenshots-dir") out.screenshotsDir = needArg(args, ++i, arg);
    else if (arg === "--driver") out.driver = needArg(args, ++i, arg);
    else if (arg === "--driver-url") out.driverUrl = needArg(args, ++i, arg);
    else if (arg === "--native-port") out.nativePort = needArg(args, ++i, arg);
    else if (arg === "--secondary-driver-url") out.secondaryDriverUrl = needArg(args, ++i, arg);
    else if (arg === "--secondary-native-port") out.secondaryNativePort = needArg(args, ++i, arg);
    else if (arg === "--app-version") out.appVersion = needArg(args, ++i, arg);
    else if (arg === "--commit") out.commit = needArg(args, ++i, arg);
    else if (arg === "--timeout-ms") out.timeoutMs = needArg(args, ++i, arg);
    else if (arg === "--expected-chain-id") out.expectedChainId = needArg(args, ++i, arg);
    else if (arg === "--expected-rpc-endpoint") out.expectedRpcEndpoint = needArg(args, ++i, arg);
    else if (arg === "--protocore-rpc-endpoint") out.protocoreRpcEndpoint = needArg(args, ++i, arg);
    else if (arg === "--expected-digest") out.expectedDigest = needArg(args, ++i, arg);
    else if (arg === "--talos-endpoint") out.talosEndpoint = needArg(args, ++i, arg);
    else if (arg === "--talos-config") out.talosConfigPath = needArg(args, ++i, arg);
    else if (arg === "--trust-talos-config") out.trustTalosConfig = true;
    else if (arg === "--operator-mnemonic") out.operatorMnemonic = needArg(args, ++i, arg);
    else if (arg === "--operator-mnemonic-file") out.operatorMnemonicFile = needArg(args, ++i, arg);
    else if (arg === "--peer-operator-mnemonic") out.peerOperatorMnemonic = needArg(args, ++i, arg);
    else if (arg === "--peer-operator-mnemonic-file") out.peerOperatorMnemonicFile = needArg(args, ++i, arg);
    else if (arg === "--peer-chat-body") out.peerChatBody = needArg(args, ++i, arg);
    else if (arg === "--peer-wait-ms") out.peerWaitMs = needArg(args, ++i, arg);
    else if (arg === "--chat-bootstrap-peers") out.chatBootstrapPeers = needArg(args, ++i, arg);
    else if (arg === "--chat-bootstrap-peers-file") out.chatBootstrapPeersFile = needArg(args, ++i, arg);
    else if (arg === "--dkg-reshare-attestation") out.dkgReshareAttestation = needArg(args, ++i, arg);
    else if (arg === "--dkg-reshare-attestation-json") out.dkgReshareAttestationJson = needArg(args, ++i, arg);
    else if (arg === "--cluster-id") out.clusterId = needArg(args, ++i, arg);
    else if (arg === "--cluster-name") out.clusterName = needArg(args, ++i, arg);
    else if (arg === "--chat-body") out.chatBody = needArg(args, ++i, arg);
    else if (arg === "--external-driver") out.externalDriver = true;
    else if (arg === "--one-window") out.twoWindows = false;
    else if (arg === "--skip-chat-send") out.skipChatSend = true;
    else if (arg === "--skip-restart") out.skipRestart = true;
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
  console.log(`Usage: run-tauri-e2e.mjs [options]

Options:
  --app <path>          Built Tauri app binary. Default: ${path.relative(ROOT, DEFAULT_APP)}
  --os-smoke <path>     Monarch OS smoke result JSON. Default: ${path.relative(ROOT, DEFAULT_SMOKE)}
  --readiness <path>    Existing Desktop readiness JSON. If omitted, collect it from the Tauri app.
  --output <path>       Evidence JSON output path.
  --screenshots-dir <path>
                         Directory for per-route PNG screenshots.
  --driver <path>       tauri-driver binary. Default: tauri-driver
  --driver-url <url>    WebDriver URL. Default: http://127.0.0.1:4444
  --native-port <port>  Native WebDriver port. Default: driver port + 1.
  --secondary-driver-url <url>
                         Second WebDriver URL. Default: primary driver port + 2.
  --secondary-native-port <port>
                         Second native WebDriver port. Default: secondary driver port + 1.
  --external-driver     Use an already-running tauri-driver.
  --one-window          Do not launch a second Tauri session.
  --expected-chain-id <id>
                         Expected live chain id. Default: 69420.
  --expected-rpc-endpoint <url>
                         RPC endpoint Desktop should prove against.
  --protocore-rpc-endpoint <url>
                         RPC endpoint used by the Talos Protocore readiness probe.
  --cluster-id <id>     Cluster channel id to join for chat evidence.
  --cluster-name <name> Optional display name when subscribing the cluster channel.
  --chat-body <text>    Message body to send during chat evidence collection.
  --expected-digest <sha256>
                         Expected Protocore binary digest for release attestation.
                         Defaults to os-smoke expected_protocore_digest when present.
  --talos-endpoint <url> Talos API endpoint to save before collecting readiness.
  --talos-config <path>  Talos config path to save before collecting readiness.
  --trust-talos-config   Pin the supplied talosconfig CA before privileged actions.
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
  --skip-restart        Do not submit ext-protocore restart during readiness collection.
  --skip-chat-send      Do not send a chat message during readiness collection.
  --allow-missing-bootstrap-peers
                         Do not fail Desktop readiness solely on empty chat bootstrap peers.
                         Also enabled by MONARCH_E2E_ALLOW_DISCOVERED_CHAT_PEERS=true.
`);
}

function startDriver(binary, baseUrl, driverNativePort) {
  const port = portNumber(baseUrl, "Tauri driver port", 4444);
  const child = childProcess.spawn(binary, [`--port=${port}`, `--native-port=${driverNativePort}`], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const label = `tauri-driver:${port}`;
  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.on("error", (err) => {
    console.error(`tauri-driver failed to start: ${errorMessage(err)}`);
  });
  return child;
}

async function waitForDriver(baseUrl, timeout) {
  const deadline = Date.now() + timeout;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      await webdriverRequest(baseUrl, "GET", "/status", undefined, 2_000);
      return;
    } catch (err) {
      lastError = errorMessage(err);
      await delay(250);
    }
  }
  throw new Error(`tauri-driver did not become ready at ${baseUrl.href}: ${lastError}`);
}

async function createSession(baseUrl, application) {
  const response = await webdriverRequest(baseUrl, "POST", "/session", {
    capabilities: {
      alwaysMatch: {
        "tauri:options": { application },
      },
    },
  }, timeoutMs);
  const value = response.value ?? response;
  const id = value.sessionId ?? response.sessionId;
  if (!id) throw new Error(`WebDriver session response did not include sessionId: ${JSON.stringify(response)}`);
  return { id, driverUrl: new URL(baseUrl.href) };
}

async function deleteSession(baseUrl, sessionId) {
  await webdriverRequest(baseUrl, "DELETE", `/session/${sessionId}`, undefined, 5_000).catch(() => undefined);
}

async function assertRecorder(session) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const present = await execute(session, "return Boolean(window.__MONARCH_E2E__);");
    if (present) return;
    await delay(250);
  }
  throw new Error(
    `Tauri app did not expose window.__MONARCH_E2E__; rebuild with VITE_MONARCH_E2E_RECORDER=true; ${await recorderDiagnostics(session)}`,
  );
}

async function recorderDiagnostics(session) {
  const details = await execute(
    session,
    `return {
      href: window.location.href,
      readyState: document.readyState,
      title: document.title,
      bodyText: (document.body?.innerText || "").slice(0, 300),
      monarchKeys: Object.keys(window).filter((key) => key.includes("MONARCH")).slice(0, 20),
      scripts: Array.from(document.scripts).map((script) => script.src || "[inline]").slice(0, 20),
    };`,
  ).catch((err) => ({ error: errorMessage(err) }));
  return `diagnostics=${JSON.stringify(details)}`;
}

async function setWindowsObserved(session, count) {
  await execute(session, "window.__MONARCH_E2E__.setWindowsObserved(arguments[0]); return true;", [count]);
}

async function visitRoutes(session, routes, screenshotDir, evidenceDir) {
  const screenshots = [];
  for (const route of routes) {
    const href = route.replace(/"/gu, '\\"');
    const element = await findElement(session, `a[href="${href}"]`);
    await clickElement(session, element);
    await waitForPath(session, route);
    await delay(200);
    screenshots.push(await captureRouteScreenshot(session, route, screenshotDir, evidenceDir));
  }
  return screenshots;
}

async function waitForPath(session, route) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await execute(session, "return window.location.pathname;");
    if (current === route) return;
    await delay(100);
  }
  throw new Error(`route did not become active: ${route}`);
}

async function findElement(session, selector) {
  const response = await sessionRequest(session, "POST", "/element", {
    using: "css selector",
    value: selector,
  });
  const value = response.value ?? response;
  const element = value["element-6066-11e4-a52e-4f735466cecf"] ?? value.ELEMENT;
  if (!element) throw new Error(`element not found for selector ${selector}: ${JSON.stringify(response)}`);
  return element;
}

async function clickElement(session, elementId) {
  await sessionRequest(session, "POST", `/element/${elementId}/click`, {});
}

async function execute(session, script, args = []) {
  const response = await sessionRequest(session, "POST", "/execute/sync", { script, args });
  return response.value;
}

async function snapshot(session) {
  return await execute(session, "return window.__MONARCH_E2E__.snapshot();");
}

async function captureRouteScreenshot(session, route, screenshotDir, evidenceDir) {
  const response = await sessionRequest(session, "GET", "/screenshot", undefined);
  const encoded = typeof response.value === "string" ? response.value : "";
  if (!encoded) {
    throw new Error(`screenshot response for ${route} did not include a base64 PNG`);
  }

  const bytes = Buffer.from(encoded, "base64");
  const dimensions = pngDimensions(bytes);
  if (!dimensions) {
    throw new Error(`screenshot response for ${route} is not a PNG`);
  }

  const file = path.join(screenshotDir, `${routeSlug(route)}.png`);
  fs.writeFileSync(file, bytes);
  const relative = slashPath(path.relative(evidenceDir, file));
  if (!isSafeRelativePngPath(relative)) {
    throw new Error(`screenshot path for ${route} must stay under the evidence directory`);
  }

  return {
    route,
    path: relative,
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
    width: dimensions.width,
    height: dimensions.height,
  };
}

async function collectReadiness(session, options) {
  const result = await executeAsync(
    session,
    `const done = arguments[arguments.length - 1];
     if (!window.__MONARCH_E2E__?.collectReadiness) {
       done({ __monarch_error: "window.__MONARCH_E2E__.collectReadiness is unavailable" });
       return;
     }
     window.__MONARCH_E2E__.collectReadiness(arguments[0])
       .then((value) => done({ value }))
       .catch((err) => done({ __monarch_error: err?.message ?? String(err) }));`,
    [options],
  );
  if (result?.__monarch_error) {
    throw new Error(result.__monarch_error);
  }
  return result.value;
}

async function sessionRequest(session, method, route, body) {
  return await webdriverRequest(session.driverUrl, method, `/session/${session.id}${route}`, body, timeoutMs);
}

async function webdriverRequest(baseUrl, method, route, body, timeout) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const url = new URL(route, baseUrl);
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message = json?.value?.message ?? json?.message ?? text;
      throw new Error(`${method} ${route} failed (${response.status}): ${message}`);
    }
    if (json?.value?.error) {
      throw new Error(`${method} ${route} failed: ${json.value.message ?? json.value.error}`);
    }
    return json;
  } finally {
    clearTimeout(id);
  }
}

async function executeAsync(session, script, args = []) {
  const response = await sessionRequest(session, "POST", "/execute/async", { script, args });
  return response.value;
}

async function verifyEvidence(file) {
  await new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [path.join(ROOT, "scripts", "verify-release-e2e-evidence.mjs"), file], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`e2e evidence verifier failed with exit code ${code}`));
    });
    child.on("error", reject);
  });
}

function pickOsSmoke(value) {
  return {
    status: stringField(value, "status"),
    raw_image: stringField(value, "raw_image"),
    talos_api_probe: stringField(value, "talos_api_probe"),
    require_talos_api_probe: value.require_talos_api_probe,
    machine_config_applied: value.machine_config_applied,
    extension_service_name: stringField(value, "extension_service_name"),
    extension_service_check: stringField(value, "extension_service_check"),
    protocore_rpc_probe: stringField(value, "protocore_rpc_probe"),
    substrate_runtime_proof: stringField(value, "substrate_runtime_proof"),
    release_metadata: stringField(value, "release_metadata"),
    expected_protocore_digest: stringField(value, "expected_protocore_digest"),
  };
}

function mergeSnapshots(primary, secondary, windowsObserved) {
  const routes = new Set([...arrayField(primary, "routesVisited"), ...arrayField(secondary, "routesVisited")]);
  const commands = new Set([...arrayField(primary, "commandsObserved"), ...arrayField(secondary, "commandsObserved")]);
  return {
    routesVisited: Array.from(routes).sort(),
    commandsObserved: Array.from(commands),
    windowsObserved,
  };
}

function emptySnapshot() {
  return { routesVisited: [], commandsObserved: [], windowsObserved: 0 };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readRequiredRoutes() {
  const file = path.join(ROOT, "src", "nav", "e2eRequiredRoutes.json");
  const routes = readJson(file);
  if (!Array.isArray(routes) || routes.some((route) => typeof route !== "string" || !route.startsWith("/"))) {
    throw new Error(`required route manifest is invalid: ${file}`);
  }
  return routes;
}

function routeSlug(route) {
  const slug = route === "/" ? "root" : route.slice(1);
  return slug.replace(/[^a-z0-9._-]+/giu, "_") || "route";
}

function slashPath(value) {
  return value.split(path.sep).join("/");
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

function readJsonInput(file, rawJson, label) {
  if (file) {
    const resolved = path.resolve(file);
    assertFile(resolved, label);
    return readJson(resolved);
  }
  if (rawJson) {
    try {
      return JSON.parse(rawJson);
    } catch (err) {
      throw new Error(`${label} is not valid JSON: ${errorMessage(err)}`);
    }
  }
  throw new Error(
    `${label} is required; pass --dkg-reshare-attestation, --dkg-reshare-attestation-json, MONARCH_E2E_DKG_RESHARE_ATTESTATION_FILE, or MONARCH_E2E_DKG_RESHARE_ATTESTATION`,
  );
}

function assertFile(file, label) {
  if (!file || !fs.existsSync(file)) throw new Error(`${label} not found: ${file || "(unset)"}`);
}

function packageVersion() {
  return readJson(path.join(ROOT, "package.json")).version;
}

function gitCommit() {
  const result = childProcess.spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function appBinaryName() {
  return os.platform() === "win32" ? "monarch-desktop.exe" : "monarch-desktop";
}

function stringField(value, key) {
  return typeof value?.[key] === "string" ? value[key] : "";
}

function arrayField(value, key) {
  return Array.isArray(value?.[key]) ? value[key].filter((item) => typeof item === "string") : [];
}

function env(name) {
  return process.env[name] || "";
}

function truthyEnv(name) {
  return /^(1|true|yes)$/iu.test(env(name).trim());
}

function secretOption(value, file, envValue, envFile) {
  if (file) return readSecretFile(path.resolve(file));
  if (value) return value;
  if (envFile) return readSecretFile(path.resolve(envFile));
  return envValue || undefined;
}

function readSecretFile(file) {
  assertFile(file, "Secret file");
  return fs.readFileSync(file, "utf8").trim();
}

function listOption(value, file, envValue, envFile) {
  const raw = file
    ? fs.readFileSync(path.resolve(file), "utf8")
    : value
      ? value
      : envFile
        ? fs.readFileSync(path.resolve(envFile), "utf8")
        : envValue;
  if (!raw) return undefined;
  const items = raw
    .split(/[\s,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function numberOption(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function deriveDriverUrl(baseUrl, portOffset) {
  const next = new URL(baseUrl.href);
  next.port = String(portNumber(baseUrl, "Tauri driver port", 4444) + portOffset);
  return next;
}

function portNumber(url, label, fallback) {
  const raw = url.port || String(fallback);
  return positivePort(raw, label);
}

function positivePort(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${label} must be a TCP port number`);
  }
  return parsed;
}

function positiveIntegerMs(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer number of milliseconds`);
  }
  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(5_000).then(() => false),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
