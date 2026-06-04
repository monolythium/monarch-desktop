import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge", () => ({
  isNoSessionError: (err: unknown) => {
    const message = (err as Error)?.message ?? String(err);
    return /no active ssh session/i.test(message);
  },
  sshExec: vi.fn(),
}));

import { sshExec } from "./bridge";
import { runNetworkDiagnostic } from "./networkDiagnostics";

describe("runNetworkDiagnostic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs diagnostics through the active SSH session", async () => {
    vi.mocked(sshExec).mockResolvedValue("PING 10.0.0.2\n0% packet loss\n");

    const result = await runNetworkDiagnostic("ping", "10.0.0.2");

    expect(result).toMatchObject({
      kind: "ping",
      target: "10.0.0.2",
      ran: true,
      preview: false,
      output: "PING 10.0.0.2\n0% packet loss",
    });
    expect(sshExec).toHaveBeenCalledWith(expect.stringContaining("ping -c 8"));
  });

  it("does not fabricate ping or traceroute samples without a live session", async () => {
    vi.mocked(sshExec).mockRejectedValue(
      new Error("no active ssh session - running outside Tauri"),
    );

    const ping = await runNetworkDiagnostic("ping", "validator-1");
    const trace = await runNetworkDiagnostic("traceroute", "validator-1");

    expect(ping).toMatchObject({ ran: false, preview: false });
    expect(trace).toMatchObject({ ran: false, preview: false });
    expect(`${ping.output}\n${trace.output}`).toContain("not run");
    expect(`${ping.output}\n${trace.output}`).not.toMatch(
      /packets transmitted|rtt min|regional-edge|testnet-peer/i,
    );
  });
});
