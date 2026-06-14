import type { OperationReceiptMeta } from "./receipts";
import type { OpRequest, OpResult } from "./types";

export type BlockedOperationOutcome = {
  result: OpResult;
  meta: OperationReceiptMeta;
};

export function browserExecutionBlocked(req: OpRequest): BlockedOperationOutcome {
  return {
    result: {
      ok: false,
      message: `${req.title} needs Monarch Desktop with a connected node control channel.`,
    },
    meta: { transport: "blocked" },
  };
}

export function unsignedExecutionBlocked(req: OpRequest): BlockedOperationOutcome {
  return {
    result: {
      ok: false,
      message: `${req.title} is not available in this version of Monarch Desktop.`,
    },
    meta: { transport: "blocked" },
  };
}
