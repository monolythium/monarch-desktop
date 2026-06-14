import { describe, expect, it } from "vitest";
import type { OperatorCapabilitiesResponse } from "@monolythium/core-sdk";
import {
  mrvReadinessCategories,
  mrvReadinessSignal,
  type MrvReadinessCategoryId,
} from "./mrvReadiness";

const capabilities: OperatorCapabilitiesResponse = {
  schemaVersion: 1,
  surfaces: {
    mrv_native_tx: { status: "available" },
    no_evm_receipt_proof: { status: "not_implemented", tracking: "MD-CORE-0042" },
    mrv_native_fees: { status: "disabled" },
  },
};

function category(
  categories: ReturnType<typeof mrvReadinessCategories>,
  id: MrvReadinessCategoryId,
) {
  const found = categories.find((item) => item.id === id);
  expect(found).toBeDefined();
  return found!;
}

describe("MRV readiness signals", () => {
  it("replaces the legacy fee metric with operator-facing readiness text", () => {
    const signal = mrvReadinessSignal();
    const visibleText = `${signal.id} ${signal.label} ${signal.value} ${signal.unit}`;

    expect(visibleText).not.toMatch(/\bgas\b/iu);
    expect(signal).toMatchObject({
      id: "mrv-no-evm-readiness",
      label: "Runtime readiness",
      value: "Ready",
      tone: "ok",
    });
  });

  it("maps live operator capability statuses into the readiness metric", () => {
    const categories = mrvReadinessCategories({ operatorCapabilities: capabilities });

    expect(category(categories, "mrv-runtime")).toMatchObject({
      state: "ready",
      tone: "ok",
      source: "operatorCapabilities",
      surfaceKey: "mrv_native_tx",
    });
    expect(category(categories, "no-evm-receipts")).toMatchObject({
      state: "pending",
      tone: "warn",
      tracking: "MD-CORE-0042",
    });
    expect(category(categories, "native-fees")).toMatchObject({
      state: "blocked",
      tone: "err",
    });

    expect(mrvReadinessSignal({ operatorCapabilities: capabilities })).toMatchObject({
      value: "Blocked",
      tone: "err",
    });
  });
});
