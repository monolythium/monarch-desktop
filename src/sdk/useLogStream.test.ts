import { describe, expect, it } from "vitest";
import { parseJournaldLine } from "./useLogStream";

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
