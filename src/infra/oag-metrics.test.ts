import { describe, expect, it, beforeEach } from "vitest";
import {
  incrementOagMetric,
  getOagMetrics,
  getOagMetricsEntries,
  resetOagMetrics,
} from "./oag-metrics.js";

describe("oag-metrics", () => {
  beforeEach(() => {
    resetOagMetrics();
  });

  it("starts with all counters at zero", () => {
    const metrics = getOagMetrics();
    expect(metrics.channelRestarts).toBe(0);
    expect(metrics.deliveryRecoveries).toBe(0);
    expect(metrics.noteDeliveries).toBe(0);
  });

  it("increments a counter by 1 by default", () => {
    incrementOagMetric("channelRestarts");
    incrementOagMetric("channelRestarts");
    expect(getOagMetrics().channelRestarts).toBe(2);
  });

  it("increments a counter by a custom amount", () => {
    incrementOagMetric("deliveryRecoveries", 5);
    expect(getOagMetrics().deliveryRecoveries).toBe(5);
  });

  it("returns a snapshot copy, not a reference", () => {
    incrementOagMetric("noteDeliveries");
    const snapshot = getOagMetrics();
    incrementOagMetric("noteDeliveries");
    expect(snapshot.noteDeliveries).toBe(1);
    expect(getOagMetrics().noteDeliveries).toBe(2);
  });

  it("formats entries with snake_case metric names", () => {
    incrementOagMetric("channelRestarts", 3);
    incrementOagMetric("stalePollDetections", 1);
    const entries = getOagMetricsEntries();
    const restart = entries.find((e) => e.name === "oag_channel_restarts");
    expect(restart).toBeDefined();
    expect(restart?.value).toBe(3);
    const poll = entries.find((e) => e.name === "oag_stale_poll_detections");
    expect(poll).toBeDefined();
    expect(poll?.value).toBe(1);
  });

  it("resets all counters to zero", () => {
    incrementOagMetric("channelRestarts", 10);
    incrementOagMetric("noteDeliveries", 5);
    resetOagMetrics();
    const metrics = getOagMetrics();
    expect(metrics.channelRestarts).toBe(0);
    expect(metrics.noteDeliveries).toBe(0);
  });
});
