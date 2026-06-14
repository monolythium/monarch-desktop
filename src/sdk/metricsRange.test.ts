import { describe, expect, it } from "vitest";
import type { MetricsRangeResponse } from "@monolythium/core-sdk";
import {
  formatMetricValue,
  latestMetricSample,
  metricLabel,
  metricUnitLabel,
  summarizeMetricsRange,
} from "./metricsRange";

describe("metricsRange view helpers", () => {
  it("formats canonical metric labels and units", () => {
    expect(metricLabel("committed_round")).toBe("Latest committed round");
    expect(metricLabel("p2p_bandwidth_in")).toBe("Network in");
    expect(metricLabel("custom_selector")).toBe("custom selector");
    expect(metricUnitLabel("basis_points")).toBe("%");
    expect(metricUnitLabel("bytes_per_second")).toBe("B/s");
    expect(metricUnitLabel("execution_units")).toBe("EU");
  });

  it("formats live metric values without fabricating missing samples", () => {
    expect(formatMetricValue(9_930, "basis_points")).toBe("99.3%");
    expect(formatMetricValue(1_536, "bytes_per_second")).toBe("1.5 KiB/s");
    expect(formatMetricValue(12.25, "ms")).toBe("12.3 ms");
    expect(formatMetricValue(null, "count")).toBe("-");
  });

  it("summarizes retained lyth_metricsRange series", () => {
    const response: MetricsRangeResponse = {
      schemaVersion: 1,
      range: [100, 102],
      tracking: "node-local",
      series: [
        {
          selector: "attestation_rate",
          status: "available",
          unit: "basis_points",
          samples: [
            { blockNumber: 100, value: 9_800 },
            { blockNumber: 102, value: 9_930 },
          ],
        },
        {
          selector: "finality_lag",
          status: "not_retained",
          unit: "blocks",
          samples: null,
        },
      ],
    };

    const summaries = summarizeMetricsRange(response);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      label: "Attestations",
      latestValue: "99.3%",
      latestRawValue: 9_930,
      latestBlock: 102,
      sampleCount: 2,
      delta: "+1.3 pp",
      tone: "ok",
      sparkline: [9_800, 9_930],
    });
    expect(summaries[1]).toMatchObject({
      latestValue: "-",
      sampleCount: 0,
      tone: "warn",
      sparkline: [],
    });
  });

  it("returns the newest sample only when one exists", () => {
    expect(latestMetricSample({ samples: null })).toBeNull();
    expect(latestMetricSample({ samples: [] })).toBeNull();
    expect(
      latestMetricSample({
        samples: [
          { blockNumber: 1, value: 2 },
          { blockNumber: 2, value: 3 },
        ],
      }),
    ).toEqual({ blockNumber: 2, value: 3 });
  });
});
