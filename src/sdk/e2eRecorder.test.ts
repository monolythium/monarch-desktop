import { describe, expect, it, vi } from "vitest";

describe("Monarch e2e recorder", () => {
  it("stays disabled by default", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_MONARCH_E2E_RECORDER", "false");
    vi.stubGlobal("window", {});
    const recorder = await import("./e2eRecorder");

    recorder.installMonarchE2eRecorder();
    recorder.recordE2eRoute("/chat");
    recorder.recordE2eCommand("chat_send_message");
    recorder.setE2eWindowsObserved(2);

    expect(window.__MONARCH_E2E__).toBeUndefined();
    expect(recorder.e2eSnapshot()).toEqual({
      routesVisited: [],
      commandsObserved: [],
      windowsObserved: 1,
    });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("records routes, commands, and observed windows when explicitly enabled", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_MONARCH_E2E_RECORDER", "true");
    vi.stubGlobal("window", {});
    const recorder = await import("./e2eRecorder");

    const collectReadiness = async () => ({ ok: true });
    recorder.installMonarchE2eRecorder({ collectReadiness });
    recorder.recordE2eRoute("/");
    recorder.recordE2eRoute("/chat");
    recorder.recordE2eCommand("talos_config_info");
    recorder.recordE2eCommand("talos_config_info");
    recorder.recordE2eCommand("chat_send_message");
    recorder.setE2eWindowsObserved(2);

    expect(window.__MONARCH_E2E__?.snapshot()).toEqual({
      routesVisited: ["/chat", "/home"],
      commandsObserved: ["talos_config_info", "chat_send_message"],
      windowsObserved: 2,
    });
    await expect(window.__MONARCH_E2E__?.collectReadiness?.()).resolves.toEqual({ ok: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
