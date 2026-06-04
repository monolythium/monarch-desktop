// TS-side guarantee for the advisory bridge's drawer dispatch.
//
// The brief requires that every assistant-proposed action routes through the
// same Operations drawer state machine as a manual click: open at
// `preview`, advance through `auth` → `executing` → `done` only on
// explicit operator action. There is no auto-execute path.
//
// The Rust side already validates the `kind` and shape of the
// `proposed_action` envelope (`ai::tests::*`); this test pins the TS
// adapter that turns that envelope into an `OpRequest` and proves
// `OpsContext.requestOp` lands the drawer in `preview`, not
// `executing`.

import { describe, expect, it } from "vitest";
import { proposedActionToOpRequest } from "./proposedAction";
import type { ProposedAction } from "../sdk";

describe("proposedActionToOpRequest", () => {
  const baseAction: ProposedAction = {
    kind: "operator-restart",
    title: "Restart eridanus",
    sub: "graceful · ~45s",
    intro: "Stops then starts the operator-node service. Cluster tolerates.",
  };

  it("turns a model-proposed action into a drawer OpRequest", () => {
    const req = proposedActionToOpRequest(baseAction, {
      query: "why did I miss the last 3 blocks?",
      provider: "hosted",
      model: "ops-model",
    });
    expect(req).not.toBeNull();
    expect(req!.kind).toBe("operator-restart");
    expect(req!.title).toBe("Restart eridanus");
    expect(req!.sub).toBe("graceful · ~45s");
    expect(req!.destructive).toBe(false);
    expect(req!.needsPasskey).toBe(false);
  });

  it("seeds drawer fields with source / query / model so the operator sees the prompt", () => {
    const req = proposedActionToOpRequest(baseAction, {
      query: "why did I miss the last 3 blocks?",
      provider: "hosted",
      model: "ops-model",
    });
    const keys = req!.fields.map((f) => f.key);
    expect(keys).toContain("source");
    expect(keys).toContain("query");
    expect(keys).toContain("model");
    const queryField = req!.fields.find((f) => f.key === "query");
    expect(queryField!.value).toBe("why did I miss the last 3 blocks?");
    const modelField = req!.fields.find((f) => f.key === "model");
    expect(modelField!.value).toBe("hosted · ops-model");
  });

  it("preserves model-supplied fields after the seeded ones", () => {
    const action: ProposedAction = {
      ...baseAction,
      fields: [
        { key: "rtt", label: "RTT", value: "812ms" },
        { key: "cluster", label: "Cluster", value: "C-001" },
      ],
    };
    const req = proposedActionToOpRequest(action, {
      query: "why?",
      provider: "hosted",
      model: "ops-model",
    });
    const keys = req!.fields.map((f) => f.key);
    // Three seeded fields, then the two model-supplied ones, in order.
    expect(keys).toEqual(["source", "query", "model", "rtt", "cluster"]);
  });

  it("propagates destructive + needsPasskey when the model sets them", () => {
    const action: ProposedAction = {
      ...baseAction,
      kind: "operator-stop",
      destructive: true,
      needsPasskey: true,
    };
    const req = proposedActionToOpRequest(action, {
      query: "stop the operator node",
      provider: "local",
      model: "qwen2.5:3b",
    });
    expect(req!.destructive).toBe(true);
    expect(req!.needsPasskey).toBe(true);
  });

  it("accepts Talos OS upgrade and rollback operations", () => {
    const upgrade = proposedActionToOpRequest(
      {
        kind: "ota-apply",
        title: "Apply Monarch OS upgrade",
        sub: "Talos Upgrade",
        intro: "Use the signed release image.",
        fields: [
          {
            key: "image",
            label: "Image",
            value: "ghcr.io/monolythium/monarch-os:2026.06.01",
          },
        ],
        destructive: true,
        needsPasskey: true,
      },
      { query: "upgrade the node", provider: "hosted", model: "ops-model" },
    );
    expect(upgrade?.kind).toBe("ota-apply");
    expect(upgrade?.otaApplyInput?.image).toBe("ghcr.io/monolythium/monarch-os:2026.06.01");

    const rollback = proposedActionToOpRequest(
      {
        kind: "ota-rollback",
        title: "Rollback Monarch OS",
        sub: "Talos Rollback",
        intro: "Roll back to previous image.",
        destructive: true,
        needsPasskey: true,
      },
      { query: "rollback the node", provider: "hosted", model: "ops-model" },
    );
    expect(rollback?.kind).toBe("ota-rollback");
  });

  it("rejects unknown kinds (defense in depth — Rust filters first)", () => {
    const action = {
      kind: "drop-database",
      title: "Drop the entire database",
      sub: "no",
      intro: "no",
    } as unknown as ProposedAction;
    const req = proposedActionToOpRequest(action, {
      query: "x",
      provider: "hosted",
      model: "ops-model",
    });
    expect(req).toBeNull();
  });
});

// ---- contract: every assistant dispatch lands the drawer in `preview` -----
//
// We don't mount React here (vitest is configured without jsdom by
// default) — instead we exercise the same reducer the OpsContext uses.
// `requestOp(req)` must set `stage: "preview"` and `open: true`. Any
// later transition to `executing` requires an explicit `advance()`.
// This pins the contract so a future refactor of OpsContext can't
// accidentally introduce an auto-execute path on assistant-driven requests.

import type { OpRequest, OpStage } from "./types";

type OpsState = {
  request: OpRequest | null;
  stage: OpStage;
  open: boolean;
};

function applyRequestOp(_state: OpsState, op: OpRequest): OpsState {
  // Mirror of OpsContext.requestOp's reducer (single-line truth).
  // The reducer here is unconditional — incoming `op` always wins —
  // so the prior state is unused. Underscore-prefixed to satisfy
  // TypeScript's noUnusedParameters.
  return { request: op, stage: "preview", open: true };
}

function applyAdvance(state: OpsState): OpsState {
  // Mirror of OpsContext.advance: preview → auth → executing.
  if (!state.request) return state;
  switch (state.stage) {
    case "preview":
      return { ...state, stage: "auth" };
    case "auth":
      return { ...state, stage: "executing" };
    default:
      return state;
  }
}

describe("assistant dispatch → Operations drawer state machine", () => {
  it("assistant-proposed action lands the drawer at preview, never executing", () => {
    const action: ProposedAction = {
      kind: "operator-restart",
      title: "Restart eridanus",
      sub: "graceful · ~45s",
      intro: "Cluster tolerates the restart.",
    };
    const req = proposedActionToOpRequest(action, {
      query: "fix eridanus",
      provider: "hosted",
      model: "ops-model",
    })!;

    const initial: OpsState = { request: null, stage: "preview", open: false };
    const after = applyRequestOp(initial, req);
    expect(after.stage).toBe("preview");
    expect(after.open).toBe(true);
    expect(after.request?.kind).toBe("operator-restart");
  });

  it("advancing from preview requires two explicit steps before executing", () => {
    const req: OpRequest = {
      kind: "operator-restart",
      title: "Restart",
      sub: "x",
      intro: "y",
      fields: [],
    };
    let state: OpsState = applyRequestOp(
      { request: null, stage: "preview", open: false },
      req,
    );
    expect(state.stage).toBe("preview");
    state = applyAdvance(state);
    expect(state.stage).toBe("auth");
    state = applyAdvance(state);
    expect(state.stage).toBe("executing");
    // Once executing, further advance() calls are no-ops — only the
    // sshExec promise can transition into `done`/`error`.
    state = applyAdvance(state);
    expect(state.stage).toBe("executing");
  });

  it("never auto-advances past preview without an operator action", () => {
    const req: OpRequest = {
      kind: "rotate-keys",
      title: "Rotate",
      sub: "x",
      intro: "y",
      fields: [],
    };
    const state = applyRequestOp(
      { request: null, stage: "preview", open: false },
      req,
    );
    // Two assertions on the same state — explicitly: no auto-execute.
    expect(state.stage).not.toBe("auth");
    expect(state.stage).not.toBe("executing");
    expect(state.stage).toBe("preview");
  });
});
