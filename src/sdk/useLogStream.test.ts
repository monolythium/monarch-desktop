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
});
