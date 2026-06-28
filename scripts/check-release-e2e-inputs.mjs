#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REQUIRED_SECRET_WORDS = 24;

const blockers = checkReleaseE2eInputs(process.env);
if (blockers.length > 0) {
  for (const blocker of blockers) {
    console.error(`release e2e input error: ${blocker}`);
  }
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, release_e2e_inputs: "valid" }));
}

export function checkReleaseE2eInputs(env) {
  const out = [];
  const operator = readSecret(env, "MONARCH_E2E_OPERATOR_MNEMONIC");
  const peer = readSecret(env, "MONARCH_E2E_PEER_OPERATOR_MNEMONIC");
  const peers = readList(env, "MONARCH_E2E_CHAT_BOOTSTRAP_PEERS");
  const allowDiscoveredPeers = truthy(env.MONARCH_E2E_ALLOW_DISCOVERED_CHAT_PEERS);
  const clusterId = stringValue(env.MONARCH_E2E_CLUSTER_ID);
  const digest = stringValue(env.MONARCH_E2E_EXPECTED_DIGEST);

  checkMnemonic(operator, "MONARCH_E2E_OPERATOR_MNEMONIC", out);
  checkMnemonic(peer, "MONARCH_E2E_PEER_OPERATOR_MNEMONIC", out);
  if (operator.value && peer.value && operator.value === peer.value) {
    out.push("operator and peer mnemonics must be distinct so chat evidence proves two identities");
  }

  if (!/^(0|[1-9][0-9]*)$/u.test(clusterId)) {
    out.push("MONARCH_E2E_CLUSTER_ID must be a non-negative integer");
  } else if (!Number.isSafeInteger(Number(clusterId))) {
    out.push("MONARCH_E2E_CLUSTER_ID is outside the JavaScript safe-integer range");
  }

  if (peers.length === 0 && !allowDiscoveredPeers) {
    out.push(
      "MONARCH_E2E_CHAT_BOOTSTRAP_PEERS must include at least one libp2p peer multiaddr, or MONARCH_E2E_ALLOW_DISCOVERED_CHAT_PEERS=true must be set so live operator metadata can supply peers",
    );
  }
  for (const peerAddr of peers) {
    if (!isBootstrapPeer(peerAddr)) {
      out.push(`invalid chat bootstrap peer multiaddr: ${peerAddr}`);
    }
  }

  if (digest && !/^[0-9a-fA-F]{64}$/u.test(digest)) {
    out.push("MONARCH_E2E_EXPECTED_DIGEST must be a 64-character SHA-256 hex digest when set");
  }

  return out;
}

function checkMnemonic(secret, name, out) {
  if (!secret.value) {
    out.push(`${name} or ${name}_FILE is required`);
    return;
  }
  const words = secret.value.split(/\s+/u).filter(Boolean);
  if (words.length !== REQUIRED_SECRET_WORDS) {
    out.push(`${name} must be a ${REQUIRED_SECRET_WORDS}-word recovery phrase`);
  }
}

function readSecret(env, name) {
  const fromEnv = stringValue(env[name]);
  if (fromEnv) return { source: name, value: fromEnv };
  const file = stringValue(env[`${name}_FILE`]);
  if (!file) return { source: "", value: "" };
  try {
    return {
      source: `${name}_FILE`,
      value: fs.readFileSync(path.resolve(file), "utf8").trim(),
    };
  } catch (err) {
    return {
      source: `${name}_FILE`,
      value: "",
      error: errorMessage(err),
    };
  }
}

function readList(env, name) {
  const fromEnv = stringValue(env[name]);
  let raw = fromEnv;
  const file = stringValue(env[`${name}_FILE`]);
  if (!raw && file) {
    try {
      raw = fs.readFileSync(path.resolve(file), "utf8").trim();
    } catch {
      raw = "";
    }
  }
  return raw
    .split(/[\s,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isBootstrapPeer(value) {
  return value.startsWith("/") &&
    value.includes("/p2p/") &&
    !/[\s,]/u.test(value) &&
    value.split("/").filter(Boolean).length >= 4;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function truthy(value) {
  return /^(1|true|yes)$/iu.test(stringValue(value));
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
