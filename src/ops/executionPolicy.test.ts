import { describe, expect, it } from "vitest";
import {
  browserExecutionBlocked,
  unsignedExecutionBlocked,
} from "./executionPolicy";
import type { OpRequest } from "./types";

const request: OpRequest = {
  kind: "rotate-keys",
  title: "Rotate signing share",
  sub: "DVT DKG re-share",
  intro: "Runs the cluster DKG re-share.",
  fields: [],
};

describe("operation execution policy", () => {
  it("blocks browser-only operation attempts instead of creating success previews", () => {
    const outcome = browserExecutionBlocked(request);

    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.message).toContain("needs Monarch Desktop");
    expect(outcome.result.message).not.toMatch(/completed/i);
    expect(outcome.meta.transport).toBe("blocked");
  });

  it("blocks unsupported signed operations until a production path exists", () => {
    const outcome = unsignedExecutionBlocked(request);

    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.message).toContain("not available in this version");
    expect(outcome.meta.transport).toBe("blocked");
  });

});
