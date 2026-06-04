import { describe, expect, it } from "vitest";
import {
  appendOperationReceipt,
  clearOperationReceipts,
  createOperationReceipt,
  isAuditReadyOperationReceipt,
  operationReceiptAuditHash,
  readOperationReceipts,
} from "./receipts";
import type { OpRequest } from "./types";

const request: OpRequest = {
  kind: "operator-restart",
  title: "Graceful restart",
  sub: "Cycle ext-protocore",
  intro: "Restart the service through Talos API.",
  fields: [],
};

describe("operation receipts", () => {
  it("captures operation, result, and transport metadata", () => {
    const receipt = createOperationReceipt(
      request,
      { ok: true, message: "submitted", txHash: "0xabc" },
      {
        transport: "talos",
        service: "ext-protocore",
        action: "restart",
        endpoint: "127.0.0.1:50000",
        nodeAddress: "127.0.0.1",
        artifactPath: "/tmp/protocore.tar.gz",
        artifactSha256: "a".repeat(64),
      },
    );

    expect(receipt.id).toBeTruthy();
    expect(receipt.kind).toBe("operator-restart");
    expect(receipt.status).toBe("ok");
    expect(receipt.txHash).toBe("0xabc");
    expect(receipt.transport).toBe("talos");
    expect(receipt.service).toBe("ext-protocore");
    expect(receipt.action).toBe("restart");
    expect(receipt.artifactPath).toBe("/tmp/protocore.tar.gz");
    expect(receipt.artifactSha256).toBe("a".repeat(64));
    expect(receipt.auditPayloadSchema).toBe("monarch-desktop-operation-receipt/v1");
    expect(receipt.auditPayloadHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.auditPayloadHash).toBe(operationReceiptAuditHash(receipt));
    expect(isAuditReadyOperationReceipt(receipt)).toBe(true);
  });

  it("works without browser storage", () => {
    clearOperationReceipts();
    const before = readOperationReceipts();
    const receipt = createOperationReceipt(
      request,
      { ok: false, message: "blocked" },
      { transport: "blocked" },
    );
    const after = appendOperationReceipt(receipt);
    const stored = after[0];
    expect(stored).toBeDefined();

    expect(before).toEqual([]);
    expect(stored).toMatchObject({
      id: receipt.id,
      status: "error",
      transport: "blocked",
    });
    expect(isAuditReadyOperationReceipt(stored!)).toBe(true);
  });
});
