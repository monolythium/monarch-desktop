import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { OpKind, OpRequest, OpResult } from "./types";

export type OperationReceiptStatus = "ok" | "error";

export type OperationReceiptTransport =
  | "talos"
  | "ssh-dev"
  | "register-tx"
  | "redelegate-tx"
  | "operator-display-tx"
  | "chat-bootstrap-peers-tx"
  | "cluster-name-tx"
  | "foundation-recovery-tx"
  | "foundation-pending-change-tx"
  | "cluster-join-request-tx"
  | "cluster-vote-admit-tx"
  | "cluster-resignation-tx"
  | "cluster-form-tx"
  | "cluster-update-charter-tx"
  | "dkg-reshare-tx"
  | "incident-freeze-admission-tx"
  | "incident-emergency-key-rotation-tx"
  // Legacy stored receipts may still carry browser-preview. New browser-only
  // attempts must use "blocked" and status=error.
  | "browser-preview"
  | "blocked";

export type OperationReceipt = {
  id: string;
  createdAt: string;
  kind: OpKind;
  title: string;
  status: OperationReceiptStatus;
  message: string;
  txHash?: string;
  transport: OperationReceiptTransport;
  service?: string;
  action?: string;
  endpoint?: string;
  nodeAddress?: string;
  command?: string;
  artifactPath?: string;
  artifactSha256?: string;
  auditPayloadSchema?: typeof OPERATION_RECEIPT_AUDIT_SCHEMA;
  auditPayloadHash?: string;
};

export type OperationReceiptMeta = {
  transport: OperationReceiptTransport;
  service?: string;
  action?: string;
  endpoint?: string;
  nodeAddress?: string;
  command?: string;
  artifactPath?: string;
  artifactSha256?: string;
};

const STORAGE_KEY = "monarch.operationReceipts.v1";
const MAX_RECEIPTS = 100;
export const OPERATION_RECEIPT_AUDIT_SCHEMA = "monarch-desktop-operation-receipt/v1";
const HASH32_RE = /^[0-9a-f]{64}$/u;

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function receiptId(): string {
  const cryptoApi = typeof crypto !== "undefined" ? crypto : null;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isReceipt(value: unknown): value is OperationReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<OperationReceipt>;
  return (
    typeof receipt.id === "string" &&
    typeof receipt.createdAt === "string" &&
    typeof receipt.kind === "string" &&
    typeof receipt.title === "string" &&
    (receipt.status === "ok" || receipt.status === "error") &&
    typeof receipt.message === "string" &&
    typeof receipt.transport === "string"
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function operationReceiptAuditPayload(receipt: OperationReceipt): Record<string, unknown> {
  return {
    schema_version: OPERATION_RECEIPT_AUDIT_SCHEMA,
    id: receipt.id,
    created_at: receipt.createdAt,
    kind: receipt.kind,
    title: receipt.title,
    status: receipt.status,
    message: receipt.message,
    transport: receipt.transport,
    service: receipt.service ?? null,
    action: receipt.action ?? null,
    endpoint: receipt.endpoint ?? null,
    node_address: receipt.nodeAddress ?? null,
    command: receipt.command ?? null,
    tx_hash: receipt.txHash ? receipt.txHash.toLowerCase() : null,
    artifact_path: receipt.artifactPath ?? null,
    artifact_sha256: receipt.artifactSha256 ? receipt.artifactSha256.toLowerCase() : null,
  };
}

export function operationReceiptAuditHash(receipt: OperationReceipt): string {
  const payload = operationReceiptAuditPayload(receipt);
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(payload))));
}

export function withOperationReceiptAuditHash(receipt: OperationReceipt): OperationReceipt {
  const auditPayloadHash = operationReceiptAuditHash(receipt);
  return {
    ...receipt,
    auditPayloadSchema: OPERATION_RECEIPT_AUDIT_SCHEMA,
    auditPayloadHash,
  };
}

export function isAuditReadyOperationReceipt(receipt: OperationReceipt): boolean {
  return (
    receipt.auditPayloadSchema === OPERATION_RECEIPT_AUDIT_SCHEMA &&
    typeof receipt.auditPayloadHash === "string" &&
    HASH32_RE.test(receipt.auditPayloadHash) &&
    receipt.auditPayloadHash === operationReceiptAuditHash(receipt)
  );
}

/** Recompute the canonical SHA-256 audit hash from a receipt's payload. */
export function recomputeReceiptHash(receipt: OperationReceipt): string {
  return operationReceiptAuditHash(receipt);
}

export type ReceiptHashVerification = {
  status: "match" | "mismatch" | "no-stored-hash" | "not-found";
  computedHash: string | null;
  storedHash: string | null;
};

/**
 * Verify one receipt's audit hash against what is ACTUALLY persisted in
 * storage. `readOperationReceipts` re-derives hashes on load, so this
 * deliberately reads the raw stored rows — a tampered or corrupted row
 * reports `mismatch` instead of being silently re-hashed.
 */
export function verifyStoredReceiptHash(id: string): ReceiptHashVerification {
  const notFound: ReceiptHashVerification = { status: "not-found", computedHash: null, storedHash: null };
  const store = storage();
  if (!store) return notFound;
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return notFound;
    const raw = parsed.find((row) => isReceipt(row) && row.id === id) as
      | OperationReceipt
      | undefined;
    if (!raw) return notFound;
    const computedHash = recomputeReceiptHash(raw);
    const storedHash =
      typeof raw.auditPayloadHash === "string" && HASH32_RE.test(raw.auditPayloadHash.toLowerCase())
        ? raw.auditPayloadHash.toLowerCase()
        : null;
    if (storedHash === null) return { status: "no-stored-hash", computedHash, storedHash: null };
    return {
      status: storedHash === computedHash ? "match" : "mismatch",
      computedHash,
      storedHash,
    };
  } catch {
    return notFound;
  }
}

export function readOperationReceipts(): OperationReceipt[] {
  const store = storage();
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isReceipt).map(withOperationReceiptAuditHash).slice(0, MAX_RECEIPTS);
  } catch {
    return [];
  }
}

export function createOperationReceipt(
  request: OpRequest,
  result: OpResult,
  meta: OperationReceiptMeta,
): OperationReceipt {
  return withOperationReceiptAuditHash({
    id: receiptId(),
    createdAt: new Date().toISOString(),
    kind: request.kind,
    title: request.title,
    status: result.ok ? "ok" : "error",
    message: result.message,
    txHash: result.txHash,
    transport: meta.transport,
    service: meta.service,
    action: meta.action,
    endpoint: meta.endpoint,
    nodeAddress: meta.nodeAddress,
    command: meta.command,
    artifactPath: meta.artifactPath,
    artifactSha256: meta.artifactSha256,
  });
}

export function appendOperationReceipt(receipt: OperationReceipt): OperationReceipt[] {
  const audited = withOperationReceiptAuditHash(receipt);
  const next = [
    audited,
    ...readOperationReceipts().filter((existing) => existing.id !== audited.id),
  ].slice(0, MAX_RECEIPTS);
  const store = storage();
  if (store) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Audit storage is best-effort when local storage is locked down.
    }
  }
  return next;
}

export function clearOperationReceipts(): OperationReceipt[] {
  const store = storage();
  if (store) {
    try {
      store.removeItem(STORAGE_KEY);
    } catch {
      // Keep the in-memory UI consistent even if storage is unavailable.
    }
  }
  return [];
}
