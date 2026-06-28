#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const REQUIRED_PLATFORMS = [
  {
    key: "darwin-aarch64",
    bundle: [/aarch64.*\.app\.tar\.gz$/u],
    installers: [[/aarch64.*\.dmg$/u]],
  },
  {
    key: "darwin-x86_64",
    bundle: [/(x86_64|x64).*\.app\.tar\.gz$/u],
    installers: [[/(x86_64|x64).*\.dmg$/u]],
  },
  {
    key: "linux-x86_64",
    bundle: [/\.AppImage\.tar\.gz$/u],
    installers: [[/\.AppImage$/u], [/\.deb$/u]],
  },
  {
    key: "windows-x86_64",
    bundle: [/\.nsis\.zip$/u],
    installers: [[/-setup\.exe$/u], [/\.msi$/u]],
  },
];

function usage() {
  console.error("usage: verify-release-artifacts.mjs <artifact-dir> [--tag vX.Y.Z]");
  process.exit(2);
}

const args = process.argv.slice(2);
if (args[0] === "--") {
  args.shift();
}
const dirArg = args.shift();
if (!dirArg) usage();

let tag = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--tag") {
    tag = args[i + 1] ?? "";
    i += 1;
    continue;
  }
  usage();
}

const artifactDir = path.resolve(dirArg);
const fail = (message) => {
  console.error(`release artifact verification failed: ${message}`);
  process.exit(1);
};

// Opt-in: a platform whose build is externally blocked (e.g. macOS notarization
// failing on an expired Apple Developer agreement) can be skipped via
// ALLOW_MISSING_PLATFORMS (comma-separated platform keys). Skipped platforms are
// excluded from EVERY check below; the platforms that ARE present stay fully
// verified (bundle + signature + installers + manifest). Empty/unset = all
// required (default behaviour unchanged).
const knownKeys = REQUIRED_PLATFORMS.map((platform) => platform.key);
const allowMissing = (process.env.ALLOW_MISSING_PLATFORMS ?? "")
  .split(",")
  .map((key) => key.trim())
  .filter((key) => key.length > 0);

for (const key of allowMissing) {
  if (!knownKeys.includes(key)) {
    fail(`ALLOW_MISSING_PLATFORMS lists an unknown platform key: ${key} (known: ${knownKeys.join(", ")})`);
  }
}

const activePlatforms = REQUIRED_PLATFORMS.filter((platform) => !allowMissing.includes(platform.key));
if (activePlatforms.length === 0) {
  fail("ALLOW_MISSING_PLATFORMS skips every platform; nothing left to verify");
}
if (allowMissing.length > 0) {
  console.log(`skipping platforms (ALLOW_MISSING_PLATFORMS): ${allowMissing.join(", ")}`);
}

if (!existsSync(artifactDir) || !statSync(artifactDir).isDirectory()) {
  fail(`artifact directory is missing: ${artifactDir}`);
}

const files = readdirSync(artifactDir)
  .filter((file) => statSync(path.join(artifactDir, file)).isFile())
  .sort();

const findOne = (patterns, label) => {
  const matches = files.filter((file) => patterns.some((pattern) => pattern.test(file)));
  if (matches.length === 0) fail(`missing ${label}`);
  if (matches.length > 1) fail(`multiple ${label} candidates: ${matches.join(", ")}`);
  return matches[0];
};

const requireNonEmpty = (file, label = file) => {
  const full = path.join(artifactDir, file);
  if (!existsSync(full) || statSync(full).size <= 0) fail(`missing or empty ${label}: ${file}`);
};

const platformBundles = {};
for (const platform of activePlatforms) {
  const bundle = findOne(platform.bundle, `${platform.key} updater bundle`);
  const sig = `${bundle}.sig`;
  requireNonEmpty(bundle, `${platform.key} updater bundle`);
  requireNonEmpty(sig, `${platform.key} updater signature`);
  platformBundles[platform.key] = { bundle, sig };

  for (const installerPatterns of platform.installers) {
    const installer = findOne(
      installerPatterns,
      `${platform.key} installer matching ${installerPatterns.map(String).join(" or ")}`,
    );
    requireNonEmpty(installer, `${platform.key} installer`);
  }
}

const latestPath = path.join(artifactDir, "latest.json");
requireNonEmpty("latest.json", "updater manifest");

let latest;
try {
  latest = JSON.parse(readFileSync(latestPath, "utf8"));
} catch (err) {
  fail(`latest.json is not valid JSON: ${err.message}`);
}

const expectedVersion = tag.startsWith("v") ? tag.slice(1) : tag;
if (expectedVersion && latest.version !== expectedVersion) {
  fail(`latest.json version mismatch: ${latest.version} != ${expectedVersion}`);
}
if (!latest.pub_date || Number.isNaN(Date.parse(latest.pub_date))) {
  fail("latest.json pub_date is missing or invalid");
}
if (!latest.platforms || typeof latest.platforms !== "object" || Array.isArray(latest.platforms)) {
  fail("latest.json platforms object is missing");
}

const actualKeys = Object.keys(latest.platforms).sort();
const expectedKeys = activePlatforms.map((platform) => platform.key).sort();
if (actualKeys.join("\n") !== expectedKeys.join("\n")) {
  fail(`latest.json platform keys mismatch: ${actualKeys.join(", ") || "(none)"}`);
}

for (const platform of activePlatforms) {
  const entry = latest.platforms[platform.key];
  const { bundle, sig } = platformBundles[platform.key];
  const expectedSig = readFileSync(path.join(artifactDir, sig), "utf8").trim();
  if (!entry || typeof entry !== "object") fail(`latest.json missing ${platform.key}`);
  if (entry.signature !== expectedSig || entry.signature.length === 0) {
    fail(`latest.json signature mismatch for ${platform.key}`);
  }
  const encodedBundle = encodeURIComponent(bundle);
  if (typeof entry.url !== "string" || !entry.url.endsWith(`/${encodedBundle}`)) {
    fail(`latest.json URL for ${platform.key} does not point at ${bundle}`);
  }
}

console.log(`release artifact verification ok: ${activePlatforms.length} platforms`);
