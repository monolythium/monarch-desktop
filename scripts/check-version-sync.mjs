#!/usr/bin/env node
// Assert the three version fields that describe a release agree:
//   - package.json                 (the frontend bundle version)
//   - src-tauri/tauri.conf.json    (the Tauri bundle version)
//   - src-tauri/Cargo.toml         (the crate version — read by CARGO_PKG_VERSION
//                                    in Rust-side telemetry/provenance)
//
// The release bump step touches all three; before this guard existed the crate
// version silently lagged (0.0.55 while the shipped release was 0.0.57). CI
// fails on any divergence so a release can never ship a stale crate version.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const mismatches = checkVersionSync(root);
if (mismatches.length > 0) {
  for (const line of mismatches) console.error(`version sync error: ${line}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, version_sync: "valid" }));
}

export function checkVersionSync(rootDir) {
  const out = [];
  const sources = [
    { label: "package.json", version: readPackageJsonVersion(rootDir, "package.json") },
    {
      label: "src-tauri/tauri.conf.json",
      version: readPackageJsonVersion(rootDir, path.join("src-tauri", "tauri.conf.json")),
    },
    { label: "src-tauri/Cargo.toml", version: readCargoTomlVersion(rootDir) },
  ];

  for (const source of sources) {
    if (!source.version) out.push(`could not read a version from ${source.label}`);
  }
  if (out.length > 0) return out;

  const unique = [...new Set(sources.map((s) => s.version))];
  if (unique.length > 1) {
    const detail = sources.map((s) => `${s.label}=${s.version}`).join(", ");
    out.push(`version fields disagree: ${detail}`);
  }
  return out;
}

function readPackageJsonVersion(rootDir, relPath) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, relPath), "utf8");
    const version = JSON.parse(raw).version;
    return typeof version === "string" ? version.trim() : null;
  } catch {
    return null;
  }
}

// Read the first `version = "..."` under the `[package]` table so a
// dependency's version key can never be mistaken for the crate version.
function readCargoTomlVersion(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, "src-tauri", "Cargo.toml"), "utf8");
    const lines = raw.split(/\r?\n/u);
    let inPackage = false;
    for (const line of lines) {
      const table = line.match(/^\s*\[([^\]]+)\]/u);
      if (table) {
        inPackage = table[1].trim() === "package";
        continue;
      }
      if (!inPackage) continue;
      const match = line.match(/^\s*version\s*=\s*"([^"]+)"/u);
      if (match) return match[1].trim();
    }
    return null;
  } catch {
    return null;
  }
}
