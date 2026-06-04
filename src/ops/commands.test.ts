import { describe, expect, it } from "vitest";
import { commandFor, talosActionFor } from "./commands";
import type { OpRequest } from "./types";

function req(kind: OpRequest["kind"]): OpRequest {
  return {
    kind,
    title: kind,
    sub: "",
    intro: "",
    fields: [],
  };
}

describe("operation command mapping", () => {
  it("maps service lifecycle operations to Talos actions", () => {
    expect(talosActionFor(req("operator-start"))).toEqual({
      service: "ext-protocore",
      action: "start",
    });
    expect(talosActionFor(req("operator-stop"))).toEqual({
      service: "ext-protocore",
      action: "stop",
    });
    expect(talosActionFor(req("operator-restart"))).toEqual({
      service: "ext-protocore",
      action: "restart",
    });
  });

  it("does not dispatch dedicated production operations through shell commands", () => {
    expect(commandFor(req("operator-restore"))).toBeNull();
    expect(commandFor(req("chat-bootstrap-peers"))).toBeNull();
    expect(commandFor(req("rotate-keys"))).toBeNull();
    expect(commandFor(req("export-backup"))).toBeNull();
    expect(commandFor(req("cluster-swap"))).toBeNull();
    expect(commandFor(req("cluster-accept-invite"))).toBeNull();
    expect(commandFor(req("cluster-form"))).toBeNull();
    expect(commandFor(req("cluster-request-join"))).toBeNull();
    expect(commandFor(req("cluster-vote-admit"))).toBeNull();
    expect(commandFor(req("freeze-admission"))).toBeNull();
    expect(commandFor(req("emergency-key-rotation"))).toBeNull();
    expect(commandFor(req("ota-apply"))).toBeNull();
    expect(commandFor(req("ota-rollback"))).toBeNull();
  });
});
