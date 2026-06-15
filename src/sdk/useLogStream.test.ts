import { describe, expect, it } from "vitest";
import {
  MONARCH_OS_TARGET,
  parseJournaldLine,
  resolveTalosFollowError,
  resolveTalosOpenFailure,
  resolveTalosOpenStatus,
} from "./useLogStream";

describe("parseJournaldLine", () => {
  it("drops empty journald payloads instead of rendering placeholders", () => {
    expect(parseJournaldLine('{"SYSLOG_IDENTIFIER":"monod","MESSAGE":""}')).toBeNull();
    expect(parseJournaldLine('{"SYSLOG_IDENTIFIER":"monod"}')).toBeNull();
  });

  it("normalizes useful journald entries for the log view", () => {
    expect(
      parseJournaldLine(
        '{"__REALTIME_TIMESTAMP":"1710000000123456","PRIORITY":"4","SYSLOG_IDENTIFIER":"monod","MESSAGE":"peer connected"}',
      ),
    ).toMatchObject({
      lvl: "WARN",
      src: "monod",
      msg: "peer connected",
    });
  });

  it("renders protocore tracing-subscriber json (--log-format json) lines", () => {
    const entry = parseJournaldLine(
      '{"timestamp":"2026-06-15T12:34:56.789012Z","level":"INFO","target":"protocore::node","message":"committed round 13120"}',
    );
    expect(entry).toMatchObject({
      ts: "12:34:56.789",
      lvl: "INFO",
      src: "protocore::node",
      msg: "committed round 13120",
    });
  });

  it("maps protocore error/warn levels and nested fields.message", () => {
    expect(
      parseJournaldLine(
        '{"timestamp":"2026-06-15T01:02:03Z","level":"ERROR","target":"protocore","fields":{"message":"seal pool degraded"}}',
      ),
    ).toMatchObject({
      lvl: "ERROR",
      src: "protocore",
      msg: "seal pool degraded",
    });
    expect(
      parseJournaldLine(
        '{"timestamp":"2026-06-15T01:02:03Z","level":"WARN","msg":"peer slow"}',
      ),
    ).toMatchObject({ lvl: "WARN", msg: "peer slow" });
  });

  it("renders plain (non-json) service-log lines verbatim", () => {
    expect(
      parseJournaldLine("[protocore] starting node, chain-id 69420"),
    ).toMatchObject({
      src: "raw",
      msg: "[protocore] starting node, chain-id 69420",
    });
  });

  it("drops only genuinely empty lines", () => {
    expect(parseJournaldLine("   ")).toBeNull();
    expect(parseJournaldLine("")).toBeNull();
  });
});

describe("Talos log-stream status honesty (monarch-desktop log panel)", () => {
  const target = MONARCH_OS_TARGET;

  it("treats a follow error as a benign close once the node is proven reachable", () => {
    // The one-shot prime reached Talos (node + log API answered). A later
    // follow-stream hiccup must NOT tell the operator the stream failed.
    expect(
      resolveTalosFollowError(
        target,
        { primeReached: true, sawAnyLine: false, primeError: null },
        "transport closed",
      ),
    ).toEqual({ kind: "ended", target });

    // Same once any line has been seen, even if the prime did not "reach".
    expect(
      resolveTalosFollowError(
        target,
        { primeReached: false, sawAnyLine: true, primeError: null },
        "stream reset",
      ),
    ).toEqual({ kind: "ended", target });
  });

  it("surfaces a hard error only when nothing ever proved the node serves logs", () => {
    expect(
      resolveTalosFollowError(
        target,
        { primeReached: false, sawAnyLine: false, primeError: null },
        "connection refused",
      ),
    ).toEqual({ kind: "error", target, error: "connection refused" });
  });

  it("calls a reachable-but-empty stream 'quiet', not 'streaming' and not 'error'", () => {
    expect(
      resolveTalosOpenStatus(target, 7, {
        primeReached: true,
        sawAnyLine: false,
        primeError: null,
      }),
    ).toEqual({ kind: "talos-quiet", target, sessionId: 7 });

    expect(
      resolveTalosOpenStatus(target, 7, {
        primeReached: true,
        sawAnyLine: true,
        primeError: null,
      }),
    ).toEqual({ kind: "talos-streaming", target, sessionId: 7 });
  });

  it("prefers the prime's real reason when the follow stream cannot open and the node was never reached", () => {
    expect(
      resolveTalosOpenFailure(
        target,
        {
          primeReached: false,
          sawAnyLine: false,
          primeError: "tls handshake failed",
        },
        "generic follow error",
      ),
    ).toEqual({ kind: "error", target, error: "tls handshake failed" });
  });

  it("does not paint a failure when the follow stream cannot open but the prime reached the node", () => {
    expect(
      resolveTalosOpenFailure(
        target,
        { primeReached: true, sawAnyLine: false, primeError: null },
        "follow unavailable",
      ),
    ).toEqual({ kind: "ended", target });
  });
});
