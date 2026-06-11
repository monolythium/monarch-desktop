// Tests for the receipt re-verify affordance: recompute the canonical
// SHA-256 from the RAW stored payload and compare it to the stored
// hash, so tampered/corrupted rows surface as a mismatch instead of
// being silently re-hashed on load.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOperationReceipt,
  recomputeReceiptHash,
  verifyStoredReceiptHash,
  type OperationReceipt,
} from "./receipts";
import type { OpRequest } from "./types";

const STORAGE_KEY = "monarch.operationReceipts.v1";

const request: OpRequest = {
  kind: "operator-restart",
  title: "Graceful restart",
  sub: "Cycle ext-protocore",
  intro: "Restart the service through Talos API.",
  fields: [],
};

function makeReceipt(): OperationReceipt {
  return createOperationReceipt(
    request,
    { ok: true, message: "submitted", txHash: "0xabc" },
    { transport: "talos", service: "ext-protocore", action: "restart" },
  );
}

// Minimal in-memory localStorage for the node test environment.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as Record<string, unknown>)["window"] = { localStorage: storage };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)["window"];
});

describe("recomputeReceiptHash", () => {
  it("is deterministic over the canonical payload", () => {
    const receipt = makeReceipt();
    expect(recomputeReceiptHash(receipt)).toBe(receipt.auditPayloadHash);
    expect(recomputeReceiptHash(receipt)).toBe(recomputeReceiptHash({ ...receipt }));
  });

  it("changes when any audited field changes", () => {
    const receipt = makeReceipt();
    const altered = { ...receipt, message: "submitted (edited)" };
    expect(recomputeReceiptHash(altered)).not.toBe(recomputeReceiptHash(receipt));
  });
});

describe("verifyStoredReceiptHash", () => {
  it("reports match for an intact stored receipt", () => {
    const receipt = makeReceipt();
    storage.setItem(STORAGE_KEY, JSON.stringify([receipt]));
    const check = verifyStoredReceiptHash(receipt.id);
    expect(check.status).toBe("match");
    expect(check.computedHash).toBe(receipt.auditPayloadHash);
    expect(check.storedHash).toBe(receipt.auditPayloadHash);
  });

  it("reports mismatch when the stored payload was altered after hashing", () => {
    const receipt = makeReceipt();
    const tampered = { ...receipt, message: "rewritten by someone" };
    storage.setItem(STORAGE_KEY, JSON.stringify([tampered]));
    const check = verifyStoredReceiptHash(receipt.id);
    expect(check.status).toBe("mismatch");
    expect(check.computedHash).not.toBe(check.storedHash);
  });

  it("reports no-stored-hash for legacy rows without an audit hash", () => {
    const receipt = makeReceipt();
    const legacy = { ...receipt } as Partial<OperationReceipt>;
    delete legacy.auditPayloadHash;
    delete legacy.auditPayloadSchema;
    storage.setItem(STORAGE_KEY, JSON.stringify([legacy]));
    const check = verifyStoredReceiptHash(receipt.id);
    expect(check.status).toBe("no-stored-hash");
    expect(check.computedHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(check.storedHash).toBeNull();
  });

  it("reports not-found for unknown ids and empty storage", () => {
    expect(verifyStoredReceiptHash("missing-id").status).toBe("not-found");
    storage.setItem(STORAGE_KEY, "not json");
    expect(verifyStoredReceiptHash("missing-id").status).toBe("not-found");
  });
});
