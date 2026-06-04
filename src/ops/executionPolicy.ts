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
      message: `${req.title} was not executed. Browser preview has no Talos, SSH, keychain, or signing control channel.`,
    },
    meta: { transport: "blocked" },
  };
}

export function unsignedExecutionBlocked(req: OpRequest): BlockedOperationOutcome {
  return {
    result: {
      ok: false,
      message: `${req.title} is not wired to a signed production path yet.`,
    },
    meta: { transport: "blocked" },
  };
}

export function clusterJoinExecutionBlocked(req: OpRequest): BlockedOperationOutcome {
  return {
    result: {
      ok: false,
      message: `${req.title} was not executed. CJ-1 cluster-vote admission is not live on this chain/runtime yet.`,
    },
    meta: { transport: "blocked" },
  };
}

export function clusterFormExecutionBlocked(req: OpRequest): BlockedOperationOutcome {
  return {
    result: {
      ok: false,
      message: `${req.title} was not executed. Cluster formation still needs the on-chain formation primitive and SDK submit helper.`,
    },
    meta: { transport: "blocked" },
  };
}
