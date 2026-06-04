import {
  MRV_FORMAT_VERSION,
  MRV_PROFILE_MONO_RV32IM_V1,
  MRV_TX_EXTENSION_KIND,
  MRV_TX_EXTENSION_V1,
  NO_EVM_RECEIPT_CODEC,
  NO_EVM_RECEIPT_PROOF_SCHEMA,
  NO_EVM_RECEIPT_PROOF_TYPE,
  NO_EVM_RECEIPT_ROOT_ALGORITHM,
  checkMrvFeeDisplayConformance,
  mrvV1TransactionExtension,
} from "@monolythium/core-sdk";
import type {
  OperatorCapabilitiesResponse,
  OperatorSurfaceCapability,
} from "@monolythium/core-sdk";

export type ReadinessTone = "ok" | "warn" | "err" | "info";

export type ReadinessSignal = {
  id: string;
  label: string;
  value: string;
  unit: string;
  tone: ReadinessTone;
};

export type MrvReadinessCategoryId = "mrv-runtime" | "no-evm-receipts" | "native-fees";

export type MrvReadinessCategory = {
  id: MrvReadinessCategoryId;
  label: string;
  state: "ready" | "pending" | "blocked" | "unknown";
  tone: ReadinessTone;
  source: "sdk" | "operatorCapabilities";
  surfaceKey: string | null;
  tracking: string | null;
};

export type MrvReadinessInput = {
  operatorCapabilities?: OperatorCapabilitiesResponse | null;
};

const MRV_SURFACE_KEYS = [
  "mrv_runtime",
  "mrv_native_tx",
  "mrv_deploy",
  "mrv_call",
  "mrv",
];

const NO_EVM_SURFACE_KEYS = [
  "no_evm_receipt_proof",
  "no_evm_receipts",
  "canonical_riscv_receipts",
  "native_receipts",
];

const NATIVE_FEE_SURFACE_KEYS = [
  "mrv_fee_display",
  "mrv_native_fees",
  "native_fee_display",
];

export function mrvReadinessSignal(input: MrvReadinessInput = {}): ReadinessSignal {
  const categories = mrvReadinessCategories(input);
  const tone = aggregateTone(categories);
  return {
    id: "mrv-no-evm-readiness",
    label: "MRV / no-EVM readiness",
    value: aggregateValue(tone),
    unit: `fmt v${MRV_FORMAT_VERSION}`,
    tone,
  };
}

export function mrvReadinessCategories(input: MrvReadinessInput = {}): MrvReadinessCategory[] {
  const surfaces = input.operatorCapabilities?.surfaces ?? {};
  return [
    readinessCategory({
      id: "mrv-runtime",
      label: "MRV runtime",
      surfaces,
      surfaceKeys: MRV_SURFACE_KEYS,
      sdkReady: sdkMrvRuntimeReady(),
    }),
    readinessCategory({
      id: "no-evm-receipts",
      label: "No-EVM receipts",
      surfaces,
      surfaceKeys: NO_EVM_SURFACE_KEYS,
      sdkReady: sdkNoEvmReceiptsReady(),
    }),
    readinessCategory({
      id: "native-fees",
      label: "Native fees",
      surfaces,
      surfaceKeys: NATIVE_FEE_SURFACE_KEYS,
      sdkReady: sdkNativeFeeDisplayReady(),
    }),
  ];
}

function readinessCategory(args: {
  id: MrvReadinessCategoryId;
  label: string;
  surfaces: OperatorCapabilitiesResponse["surfaces"];
  surfaceKeys: string[];
  sdkReady: boolean;
}): MrvReadinessCategory {
  const match = firstSurface(args.surfaces, args.surfaceKeys);
  if (match) {
    return {
      id: args.id,
      label: args.label,
      ...surfaceStatus(match.capability.status),
      source: "operatorCapabilities",
      surfaceKey: match.key,
      tracking: match.capability.tracking ?? null,
    };
  }

  return {
    id: args.id,
    label: args.label,
    state: args.sdkReady ? "ready" : "blocked",
    tone: args.sdkReady ? "ok" : "err",
    source: "sdk",
    surfaceKey: null,
    tracking: null,
  };
}

function firstSurface(
  surfaces: OperatorCapabilitiesResponse["surfaces"],
  keys: string[],
): { key: string; capability: OperatorSurfaceCapability } | null {
  for (const key of keys) {
    const capability = surfaces[key];
    if (capability) return { key, capability };
  }
  return null;
}

function surfaceStatus(status: string): Pick<MrvReadinessCategory, "state" | "tone"> {
  switch (status) {
    case "available":
      return { state: "ready", tone: "ok" };
    case "disabled":
      return { state: "blocked", tone: "err" };
    case "not_implemented":
    case "not_retained":
    case "ws_only":
      return { state: "pending", tone: "warn" };
    default:
      return { state: "unknown", tone: "info" };
  }
}

function aggregateTone(categories: MrvReadinessCategory[]): ReadinessTone {
  if (categories.some((category) => category.tone === "err")) return "err";
  if (categories.some((category) => category.tone === "warn")) return "warn";
  if (categories.some((category) => category.tone === "info")) return "info";
  return "ok";
}

function aggregateValue(tone: ReadinessTone): string {
  switch (tone) {
    case "ok":
      return "ready";
    case "warn":
      return "partial";
    case "err":
      return "blocked";
    case "info":
      return "unknown";
  }
}

function sdkMrvRuntimeReady(): boolean {
  const extension = mrvV1TransactionExtension();
  return (
    MRV_FORMAT_VERSION === 1 &&
    MRV_PROFILE_MONO_RV32IM_V1 === "mono_rv32im_v1" &&
    MRV_TX_EXTENSION_KIND === 0x30 &&
    MRV_TX_EXTENSION_V1 === 0x01 &&
    extension.kind === MRV_TX_EXTENSION_KIND &&
    extension.bodyHex === "0x01"
  );
}

function sdkNoEvmReceiptsReady(): boolean {
  return (
    NO_EVM_RECEIPT_PROOF_SCHEMA === "mono.no_evm_receipt_proof.v1" &&
    NO_EVM_RECEIPT_PROOF_TYPE === "canonicalReceiptsTranscript" &&
    NO_EVM_RECEIPT_CODEC === "bincode(protocore_execution_types::Receipt)" &&
    NO_EVM_RECEIPT_ROOT_ALGORITHM.startsWith(
      "keccak256-binary-merkle(monolythium/v4.1/receipt_leaf/1",
    )
  );
}

function sdkNativeFeeDisplayReady(): boolean {
  // 0.0005 LYTH at the canonical 18-decimal scale = 5e14 lythoshi.
  const report = checkMrvFeeDisplayConformance({
    expectedTotalLythoshi: "500000000000000",
    defaultFeeText: "0.0005 LYTH",
    detailTexts: ["cycles 42, state I/O 8, total 500000000000000 lythoshi"],
    structuredFee: {
      total_lythoshi: "500000000000000",
      total_lyth: "0.0005",
      cycles_used: 42,
      base_price_per_cycle_lythoshi: "1000",
      state_io_units: 8,
      state_io_price_per_unit_lythoshi: "250",
      priority_tip_lythoshi: "0",
    },
    customFeeInputVisible: false,
    speedUpCancelVisible: false,
  });
  return report.passed;
}
