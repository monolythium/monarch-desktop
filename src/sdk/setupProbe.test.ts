import { afterEach, describe, expect, it, vi } from "vitest";
import { SdkError } from "@monolythium/core-sdk";
import {
  DEFAULT_RPC_PORT,
  isMethodRestricted,
  normalizeNodeEndpoint,
  probeNodeEndpoint,
} from "./setupProbe";

describe("normalizeNodeEndpoint", () => {
  it("defaults a bare host/IP to http on the chain RPC port", () => {
    expect(normalizeNodeEndpoint("178.105.12.9")).toBe(
      `http://178.105.12.9:${DEFAULT_RPC_PORT}`,
    );
    expect(normalizeNodeEndpoint("node.example.com")).toBe(
      `http://node.example.com:${DEFAULT_RPC_PORT}`,
    );
  });

  it("keeps an explicit host:port and defaults the scheme to http", () => {
    expect(normalizeNodeEndpoint("178.105.12.9:9933")).toBe("http://178.105.12.9:9933");
  });

  it("accepts a full http(s) URL and strips the trailing slash", () => {
    expect(normalizeNodeEndpoint("https://rpc.monolythium.com:8545/")).toBe(
      "https://rpc.monolythium.com:8545",
    );
    expect(normalizeNodeEndpoint("http://127.0.0.1:8545")).toBe("http://127.0.0.1:8545");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeNodeEndpoint("   10.0.0.20   ")).toBe(
      `http://10.0.0.20:${DEFAULT_RPC_PORT}`,
    );
  });

  it("rejects empty input", () => {
    expect(() => normalizeNodeEndpoint("")).toThrow(/enter your node/i);
    expect(() => normalizeNodeEndpoint("   ")).toThrow(/enter your node/i);
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() => normalizeNodeEndpoint("ws://10.0.0.20:8545")).toThrow(/http/i);
    expect(() => normalizeNodeEndpoint("ftp://example.com")).toThrow(/http/i);
  });
});

describe("isMethodRestricted", () => {
  it("treats a JSON-RPC -32045 'method disabled' answer as reachable", () => {
    expect(isMethodRestricted(SdkError.rpc(-32045, "method disabled"))).toBe(true);
  });

  it("treats a JSON-RPC -32601 'method not found' answer as reachable", () => {
    expect(isMethodRestricted(SdkError.rpc(-32601, "method not found"))).toBe(true);
  });

  it("treats any rpc-kind SdkError as an answer (the node responded)", () => {
    expect(isMethodRestricted(SdkError.rpc(-32000, "execution error"))).toBe(true);
  });

  it("matches the disabled code/message even without the SdkError wrapper", () => {
    expect(isMethodRestricted({ code: -32045 })).toBe(true);
    expect(isMethodRestricted(new Error("rpc error -32045: method disabled"))).toBe(true);
    expect(isMethodRestricted(new Error("method not found"))).toBe(true);
  });

  it("does NOT classify a transport failure as method-restricted", () => {
    expect(isMethodRestricted(SdkError.transport("connection refused"))).toBe(false);
    expect(isMethodRestricted(new Error("fetch failed"))).toBe(false);
    expect(isMethodRestricted(new Error("request timed out"))).toBe(false);
  });
});

describe("probeNodeEndpoint reachability classification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Build a `fetch` stub that returns the same JSON-RPC reply to every call.
  function stubRpc(reply: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...reply }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  }

  it("classifies a reachable-but-eth-disabled node (chain id -32045) as reachable", async () => {
    // Every eth_* call answers with a structured 'method disabled' error — the
    // node IS up and serving RPC, it just won't expose the eth_* namespace.
    stubRpc({ error: { code: -32045, message: "method disabled" } });
    const result = await probeNodeEndpoint("http://10.0.0.20:8545", { timeoutMs: 500 });
    expect(result.outcome).toBe("ok");
    expect(result.chainId).toBeNull();
    expect(result.error).toBeNull();
  });

  it("does not flag an eth-disabled node as wrong-chain even with an expectedChainId", async () => {
    stubRpc({ error: { code: -32045, message: "method disabled" } });
    const result = await probeNodeEndpoint("http://10.0.0.20:8545", {
      timeoutMs: 500,
      expectedChainId: 69420,
    });
    // No chain id could be read, so there is nothing to mismatch — reachable.
    expect(result.outcome).toBe("ok");
    expect(result.chainId).toBeNull();
  });

  it("reports a node that refuses the connection as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const result = await probeNodeEndpoint("http://10.0.0.20:8545", { timeoutMs: 500 });
    expect(result.outcome).toBe("unreachable");
  });

  it("reads the chain id normally when eth_chainId is enabled", async () => {
    // chain 69420 = 0x10f2c; enrichment calls return harmless values/errors.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? init.body : "";
        const method = JSON.parse(body).method as string;
        const result =
          method === "eth_chainId"
            ? "0x10f2c"
            : method === "eth_blockNumber"
              ? "0x1"
              : method === "eth_syncing"
                ? false
                : "protocore/test";
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const result = await probeNodeEndpoint("http://10.0.0.20:8545", { timeoutMs: 500 });
    expect(result.outcome).toBe("ok");
    expect(result.chainId).toBe(69420);
  });
});
