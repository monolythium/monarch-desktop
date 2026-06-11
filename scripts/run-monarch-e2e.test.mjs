import { describe, expect, it } from "vitest";
import { resolveDesktopRpcEndpoint } from "./lib/desktop-rpc-endpoint.mjs";

describe("run-monarch-e2e endpoint resolution", () => {
  it("uses the QEMU smoke RPC before generic app RPC defaults", () => {
    const endpoint = resolveDesktopRpcEndpoint(
      {},
      { MONARCH_E2E_RPC_ENDPOINT: "http://127.0.0.1:18545" },
      {
        VITE_RPC_ENDPOINT: "http://127.0.0.1:8545",
        TAURI_RPC_ENDPOINT: "http://127.0.0.1:8545",
      },
    );

    expect(endpoint).toBe("http://127.0.0.1:18545");
  });

  it("keeps explicit desktop endpoint overrides above the smoke RPC", () => {
    const endpoint = resolveDesktopRpcEndpoint(
      {},
      { MONARCH_E2E_RPC_ENDPOINT: "http://127.0.0.1:18545" },
      {
        MONARCH_E2E_DESKTOP_RPC_ENDPOINT: "https://rpc.monolythium.com",
        VITE_RPC_ENDPOINT: "http://127.0.0.1:8545",
      },
    );

    expect(endpoint).toBe("https://rpc.monolythium.com");
  });
});
