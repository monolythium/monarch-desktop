#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REQUIRED_SECRET_WORDS = 24;
const DKG_RESHARE_SCHEMA = "monarch-dkg-reshare-attestation/v1";
const MAX_DKG_RESHARE_INTENT_ID = 72057594037927935n;
const DKG_RESHARE_CONSENSUS_PUBKEY_BYTES = 1952;
const DKG_RESHARE_ATTESTATION_SIG_BYTES = 3309;
const DKG_RESHARE_CONSENSUS_PUBKEY_HEX_CHARS = DKG_RESHARE_CONSENSUS_PUBKEY_BYTES * 2;

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
  const dkgAttestation = readJsonArtifact(env, "MONARCH_E2E_DKG_RESHARE_ATTESTATION");

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

  checkDkgReshareAttestation(dkgAttestation, out);

  return out;
}

function checkMnemonic(secret, name, out) {
  if (!secret.value) {
    out.push(`${name} or ${name}_FILE is required`);
    return;
  }
  const words = secret.value.split(/\s+/u).filter(Boolean);
  if (words.length !== REQUIRED_SECRET_WORDS) {
    out.push(`${name} must be a ${REQUIRED_SECRET_WORDS}-word PQM-1 mnemonic`);
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

function readJsonArtifact(env, name) {
  const fromEnv = stringValue(env[name]);
  const file = stringValue(env[`${name}_FILE`]);
  if (!fromEnv && !file) return { source: "", value: null, error: "missing" };
  try {
    const raw = fromEnv || fs.readFileSync(path.resolve(file), "utf8");
    return {
      source: fromEnv ? name : `${name}_FILE`,
      value: JSON.parse(raw),
      error: "",
    };
  } catch (err) {
    return {
      source: fromEnv ? name : `${name}_FILE`,
      value: null,
      error: errorMessage(err),
    };
  }
}

function checkDkgReshareAttestation(artifact, out) {
  const name = "MONARCH_E2E_DKG_RESHARE_ATTESTATION";
  if (!artifact.source) {
    out.push(`${name} or ${name}_FILE is required`);
    return;
  }
  if (artifact.error) {
    out.push(`${artifact.source} must contain valid JSON: ${artifact.error}`);
    return;
  }
  const value = artifact.value;
  if (!isRecord(value)) {
    out.push(`${artifact.source} must be a JSON object`);
    return;
  }
  if (stringValue(value.schema_version) !== DKG_RESHARE_SCHEMA) {
    out.push(`${artifact.source}.schema_version must be ${DKG_RESHARE_SCHEMA}`);
  }
  const intent = stringValue(value.intent_id);
  if (!/^(0|[1-9][0-9]*)$/u.test(intent)) {
    out.push(`${artifact.source}.intent_id must be a decimal integer`);
  } else {
    const parsed = BigInt(intent);
    if (parsed === 0n || parsed > MAX_DKG_RESHARE_INTENT_ID) {
      out.push(`${artifact.source}.intent_id must be 1..2^56-1`);
    }
  }

  const keysHex = normalizeHex(stringValue(value.bls_public_keys_hex));
  if (!keysHex || keysHex.length % DKG_RESHARE_CONSENSUS_PUBKEY_HEX_CHARS !== 0) {
    out.push(`${artifact.source}.bls_public_keys_hex must be concatenated 1952-byte ML-DSA-65 pubkeys`);
  } else {
    const signerCount = keysHex.length / DKG_RESHARE_CONSENSUS_PUBKEY_HEX_CHARS;
    if (signerCount < 5 || signerCount > 7) {
      out.push(`${artifact.source}.bls_public_keys_hex must contain 5..7 signer pubkeys`);
    }
    const keys = [];
    for (let offset = 0; offset < keysHex.length; offset += DKG_RESHARE_CONSENSUS_PUBKEY_HEX_CHARS) {
      keys.push(keysHex.slice(offset, offset + DKG_RESHARE_CONSENSUS_PUBKEY_HEX_CHARS));
    }
    if (new Set(keys).size !== keys.length) {
      out.push(`${artifact.source}.bls_public_keys_hex must not contain duplicate signer pubkeys`);
    }
    if (Number(value.signer_count) !== signerCount) {
      out.push(`${artifact.source}.signer_count must match bls_public_keys_hex`);
    }
  }

  const sigHex = normalizeHex(stringValue(value.threshold_sig_hex));
  const signerCount = Number(value.signer_count);
  const expectedSigHexChars = signerCount > 0
    ? signerCount * DKG_RESHARE_ATTESTATION_SIG_BYTES * 2
    : 0;
  if (!sigHex || sigHex.length !== expectedSigHexChars) {
    out.push(`${artifact.source}.threshold_sig_hex must contain one 3309-byte ML-DSA-65 signature per signer`);
  }
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

function normalizeHex(value) {
  const hex = value.replace(/^0x/iu, "").toLowerCase();
  return /^[0-9a-f]+$/u.test(hex) && hex.length % 2 === 0 ? hex : "";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
