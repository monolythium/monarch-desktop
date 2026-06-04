#!/usr/bin/env node
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const REQUIRED_ROUTES = readJson(path.join(ROOT, "src", "nav", "e2eRequiredRoutes.json"));
const DEFAULT_OUTPUT = path.join(ROOT, "_out", "monarch-desktop-browser-smoke.json");
const DEFAULT_SCREENSHOTS_DIR = path.join(ROOT, "_out", "monarch-desktop-browser-smoke-screenshots");
const DEFAULT_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 960, mobile: false },
  { name: "narrow", width: 390, height: 844, mobile: true },
];

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

async function main() {
  const routes = options.routes.length > 0 ? options.routes : REQUIRED_ROUTES;
  const viewports = options.viewports.length > 0 ? options.viewports : DEFAULT_VIEWPORTS;
  assertRoutes(routes);
  assertViewports(viewports);

  const outputPath = path.resolve(options.output ?? env("MONARCH_BROWSER_SMOKE_OUTPUT") ?? DEFAULT_OUTPUT);
  const screenshotsDir = path.resolve(
    options.screenshotsDir ?? env("MONARCH_BROWSER_SMOKE_SCREENSHOTS_DIR") ?? DEFAULT_SCREENSHOTS_DIR,
  );
  const browser = options.browser ?? env("MONARCH_BROWSER") ?? findBrowser();
  if (!browser) {
    throw new Error("Chromium/Chrome binary not found; set MONARCH_BROWSER or pass --browser");
  }

  const server = await startOrUseServer(options);
  const browserSession = await startBrowser(browser, options);
  const blockers = [];
  const routeResults = [];

  try {
    const target = await openTarget(browserSession.port, "about:blank");
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable").catch(() => undefined);

    const pageIssues = [];
    cdp.on("Runtime.exceptionThrown", (event) => {
      pageIssues.push({
        kind: "exception",
        text: event?.exceptionDetails?.text ?? "Runtime exception",
      });
    });
    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (event?.type !== "error" && event?.type !== "assert") return;
      const text = (event.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? "")
        .filter(Boolean)
        .join(" ");
      pageIssues.push({ kind: "console", text: text || event.type });
    });
    cdp.on("Log.entryAdded", (event) => {
      const entry = event?.entry;
      if (!entry || entry.level !== "error") return;
      pageIssues.push({ kind: "log", text: entry.text || "Browser log error" });
    });

    fs.rmSync(screenshotsDir, { recursive: true, force: true });
    fs.mkdirSync(screenshotsDir, { recursive: true });

    for (const viewport of viewports) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.mobile,
      });
      for (const route of routes) {
        pageIssues.length = 0;
        const url = new URL(route, server.url).href;
        await navigate(cdp, url, options.timeoutMs);
        await waitForApp(cdp, route, options.timeoutMs);
        await settle(cdp);

        const routeCheck = await evaluateRoute(cdp, route);
        const fatalIssues = pageIssues.filter((issue) => !isExpectedUnavailableIssue(issue.text));
        for (const issue of fatalIssues) {
          routeCheck.blockers.push(`${issue.kind}: ${issue.text}`);
        }

        const screenshot = await captureScreenshot(cdp, {
          route,
          viewport,
          screenshotsDir,
          outputDir: path.dirname(outputPath),
        });
        routeResults.push({
          route,
          viewport: viewport.name,
          title: routeCheck.title,
          content_chars: routeCheck.contentChars,
          active_nav: routeCheck.activeNav,
          screenshot,
          warnings: routeCheck.warnings,
          blockers: routeCheck.blockers,
        });
        for (const blocker of routeCheck.blockers) {
          blockers.push(`${viewport.name} ${route}: ${blocker}`);
        }
      }
    }
  } finally {
    await stopBrowser(browserSession);
    await stopServer(server);
  }

  const evidence = {
    schema_version: "monarch-desktop-browser-smoke/v1",
    source: {
      kind: "browser-route-smoke",
      runner: "chromium-devtools",
      generated_at: new Date().toISOString(),
      commit: options.commit ?? env("GITHUB_SHA") ?? gitCommit(),
      app_version: packageVersion(),
      dev_server_url: server.url,
    },
    viewports,
    routes: routeResults,
    blockers,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);

  if (blockers.length > 0) {
    const shown = blockers.slice(0, 20).map((item) => `- ${item}`).join("\n");
    const suffix = blockers.length > 20 ? `\n- ... ${blockers.length - 20} more` : "";
    throw new Error(`browser route smoke failed:\n${shown}${suffix}\nEvidence: ${outputPath}`);
  }

  console.log(JSON.stringify({
    ok: true,
    evidence: path.relative(process.cwd(), outputPath) || outputPath,
    routes: routes.length,
    viewports: viewports.length,
  }));
}

function parseArgs(args) {
  const out = { routes: [], viewports: [], timeoutMs: 20_000 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--output") out.output = needArg(args, ++i, arg);
    else if (arg === "--screenshots-dir") out.screenshotsDir = needArg(args, ++i, arg);
    else if (arg === "--browser") out.browser = needArg(args, ++i, arg);
    else if (arg === "--server-url") out.serverUrl = needArg(args, ++i, arg);
    else if (arg === "--host") out.host = needArg(args, ++i, arg);
    else if (arg === "--port") out.port = Number(needArg(args, ++i, arg));
    else if (arg === "--timeout-ms") out.timeoutMs = Number(needArg(args, ++i, arg));
    else if (arg === "--commit") out.commit = needArg(args, ++i, arg);
    else if (arg === "--route") out.routes.push(needArg(args, ++i, arg));
    else if (arg === "--viewport") out.viewports.push(parseViewport(needArg(args, ++i, arg)));
    else if (arg === "--headed") out.headed = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return out;
}

function parseViewport(value) {
  const [namePart, sizePart] = value.includes(":") ? value.split(":", 2) : ["custom", value];
  const match = /^([1-9][0-9]*)x([1-9][0-9]*)$/u.exec(sizePart);
  if (!match) throw new Error(`invalid viewport ${value}; expected name:WIDTHxHEIGHT`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  return { name: namePart || `${width}x${height}`, width, height, mobile: width < 600 };
}

function needArg(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: run-browser-route-smoke.mjs [options]

Starts Vite, opens Chromium through the DevTools protocol, visits every required
Monarch Desktop route at desktop and narrow widths, captures screenshots, and
fails on render, navigation, runtime, or obvious text-overflow blockers.

Options:
  --server-url <url>        Reuse an existing dev server instead of starting Vite.
  --output <path>           Evidence JSON path. Default: ${path.relative(ROOT, DEFAULT_OUTPUT)}
  --screenshots-dir <path>  Screenshot output directory.
  --browser <path>          Chromium/Chrome binary. Also reads MONARCH_BROWSER.
  --route <path>            Limit to one route; repeatable.
  --viewport <name:WxH>     Limit/add viewport; repeatable.
  --port <port>             Vite port when starting a server.
  --timeout-ms <ms>         Per-navigation timeout. Default: 20000.
  --headed                  Run the browser with a visible window.
`);
}

async function startOrUseServer(options) {
  if (options.serverUrl) {
    const url = withTrailingSlash(options.serverUrl);
    await waitForHttp(url, Number(options.timeoutMs));
    return { url, child: null };
  }

  const host = options.host ?? "127.0.0.1";
  const port = Number.isSafeInteger(options.port) && options.port > 0 ? options.port : await freePort();
  const url = `http://${host}:${port}/`;
  const child = childProcess.spawn("pnpm", ["exec", "vite", "--host", host, "--port", String(port), "--strictPort"], {
    cwd: ROOT,
    env: {
      ...process.env,
      VITE_MONARCH_E2E_RECORDER: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  prefixChild(child, "vite");
  await waitForHttp(url, Number(options.timeoutMs));
  return { url, child };
}

async function stopServer(server) {
  if (!server.child) return;
  await stopProcess(server.child);
}

async function startBrowser(browser, options) {
  const port = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "monarch-browser-smoke-"));
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--window-size=1440,960",
    "about:blank",
  ];
  if (!options.headed) args.unshift("--headless=new");
  const child = childProcess.spawn(browser, args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  prefixChild(child, "browser", { silent: true });
  await waitForDevtools(port, Number(options.timeoutMs));
  return { child, port, userDataDir };
}

async function stopBrowser(session) {
  await stopProcess(session.child);
  fs.rmSync(session.userDataDir, { recursive: true, force: true });
}

async function openTarget(port, url) {
  const encoded = encodeURIComponent(url);
  let response = await fetch(`http://127.0.0.1:${port}/json/new?${encoded}`, { method: "PUT" });
  if (!response.ok) {
    response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) throw new Error(`DevTools target list failed: HTTP ${response.status}`);
    const targets = await response.json();
    const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (!page) throw new Error("DevTools did not expose a page target");
    return page;
  }
  return await response.json();
}

async function navigate(cdp, url, timeoutMs) {
  const loaded = cdp.waitFor("Page.loadEventFired", () => true, timeoutMs);
  await cdp.send("Page.navigate", { url });
  await loaded.catch(() => undefined);
}

async function waitForApp(cdp, route, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const result = await cdp.evaluate(`
      ({
        path: window.location.pathname,
        ready: document.readyState,
        shell: Boolean(document.querySelector(".monarch-shell")),
        content: Boolean(document.querySelector("main.monarch-content")),
        rootText: (document.querySelector("#root")?.textContent || "").trim().length
      })
    `);
    last = JSON.stringify(result);
    if (result?.path === route && result.shell && result.content && result.rootText > 0) return;
    await delay(100);
  }
  throw new Error(`route ${route} did not render before timeout; last state ${last}`);
}

async function settle(cdp) {
  await cdp.evaluate(`
    new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })
  `, { awaitPromise: true });
  await delay(100);
}

async function evaluateRoute(cdp, expectedRoute) {
  return await cdp.evaluate(`
    (() => {
      const blockers = [];
      const warnings = [];
      const main = document.querySelector("main.monarch-content");
      const title = (document.querySelector(".view__title")?.textContent || document.querySelector("h1")?.textContent || "").trim();
      const contentText = (main?.innerText || "").trim();
      const activeNav = Array.from(document.querySelectorAll(".monarch-sidenav__item--active, a[aria-current='page']"))
        .map((item) => (item.textContent || "").replace(/\\s+/g, " ").trim())
        .filter(Boolean);

      if (window.location.pathname !== ${JSON.stringify(expectedRoute)}) {
        blockers.push("location path mismatch: " + window.location.pathname);
      }
      if (!document.querySelector(".monarch-shell")) blockers.push("shell did not render");
      if (!main) blockers.push("main content did not render");
      if (!title) blockers.push("route title is missing");
      if (contentText.length < 40) blockers.push("route content is too sparse");
      if (activeNav.length === 0) blockers.push("active navigation state is missing");

      const brokenImages = Array.from(document.images)
        .filter((img) => img.complete && img.naturalWidth === 0 && img.naturalHeight === 0)
        .map((img) => img.currentSrc || img.src || "image");
      for (const image of brokenImages) blockers.push("broken image: " + image);

      const overflow = findObviousTextOverflow();
      for (const item of overflow.slice(0, 12)) blockers.push(item);
      if (overflow.length > 12) warnings.push((overflow.length - 12) + " more text-overflow candidates");

      const horizontalCulprits = findHorizontalOverflow();
      if (horizontalCulprits.length > 0) {
        blockers.push("visible content spills horizontally: " + horizontalCulprits.slice(0, 4).join("; "));
        if (horizontalCulprits.length > 4) warnings.push((horizontalCulprits.length - 4) + " more horizontal-overflow candidates");
      }

      return {
        title,
        contentChars: contentText.length,
        activeNav,
        warnings,
        blockers,
      };

      function findObviousTextOverflow() {
        const selectors = [
          "button",
          "a",
          ".btn",
          ".ops-card",
          ".card__head h3",
          ".view__title",
          ".view__subtitle",
          ".stat__value",
          ".stat__sub",
          ".kv__v",
          ".drawer__head h2",
          ".cmdk-item__label",
          ".cmdk-item__sub"
        ].join(",");
        return Array.from(document.querySelectorAll(selectors)).flatMap((el) => {
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return [];
          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) return [];
          if (style.overflowX === "hidden" || style.textOverflow === "ellipsis") return [];
          if (el.scrollWidth <= el.clientWidth + 2) return [];
          const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
          if (!text) return [];
          return [cssPath(el) + " text overflows by " + (el.scrollWidth - el.clientWidth) + "px: " + text.slice(0, 80)];
        });
      }

      function cssPath(el) {
        if (el.id) return "#" + el.id;
        const cls = Array.from(el.classList || []).slice(0, 3).join(".");
        return el.tagName.toLowerCase() + (cls ? "." + cls : "");
      }

      function findHorizontalOverflow() {
        const vw = window.innerWidth;
        return Array.from(document.body.querySelectorAll("*")).flatMap((el) => {
          if (el.closest(".drawer:not(.is-open), .askrail:not(.is-open), .drawer-mask:not(.is-open), .askrail-mask:not(.is-open)")) {
            return [];
          }
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return [];
          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) return [];
          if (hasViewportBoundScrollContainer(el, vw)) return [];
          const excess = Math.max(0, Math.ceil(rect.right - vw), Math.ceil(-rect.left));
          if (excess <= 2) return [];
          return [{
            excess,
            label: cssPath(el) + " +" + excess + "px [" + Math.round(rect.left) + "," + Math.round(rect.right) + "]",
          }];
        }).sort((a, b) => b.excess - a.excess).map((item) => item.label);
      }

      function hasViewportBoundScrollContainer(el, vw) {
        for (let node = el.parentElement; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.overflowX !== "auto" && style.overflowX !== "scroll") continue;
          if (node.scrollWidth <= node.clientWidth + 2) continue;
          const rect = node.getBoundingClientRect();
          if (rect.left >= -2 && rect.right <= vw + 2) return true;
        }
        return false;
      }
    })()
  `);
}

async function captureScreenshot(cdp, { route, viewport, screenshotsDir, outputDir }) {
  const response = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(response.data, "base64");
  const dimensions = pngDimensions(bytes);
  if (!dimensions) throw new Error(`screenshot for ${viewport.name} ${route} is not a PNG`);

  const file = path.join(screenshotsDir, viewport.name, `${routeSlug(route)}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  const relative = slashPath(path.relative(outputDir, file));
  return {
    path: relative,
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
    width: dimensions.width,
    height: dimensions.height,
  };
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", (event) => this.handleMessage(event));
    ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("DevTools websocket closed"));
      this.pending.clear();
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`failed to connect to DevTools websocket: ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  on(method, handler) {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  async send(method, params = {}) {
    const id = ++this.id;
    const payload = JSON.stringify({ id, method, params });
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(payload);
    return await promise;
  }

  async evaluate(expression, options = {}) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: Boolean(options.awaitPromise),
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return response.result?.value;
  }

  waitFor(method, predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      const handler = (event) => {
        if (!predicate(event)) return;
        cleanup();
        resolve(event);
      };
      const cleanup = () => {
        clearTimeout(timer);
        const list = this.handlers.get(method) ?? [];
        this.handlers.set(method, list.filter((item) => item !== handler));
      };
      this.on(method, handler);
    });
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    const handlers = this.handlers.get(message.method) ?? [];
    for (const handler of handlers) handler(message.params ?? {});
  }
}

function isExpectedUnavailableIssue(text) {
  return /ERR_CONNECTION_REFUSED|Failed to fetch|NetworkError|Load failed|404 \(Not Found\)|127\\.0\\.0\\.1:8545|127\\.0\\.0\\.1:1420|__TAURI__|window\\.__TAURI__|Tauri/i.test(text);
}

function assertRoutes(routes) {
  if (!Array.isArray(routes) || routes.length === 0) throw new Error("at least one route is required");
  const known = new Set(REQUIRED_ROUTES);
  for (const route of routes) {
    if (typeof route !== "string" || !route.startsWith("/")) throw new Error(`invalid route: ${route}`);
    if (!known.has(route)) throw new Error(`route is not in e2eRequiredRoutes.json: ${route}`);
  }
}

function assertViewports(viewports) {
  for (const viewport of viewports) {
    if (!viewport.name || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) {
      throw new Error(`invalid viewport: ${JSON.stringify(viewport)}`);
    }
    if (viewport.width < 320 || viewport.height < 240) {
      throw new Error(`viewport ${viewport.name} is below 320x240`);
    }
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function findBrowser() {
  for (const candidate of [
    "/snap/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (err) {
      last = errorMessage(err);
    }
    await delay(150);
  }
  throw new Error(`timed out waiting for ${url}: ${last}`);
}

async function waitForDevtools(port, timeoutMs) {
  await waitForHttp(`http://127.0.0.1:${port}/json/version`, timeoutMs);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("failed to allocate a free port");
  return port;
}

function prefixChild(child, label, options = {}) {
  if (!options.silent) {
    child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  }
  child.on("error", (err) => {
    if (!options.silent) process.stderr.write(`[${label}] ${errorMessage(err)}\n`);
  });
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

function pngDimensions(bytes) {
  if (bytes.length < 24) return null;
  if (bytes.toString("ascii", 1, 4) !== "PNG") return null;
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function routeSlug(route) {
  return route === "/" ? "root" : route.replace(/^\//u, "").replace(/[^a-z0-9_-]+/giu, "-");
}

function slashPath(value) {
  return value.split(path.sep).join("/");
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function packageVersion() {
  return readJson(path.join(ROOT, "package.json")).version ?? "0.0.0";
}

function gitCommit() {
  const result = childProcess.spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function withTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function env(key) {
  return process.env[key] || undefined;
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

await main().catch((err) => {
  console.error(errorMessage(err));
  process.exitCode = 1;
});
