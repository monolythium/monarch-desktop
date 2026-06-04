#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

const INCLUDE_PATHS = [
  ".github/workflows",
  "docs/final-product-readiness.md",
  "package.json",
  "README.md",
  "scripts",
  "src",
  "src-tauri/src",
  "src-tauri/tauri.conf.json",
];

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".json",
  ".js",
  ".jsx",
  ".md",
  ".mjs",
  ".rs",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml",
]);

const SKIP_DIRS = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

const SKIP_FILE_PATTERNS = [
  /^docs\/local-/u,
  /^scripts\/check-release-terminology\.mjs$/u,
  /(^|\/)__snapshots__(\/|$)/u,
  /(^|\/)__fixtures__(\/|$)/u,
  /(^|\/)fixtures(\/|$)/u,
  /\.(?:test|spec)\.(?:cjs|js|jsx|mjs|ts|tsx)$/u,
  /\.d\.ts$/u,
];

const isRuntimeSource = (relativePath) =>
  relativePath.startsWith("src/") || relativePath.startsWith("src-tauri/src/");

const isSkipped = (relativePath) =>
  SKIP_FILE_PATTERNS.some((pattern) => pattern.test(relativePath));

function collectFiles(entryPath, output) {
  const fullPath = path.join(ROOT, entryPath);
  if (!existsSync(fullPath)) return;

  const stats = statSync(fullPath);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(fullPath, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      collectFiles(path.join(entryPath, entry.name), output);
    }
    return;
  }

  if (!stats.isFile()) return;

  const relativePath = entryPath.split(path.sep).join("/");
  if (isSkipped(relativePath)) return;

  const extension = path.extname(relativePath);
  if (!TEXT_EXTENSIONS.has(extension)) return;

  output.push(relativePath);
}

const ALLOWLIST = [
  {
    path: "README.md",
    reason: "preview status explains that removed fixture paths stay removed",
    line: /Production-looking fixtures were removed|does not ship canned operational answers|instead of fabricating/u,
  },
  {
    path: "docs/final-product-readiness.md",
    reason: "readiness doc explicitly describes removed non-live behavior",
    line: /mock data for production decisions|canned operational incidents|named blockers instead of fabricated values|local fixtures|No production-looking screen renders fabricated/u,
  },
  {
    path: "src/views/Hardware.tsx",
    reason: "UI explains that absent endpoints are not backfilled with invented telemetry",
    line: /not fabricated when the endpoint is absent/u,
  },
  {
    path: "src/sdk/hooks.ts",
    reason: "source comment documents named blockers instead of non-live fixtures",
    line: /named blockers instead of production-looking fixtures/u,
  },
  {
    path: "src/sdk/useLogStream.ts",
    reason: "source comment documents no fabricated log fallback",
    line: /renders no fake log lines/u,
  },
  {
    path: "src/sdk/bridge.ts",
    reason: "source comments document no fabricated browser fallback",
    line: /without fabricating node data|no local lines are fabricated|renders without fabricated messages/u,
  },
];

const RULES = [
  {
    id: "open-implementation-marker",
    description: "release surfaces must not carry open implementation markers",
    include: () => true,
    pattern: /\b(?:STUB|TODO|FIXME)\b/u,
  },
  {
    id: "fabricated-runtime-copy",
    description: "runtime source must not present non-live or placeholder product content",
    include: isRuntimeSource,
    pattern:
      /\b(?:mockup|mock-up|placeholder content|fake data|fake values?|stubbed|canned operational|fabricated (?:chain|operator|cluster|log|hardware|message|messages|metric|metrics|network|telemetry|value|values))\b/iu,
  },
  {
    id: "retired-chain-role",
    description: "release copy must avoid obsolete chain-role labels",
    include: () => true,
    pattern: /\b(?:masternode|miner|mining rig|validator node|validator duty)\b/iu,
  },
  {
    id: "internal-bridge-vendor",
    description: "release copy must use generic bridge route/verifier language",
    include: () => true,
    pattern: /\b(?:Chainlink|CCIP|LayerZero|Wormhole|Axelar|IBC|Inter-Blockchain Communication)\b/u,
  },
];

function isAllowed(file, line) {
  return ALLOWLIST.some((entry) => entry.path === file && entry.line.test(line));
}

const files = [];
for (const entryPath of INCLUDE_PATHS) {
  collectFiles(entryPath, files);
}
files.sort();

const violations = [];
for (const file of files) {
  const contents = readFileSync(path.join(ROOT, file), "utf8");
  const lines = contents.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isAllowed(file, line)) continue;
    for (const rule of RULES) {
      if (!rule.include(file)) continue;
      if (!rule.pattern.test(line)) continue;
      violations.push({
        file,
        lineNumber: index + 1,
        line: line.trim(),
        rule,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("release terminology check failed:");
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.lineNumber}: [${violation.rule.id}] ${violation.line}`,
    );
    console.error(`  ${violation.rule.description}`);
  }
  process.exit(1);
}

console.log(`release terminology check ok: scanned ${files.length} files`);
