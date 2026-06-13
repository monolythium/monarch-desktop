// Operator DKG re-share attestation submission helpers.
//
// `attestDkgReshare(uint64,bytes,bytes)` flips the node-registry
// `dkg_attested` flag for a queued Rotate pending-change intent. The
// off-chain DKG ceremony produces participant ML-DSA-65 consensus pubkeys
// and one ML-DSA-65 attestation signature per signer; Desktop validates
// their wire shape, signs the native tx with the operator mnemonic, and
// submits it through the live plaintext native transaction path.

import {
  addressToTypedBech32,
  nodeRegistryAddressHex,
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT,
} from "@monolythium/core-sdk";
import { makeRpcClient } from "./rpcTransport";
import {
  pqm1MnemonicToMlDsa65Backend,
  submitTransactionWithPrivacy,
  type NativeEvmTxFields,
} from "@monolythium/core-sdk/crypto";
import { clampPriorityTip, type RegisterFeeQuote } from "./register";
import {
  NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES,
  NODE_REGISTRY_DKG_ATTESTATION_SIG_BYTES,
} from "./operatorKeys";

export const ATTEST_DKG_RESHARE_SELECTOR = "0x36e34030";
export const DEFAULT_DKG_RESHARE_EXECUTION_UNIT_LIMIT =
  REGISTRY_DEFAULT_EXECUTION_UNIT_LIMIT;
export const DKG_RESHARE_CONSENSUS_PUBKEY_BYTES = NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES;
export const DKG_RESHARE_ATTESTATION_SIG_BYTES = NODE_REGISTRY_DKG_ATTESTATION_SIG_BYTES;
/** @deprecated Use DKG_RESHARE_CONSENSUS_PUBKEY_BYTES. */
export const DKG_RESHARE_BLS_PUBKEY_BYTES = DKG_RESHARE_CONSENSUS_PUBKEY_BYTES;
export const DKG_RESHARE_THRESHOLD_SIG_BYTES = DKG_RESHARE_ATTESTATION_SIG_BYTES;
export const DKG_RESHARE_MIN_SIGNERS = 5;
export const DKG_RESHARE_MAX_SIGNERS = 7;
export const MAX_DKG_RESHARE_INTENT_ID = (1n << 56n) - 1n;
export const DKG_RESHARE_ATTESTATION_SCHEMA = "monarch-dkg-reshare-attestation/v1";
const MAX_UINT64 = (1n << 64n) - 1n;

export interface SubmitDkgReshareAttestationArgs {
  rpcUrl: string;
  mnemonic: string;
  intentId: bigint | number | string;
  consensusPublicKeysHex: string;
  thresholdSigHex: string;
  executionUnitLimit?: bigint;
}

export interface SubmitDkgReshareAttestationResult {
  txHash: string;
  intentId: string;
  signerCount: number;
  calldataHex: string;
  innerSighashHex: string;
  envelopeWireBytes: number;
}

export interface DkgReshareAttestationArtifact {
  schemaVersion: string | null;
  intentId: string;
  consensusPublicKeysHex: string;
  thresholdSigHex: string;
  signerCount: number;
}

function stripHex(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

function bytesToHex(b: Uint8Array): string {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function normalizeHexString(value: string, label: string): string {
  return bytesToHex(hexToBytes(value, label));
}

function hexToBytes(s: string, label: string, expectedLen?: number): Uint8Array {
  const clean = stripHex(s.trim());
  if (clean.length % 2 !== 0) throw new Error(`${label}: odd hex length`);
  if (!/^[0-9a-fA-F]*$/u.test(clean)) throw new Error(`${label}: invalid hex`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  if (expectedLen !== undefined && out.length !== expectedLen) {
    throw new Error(`${label}: expected ${expectedLen} bytes, got ${out.length}`);
  }
  return out;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function getStringField(record: Record<string, unknown>, keys: string[], label: string): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    if (typeof value === "bigint") return value.toString();
  }
  throw new Error(`${label}: missing required field`);
}

function getLegacyStringField(
  record: Record<string, unknown>,
  canonicalKeys: string[],
  legacyKeys: string[],
  label: string,
): string {
  return getStringField(record, [...canonicalKeys, ...legacyKeys], label);
}

function findAttestationRecord(value: unknown): Record<string, unknown> {
  const root = asRecord(value, "attestation artifact");
  for (const key of [
    "dkg_reshare_attestation",
    "dkgReshareAttestation",
    "attestation",
    "on_chain_attestation",
    "onChainAttestation",
  ]) {
    if (root[key] !== undefined) return asRecord(root[key], key);
  }
  return root;
}

function parseUint64(value: bigint | number | string, label: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label}: expected safe integer`);
    parsed = BigInt(value);
  } else {
    const trimmed = value.trim();
    if (!/^\d+$/u.test(trimmed)) throw new Error(`${label}: expected decimal uint64`);
    parsed = BigInt(trimmed);
  }
  if (parsed < 0n || parsed > MAX_UINT64) {
    throw new Error(`${label}: out of uint64 range`);
  }
  return parsed;
}

function u256BE(value: bigint | number): Uint8Array {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n || v >= 1n << 256n) throw new Error("u256 out of range");
  const out = new Uint8Array(32);
  let n = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function padTo32(buf: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil(buf.length / 32) * 32;
  if (paddedLength === buf.length) return buf;
  const out = new Uint8Array(paddedLength);
  out.set(buf);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function parseDkgResharePublicKeys(consensusPublicKeysHex: string): Uint8Array[] {
  const keys = hexToBytes(consensusPublicKeysHex, "consensusPublicKeys");
  if (keys.length % DKG_RESHARE_CONSENSUS_PUBKEY_BYTES !== 0) {
    throw new Error(
      `consensusPublicKeys: length must be a multiple of ${DKG_RESHARE_CONSENSUS_PUBKEY_BYTES} bytes`,
    );
  }
  const signerCount = keys.length / DKG_RESHARE_CONSENSUS_PUBKEY_BYTES;
  if (signerCount < DKG_RESHARE_MIN_SIGNERS || signerCount > DKG_RESHARE_MAX_SIGNERS) {
    throw new Error(
      `consensusPublicKeys: expected ${DKG_RESHARE_MIN_SIGNERS}..${DKG_RESHARE_MAX_SIGNERS} signers`,
    );
  }
  const out: Uint8Array[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < keys.length; offset += DKG_RESHARE_CONSENSUS_PUBKEY_BYTES) {
    const key = keys.slice(offset, offset + DKG_RESHARE_CONSENSUS_PUBKEY_BYTES);
    const keyHex = bytesToHex(key);
    if (seen.has(keyHex)) {
      throw new Error("consensusPublicKeys: duplicate signer pubkey");
    }
    seen.add(keyHex);
    out.push(key);
  }
  return out;
}

export function parseDkgReshareAttestationArtifact(
  artifact: string | unknown,
): DkgReshareAttestationArtifact {
  let parsed: unknown;
  if (typeof artifact === "string") {
    try {
      parsed = JSON.parse(artifact);
    } catch (err) {
      throw new Error(`attestation artifact: invalid JSON (${(err as Error).message})`);
    }
  } else {
    parsed = artifact;
  }

  const record = findAttestationRecord(parsed);
  const schemaVersion =
    typeof record.schema_version === "string"
      ? record.schema_version
      : typeof record.schemaVersion === "string"
        ? record.schemaVersion
        : null;
  if (schemaVersion !== null && schemaVersion !== DKG_RESHARE_ATTESTATION_SCHEMA) {
    throw new Error(
      `attestation artifact: unsupported schema_version ${schemaVersion}`,
    );
  }

  const intentId = parseUint64(
    getStringField(record, ["intent_id", "intentId"], "intentId"),
    "intentId",
  );
  if (intentId === 0n) {
    throw new Error("intentId: must be greater than zero");
  }
  if (intentId > MAX_DKG_RESHARE_INTENT_ID) {
    throw new Error("intentId: exceeds 2^56-1");
  }

  const consensusPublicKeysHex = normalizeHexString(
    getLegacyStringField(
      record,
      [
        "consensus_public_keys_hex",
        "consensusPublicKeysHex",
        "consensus_public_keys",
        "consensusPublicKeys",
      ],
      ["bls_public_keys_hex", "blsPublicKeysHex", "bls_public_keys", "blsPublicKeys"],
      "consensusPublicKeys",
    ),
    "consensusPublicKeys",
  );
  const publicKeys = parseDkgResharePublicKeys(consensusPublicKeysHex);
  const thresholdSigHex = normalizeHexString(
    getStringField(
      record,
      ["threshold_sig_hex", "thresholdSigHex", "threshold_signature_hex", "thresholdSignatureHex"],
      "thresholdSig",
    ),
    "thresholdSig",
  );
  const thresholdSig = hexToBytes(thresholdSigHex, "thresholdSig");
  if (thresholdSig.length !== publicKeys.length * DKG_RESHARE_ATTESTATION_SIG_BYTES) {
    throw new Error(
      `thresholdSig: expected ${publicKeys.length * DKG_RESHARE_ATTESTATION_SIG_BYTES} bytes, got ${thresholdSig.length}`,
    );
  }

  return {
    schemaVersion,
    intentId: intentId.toString(),
    consensusPublicKeysHex,
    thresholdSigHex,
    signerCount: publicKeys.length,
  };
}

function dkgConsensusPublicKeysHex(
  args: unknown,
): string {
  const record = args as { consensusPublicKeysHex?: unknown; blsPublicKeysHex?: unknown };
  const value = record.consensusPublicKeysHex;
  if (typeof value === "string") return value;
  const legacy = record.blsPublicKeysHex;
  if (typeof legacy === "string") return legacy;
  throw new Error("consensusPublicKeys: missing required field");
}

export function encodeAttestDkgReshareCalldata(args: {
  intentId: bigint | number | string;
  consensusPublicKeysHex: string;
  thresholdSigHex: string;
}): string {
  const intentId = parseUint64(args.intentId, "intentId");
  if (intentId === 0n) {
    throw new Error("intentId: must be greater than zero");
  }
  if (intentId > MAX_DKG_RESHARE_INTENT_ID) {
    throw new Error("intentId: exceeds 2^56-1");
  }
  const publicKeys = parseDkgResharePublicKeys(dkgConsensusPublicKeysHex(args));
  const publicKeysBytes = concat(publicKeys);
  const thresholdSig = hexToBytes(args.thresholdSigHex, "thresholdSig");
  if (thresholdSig.length !== publicKeys.length * DKG_RESHARE_ATTESTATION_SIG_BYTES) {
    throw new Error(
      `thresholdSig: expected ${publicKeys.length * DKG_RESHARE_ATTESTATION_SIG_BYTES} bytes, got ${thresholdSig.length}`,
    );
  }

  const selector = hexToBytes(ATTEST_DKG_RESHARE_SELECTOR, "selector", 4);
  const keysPadded = padTo32(publicKeysBytes);
  const sigPadded = padTo32(thresholdSig);
  const offsetKeys = 3n * 32n;
  const offsetSig = offsetKeys + 32n + BigInt(keysPadded.length);

  const calldata = concat([
    selector,
    u256BE(intentId),
    u256BE(offsetKeys),
    u256BE(offsetSig),
    u256BE(publicKeysBytes.length),
    keysPadded,
    u256BE(thresholdSig.length),
    sigPadded,
  ]);
  if ((calldata.length - 4) % 32 !== 0) {
    throw new Error(`attestDkgReshare calldata not 32-aligned (len=${calldata.length - 4})`);
  }
  return bytesToHex(calldata);
}

export function buildDkgReshareAttestationTxFields(args: {
  chainId: bigint | number | string;
  nonce: bigint | number | string;
  fee: RegisterFeeQuote;
  intentId: bigint | number | string;
  consensusPublicKeysHex: string;
  thresholdSigHex: string;
  executionUnitLimit?: bigint;
}): NativeEvmTxFields {
  const consensusPublicKeysHex = dkgConsensusPublicKeysHex(args);
  const maxExecutionUnitPrice = BigInt(args.fee.executionUnitPriceLythoshi);
  const suggestedTip = BigInt(args.fee.priorityTipLythoshi);
  const priorityTip = clampPriorityTip(suggestedTip, maxExecutionUnitPrice);

  return {
    chainId: args.chainId,
    nonce: args.nonce,
    maxFeePerGas: maxExecutionUnitPrice,
    maxPriorityFeePerGas: priorityTip,
    gasLimit: args.executionUnitLimit ?? DEFAULT_DKG_RESHARE_EXECUTION_UNIT_LIMIT,
    to: nodeRegistryAddressHex(),
    value: 0n,
    input: encodeAttestDkgReshareCalldata({
      intentId: args.intentId,
      consensusPublicKeysHex,
      thresholdSigHex: args.thresholdSigHex,
    }),
  };
}

export async function submitDkgReshareAttestation(
  args: SubmitDkgReshareAttestationArgs,
): Promise<SubmitDkgReshareAttestationResult> {
  const intentId = parseUint64(args.intentId, "intentId");
  const consensusPublicKeysHex = dkgConsensusPublicKeysHex(args);
  const publicKeys = parseDkgResharePublicKeys(consensusPublicKeysHex);
  const backend = pqm1MnemonicToMlDsa65Backend(args.mnemonic);
  const rpc = makeRpcClient(args.rpcUrl);
  const senderAddress = addressToTypedBech32("user", backend.addressBytes());

  const [chainId, nonce, fee] = await Promise.all([
    rpc.ethChainId(),
    rpc.lythGetTransactionCount(senderAddress),
    rpc.lythExecutionUnitPrice(),
  ]);

  const tx = buildDkgReshareAttestationTxFields({
    chainId,
    nonce,
    fee,
    intentId,
    consensusPublicKeysHex,
    thresholdSigHex: args.thresholdSigHex,
    executionUnitLimit: args.executionUnitLimit,
  });
  const calldataHex = tx.input;
  if (typeof calldataHex !== "string") {
    throw new Error("attestDkgReshare tx input was not hex-encoded");
  }

  const txHash = await submitTransactionWithPrivacy({
    client: rpc,
    backend,
    tx,
    private: false,
  });

  const signed = backend.signEvmTx(tx);
  return {
    txHash,
    intentId: intentId.toString(),
    signerCount: publicKeys.length,
    calldataHex,
    innerSighashHex: bytesToHex(signed.sighash),
    envelopeWireBytes: signed.wireBytes.length,
  };
}
