import { describe, expect, it } from "vitest";
import { DEFAULT_RPC_PORT, normalizeNodeEndpoint } from "./setupProbe";

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
