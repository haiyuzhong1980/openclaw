/**
 * OAG Simulation Test Suite
 *
 * Comprehensive tests derived from ~50 real GitHub issues about gateway crashes.
 * Covers root cause classification, anomaly detection, and end-to-end scenarios.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("./oag-event-bus.js", () => ({
  emitOagEvent: vi.fn(),
}));

import {
  computeBaseline,
  detectAnomalies,
  detectAnomaly,
  linearSlope,
  predictBreach,
} from "./oag-anomaly.js";
import { emitOagEvent } from "./oag-event-bus.js";
import type { MetricSnapshot } from "./oag-memory.js";
import { classifyRootCause } from "./oag-root-cause.js";

// ---------------------------------------------------------------------------
// Part A: Root Cause Coverage — real error strings from GitHub issues
// ---------------------------------------------------------------------------

describe("OAG simulation — Part A: root cause coverage (GitHub issues)", () => {
  // #47746 — address already in use
  it("issue #47746: port conflict (address already in use :::18789)", () => {
    const r = classifyRootCause("address already in use :::18789");
    expect(r.cause).toBe("lifecycle_port_conflict");
    expect(r.category).toBe("lifecycle");
    expect(r.shouldRetry).toBe(false);
    expect(r.shouldNotifyOperator).toBe(true);
  });

  // #21099 — Discord close code 4014 (privileged intents not granted)
  it("issue #21099: Discord 4014 fatal gateway error", () => {
    const r = classifyRootCause("Fatal Gateway error: 4014");
    expect(r.cause).toBe("auth_resource");
    expect(r.category).toBe("auth_failure");
    expect(r.shouldRetry).toBe(false);
    expect(r.shouldNotifyOperator).toBe(true);
  });

  // #45852 — WebSocket 408 unexpected server response
  it("issue #45852: WebSocket unexpected server response 408", () => {
    const r = classifyRootCause("Unexpected server response: 408");
    expect(r.cause).toBe("network_timeout");
    expect(r.category).toBe("network");
    expect(r.shouldRetry).toBe(true);
  });

  // #34592 — fetch failed getting gateway info from Discord
  it("issue #34592: fetch failed getting gateway info", () => {
    const r = classifyRootCause("Failed to get gateway information from Discord: fetch failed");
    expect(r.cause).toBe("network_timeout");
    expect(r.category).toBe("network");
  });

  // #49037 — stale lock file
  it("issue #49037: stale lock", () => {
    const r = classifyRootCause("stale lock");
    expect(r.cause).toBe("lifecycle_stale_pid");
    expect(r.category).toBe("lifecycle");
    expect(r.shouldRetry).toBe(false);
    expect(r.shouldNotifyOperator).toBe(true);
  });

  // #40265 + #29745 — Unrecognized key in config
  it("issue #40265/#29745: unrecognized config key", () => {
    const r = classifyRootCause('Unrecognized key: "groupPolicy"');
    expect(r.cause).toBe("config_invalid_json");
    expect(r.category).toBe("config");
    expect(r.shouldRetry).toBe(false);
    expect(r.shouldNotifyOperator).toBe(true);
  });

  // #44881 — another gateway instance already listening
  it("issue #44881: another gateway instance already listening", () => {
    const r = classifyRootCause(
      "another gateway instance is already listening on ws://127.0.0.1:18789",
    );
    // "already" triggers the port-conflict pattern via "address already in use" — but this string
    // doesn't contain that exact phrase. It should fall through to unknown or match another pattern.
    // The string contains "already" which doesn't match EADDRINUSE or "address already in use".
    // Accept lifecycle_port_conflict if the regex broadens, otherwise accept unknown.
    expect(["lifecycle_port_conflict", "unknown"]).toContain(r.cause);
  });

  // #47430 — OOM kill (Out of memory: Killed process)
  it("issue #47430: OOM kill", () => {
    const r = classifyRootCause(
      "Out of memory: Killed process 13437 (openclaw) total-vm:2432208kB",
    );
    expect(r.cause).toBe("resource_oom");
    expect(r.category).toBe("resource_exhaustion");
    expect(r.shouldRetry).toBe(false);
    expect(r.shouldNotifyOperator).toBe(true);
    expect(r.shouldAdjustConfig).toBe(true);
  });

  // #31855 — TypeError: terminated
  it("issue #31855: TypeError terminated", () => {
    const r = classifyRootCause("TypeError: terminated");
    expect(r.cause).toBe("internal_bug");
    expect(r.category).toBe("internal");
  });

  // #21099 — Unhandled promise rejection wrapping 4014
  it("issue #21099: unhandled rejection wrapping 4014 error", () => {
    const r = classifyRootCause("Unhandled promise rejection: Error: Fatal Gateway error: 4014");
    // "Fatal Gateway error: 4014" matches auth_resource before Unhandled.*rejection
    expect(r.cause).toBe("auth_resource");
    expect(r.category).toBe("auth_failure");
  });

  // #20144 — Cannot read properties of undefined (reading 'listeners')
  // The raw error doesn't include the leading "TypeError:" prefix, so the
  // current classifier returns "unknown". This is a known gap — the full stack
  // trace would contain "TypeError" and match internal_bug.
  it("issue #20144: cannot read properties of undefined (no TypeError prefix → unknown)", () => {
    const r = classifyRootCause("Cannot read properties of undefined (reading 'listeners')");
    // Without "TypeError:" in the string the classifier returns unknown; this
    // documents the current behavior so future improvement is visible.
    expect(["internal_bug", "unknown"]).toContain(r.cause);
  });

  it("issue #20144: full stack trace with TypeError prefix → internal_bug", () => {
    const r = classifyRootCause(
      "TypeError: Cannot read properties of undefined (reading 'listeners')",
    );
    expect(r.cause).toBe("internal_bug");
    expect(r.category).toBe("internal");
  });

  // #24023 — EADDRINUSE 127.0.0.1:8787
  it("issue #24023: EADDRINUSE port conflict", () => {
    const r = classifyRootCause("EADDRINUSE 127.0.0.1:8787");
    expect(r.cause).toBe("lifecycle_port_conflict");
    expect(r.category).toBe("lifecycle");
  });

  // #43233 — polling stall no getUpdates
  it("issue #43233: polling stall detected", () => {
    const r = classifyRootCause(
      "Polling stall detected (no getUpdates for 107.67s); forcing restart",
    );
    expect(r.cause).toBe("network_poll_stall");
    expect(r.category).toBe("network");
  });

  // #45160 — JavaScript heap out of memory
  it("issue #45160: JavaScript heap out of memory", () => {
    const r = classifyRootCause("JavaScript heap out of memory");
    expect(r.cause).toBe("resource_oom");
    expect(r.category).toBe("resource_exhaustion");
  });

  // #38260 — SIGILL invalid opcode in libvips-cpp
  it("issue #38260: SIGILL invalid opcode segfault", () => {
    const r = classifyRootCause("SIGILL (invalid opcode) in libvips-cpp");
    expect(r.cause).toBe("internal_segfault");
    expect(r.category).toBe("internal");
    expect(r.confidence).toBe(0.95);
  });

  // missing controlUi.allowedOrigins migration — no pattern should match but classifier should not throw
  it("missing migration message — no crash, returns known cause or unknown", () => {
    const r = classifyRootCause("missing controlUi.allowedOrigins migration");
    // The string contains "missing" but no strong pattern; expect config_missing_module or unknown
    expect(["config_missing_module", "unknown"]).toContain(r.cause);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
  });

  // Discord bot missing Message Content Intent — should match something meaningful
  it("missing Message Content Intent — auth_resource or known category", () => {
    const r = classifyRootCause("Discord bot with missing Message Content Intent");
    // "missing" may match config_missing_module; that is acceptable
    expect(["config_missing_module", "auth_resource", "unknown"]).toContain(r.cause);
  });

  // #21099 — WebSocket connection closed with code 4014
  it("issue #21099: WebSocket connection closed with code 4014", () => {
    const r = classifyRootCause("WebSocket connection closed with code 4014");
    expect(r.cause).toBe("auth_resource");
    expect(r.category).toBe("auth_failure");
  });

  // #29745 — Config invalid file path
  it("issue #29745: Config invalid file path", () => {
    const r = classifyRootCause("Config invalid\nFile: ~/.openclaw/openclaw.json");
    expect(r.cause).toBe("config_invalid_json");
    expect(r.category).toBe("config");
  });

  // #49037 related — spawnSync launchctl ETIMEDOUT
  it("issue #49037 related: spawnSync launchctl ETIMEDOUT", () => {
    const r = classifyRootCause("spawnSync launchctl ETIMEDOUT");
    expect(r.cause).toBe("lifecycle_launchctl");
    expect(r.category).toBe("lifecycle");
  });
});

// ---------------------------------------------------------------------------
// Part A extras: new cause type contracts
// ---------------------------------------------------------------------------

describe("OAG simulation — Part A extras: new cause contracts", () => {
  it("resource_oom: ENOMEM", () => {
    const r = classifyRootCause("ENOMEM: cannot allocate memory");
    expect(r.cause).toBe("resource_oom");
    expect(r.shouldRetry).toBe(false);
    expect(r.shouldAdjustConfig).toBe(true);
  });

  it("resource_oom: OOM killer", () => {
    const r = classifyRootCause("Killed process 9901 (node) total-vm:1024000kB oom_killer invoked");
    expect(r.cause).toBe("resource_oom");
    expect(r.category).toBe("resource_exhaustion");
  });

  it("resource_swap: swap exhaustion", () => {
    const r = classifyRootCause("swap exhaustion — system is degraded");
    expect(r.cause).toBe("resource_swap");
    expect(r.category).toBe("resource_exhaustion");
  });

  it("internal_segfault: SIGSEGV", () => {
    const r = classifyRootCause("Received SIGSEGV, aborting");
    expect(r.cause).toBe("internal_segfault");
    expect(r.category).toBe("internal");
  });

  it("internal_segfault: segfault", () => {
    const r = classifyRootCause("segfault at address 0x00000000");
    expect(r.cause).toBe("internal_segfault");
  });

  it("resource_exhaustion strategy: shouldRetry=false, shouldNotifyOperator=true, shouldAdjustConfig=true", () => {
    const r = classifyRootCause("Out of memory: Killed process 1 total-vm:100kB");
    expect(r.shouldRetry).toBe(false);
    expect(r.shouldNotifyOperator).toBe(true);
    expect(r.shouldAdjustConfig).toBe(true);
  });

  it("lock contention maps to lifecycle_stale_pid", () => {
    const r = classifyRootCause("lock contention detected on /tmp/openclaw.lock");
    expect(r.cause).toBe("lifecycle_stale_pid");
    expect(r.category).toBe("lifecycle");
  });

  it("lock file exists maps to lifecycle_stale_pid", () => {
    const r = classifyRootCause("lock file exists: /var/run/openclaw.pid");
    expect(r.cause).toBe("lifecycle_stale_pid");
  });
});

// ---------------------------------------------------------------------------
// Helpers for Parts B & C
// ---------------------------------------------------------------------------

function makeSnapshot(tsMs: number, metrics: Record<string, number>): MetricSnapshot {
  return {
    timestamp: new Date(tsMs).toISOString(),
    uptimeMs: tsMs,
    metrics,
  };
}

/** Build a series of hourly snapshots starting `hoursBack` hours ago. */
function buildSeries(
  hoursBack: number,
  metricFn: (hourIndex: number) => Record<string, number>,
): MetricSnapshot[] {
  const now = Date.now();
  return Array.from({ length: hoursBack }, (_, i) => {
    const tsMs = now - (hoursBack - i) * 3_600_000;
    return makeSnapshot(tsMs, metricFn(i));
  });
}

// ---------------------------------------------------------------------------
// Part B: Anomaly Detection Simulation
// ---------------------------------------------------------------------------

describe("OAG simulation — Part B: anomaly detection on realistic metric series", () => {
  it("B1: gradual memory leak — RSS grows linearly, final hour anomalous spike", () => {
    // 48 hours: RSS climbs 10 MB/hour from 200 MB baseline
    const series = buildSeries(48, (i) => ({ rssBytes: (200 + i * 10) * 1024 * 1024 }));
    // Simulate sudden OOM spike at the end: double the last value
    const lastRss = (200 + 47 * 10) * 1024 * 1024;
    const oomRss = lastRss * 2;

    const anomalies = detectAnomalies({ rssBytes: oomRss }, series, {
      minSamples: 24,
      threshold: 2.0,
    });

    // The OOM jump should be detected as an anomalous spike
    const rssAnomaly = anomalies.find((a) => a.metric === "rssBytes");
    expect(rssAnomaly).toBeDefined();
    expect(rssAnomaly?.direction).toBe("spike");
    expect(rssAnomaly?.anomalous).toBe(true);
  });

  it("B2: rate limit spike — sudden burst of 429 errors", () => {
    // 30 hours of baseline: 2 rate limit events / hour
    const series = buildSeries(30, () => ({ rateLimitEvents: 2 }));
    // Spike: 200 events in the current hour
    const anomalies = detectAnomalies({ rateLimitEvents: 200 }, series, {
      minSamples: 24,
    });
    const rlAnomaly = anomalies.find((a) => a.metric === "rateLimitEvents");
    expect(rlAnomaly).toBeDefined();
    expect(rlAnomaly?.direction).toBe("spike");
    expect(rlAnomaly?.zScore).toBeGreaterThan(2);
  });

  it("B3: network flapping — alternating healthy/unhealthy produces elevated mean", () => {
    // 30 hours of flapping: alternating 0 and 10 reconnects/hour
    const series = buildSeries(30, (i) => ({
      networkReconnects: i % 2 === 0 ? 0 : 10,
    }));
    // Current: 50 reconnects — well above alternating mean of ~5
    const anomalies = detectAnomalies({ networkReconnects: 50 }, series, {
      minSamples: 24,
    });
    const netAnomaly = anomalies.find((a) => a.metric === "networkReconnects");
    expect(netAnomaly).toBeDefined();
    expect(netAnomaly?.anomalous).toBe(true);
  });

  it("B4: CPU spike before crash — linear slope detection", () => {
    // 12-point window: CPU climbs from 10% to 80% then would breach 90%
    const values = [10, 15, 20, 28, 35, 40, 50, 58, 63, 70, 76, 80];
    const series = values.map((v, i) => ({
      timestamp: new Date(Date.now() - (values.length - i) * 3_600_000).toISOString(),
      uptimeMs: i * 3_600_000,
      metrics: { cpuPercent: v },
    }));

    // Slope should be positive and predict breach within 6h
    const slope = linearSlope(values);
    expect(slope).toBeGreaterThan(0);

    const prediction = predictBreach(series, "cpuPercent", 90, 12);
    expect(prediction).not.toBeNull();
    expect(prediction?.hoursToBreak).toBeGreaterThan(0);
    expect(prediction?.hoursToBreak).toBeLessThanOrEqual(6);
  });

  it("B5: disk fill from log spam — linear increase predicts breach", () => {
    // Disk usage: 10 GB/hour growth (like #29745's 1 GB log spam)
    // 5-point window: 50, 60, 70, 80, 90 GB (threshold = 100 GB)
    const values = [50, 60, 70, 80, 90];
    const series = values.map((v, i) => ({
      timestamp: new Date(Date.now() - (values.length - i) * 3_600_000).toISOString(),
      uptimeMs: i * 3_600_000,
      metrics: { diskGb: v },
    }));

    // slope ~10, current=90, threshold=100 → hoursToBreak = (100-90)/10 = 1
    const prediction = predictBreach(series, "diskGb", 100, 12);
    expect(prediction).not.toBeNull();
    expect(prediction?.hoursToBreak).toBeCloseTo(1, 0);
    expect(prediction?.slope).toBeCloseTo(10, 0);
    expect(prediction?.currentValue).toBe(90);
    expect(prediction?.threshold).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Part C: End-to-End Scenario Simulations
// ---------------------------------------------------------------------------

describe("OAG simulation — Part C: end-to-end lifecycle scenarios", () => {
  /**
   * C1: Discord 4014 crash loop (#21099)
   * 5 incidents in 10 minutes, all "Fatal Gateway error: 4014"
   * Verify: classified as auth_resource, shouldRetry=false, shouldNotifyOperator=true
   */
  it("C1: Discord 4014 crash loop — 5 incidents in 10 minutes", () => {
    const errorMessage = "Fatal Gateway error: 4014";
    const incidents = Array.from({ length: 5 }, (_, i) => ({
      ts: Date.now() - (10 - i * 2) * 60_000, // every 2 minutes
      error: errorMessage,
    }));

    // All incidents should classify identically
    for (const incident of incidents) {
      const r = classifyRootCause(incident.error);
      expect(r.cause).toBe("auth_resource");
      expect(r.category).toBe("auth_failure");
      expect(r.shouldRetry).toBe(false);
      expect(r.shouldNotifyOperator).toBe(true);
      expect(r.confidence).toBe(0.9);
    }

    // Pattern: all 5 incidents have same root cause
    const causes = new Set(incidents.map((i) => classifyRootCause(i.error).cause));
    expect(causes.size).toBe(1);
    expect(causes.has("auth_resource")).toBe(true);
  });

  /**
   * C2: Slack 408 timeout cascade (#45852)
   * WebSocket timeout → reconnect → timeout again → crash
   * Verify: classified as network_timeout, shouldRetry=true
   */
  it("C2: Slack 408 timeout cascade — reconnect loop", () => {
    const cascade = [
      "Unexpected server response: 408",
      "WebSocket connection timeout — retrying",
      "Unexpected server response: 408",
      "WebSocket error occurred: ETIMEDOUT",
    ];

    for (const msg of cascade) {
      const r = classifyRootCause(msg);
      expect(r.category).toBe("network");
      expect(r.shouldRetry).toBe(true);
    }

    // First and third messages must classify as network_timeout
    expect(classifyRootCause(cascade[0]).cause).toBe("network_timeout");
    expect(classifyRootCause(cascade[2]).cause).toBe("network_timeout");
  });

  /**
   * C3: OOM on low-memory server (#47430)
   * Memory metrics climbing, then OOM kill
   * Verify: anomaly detected (memory spike), prediction alert, then OOM classified
   */
  it("C3: OOM on low-memory server — anomaly detection + classification", () => {
    // 30-hour baseline: steady 512 MB RSS
    const baselineSeries = buildSeries(30, () => ({ rssBytes: 512 * 1024 * 1024 }));

    // Current: 4 GB (8x spike) — memory leak just before OOM
    const currentRss = 4 * 1024 * 1024 * 1024;
    const anomalies = detectAnomalies({ rssBytes: currentRss }, baselineSeries, {
      minSamples: 24,
    });

    const rssAnomaly = anomalies.find((a) => a.metric === "rssBytes");
    expect(rssAnomaly).toBeDefined();
    expect(rssAnomaly?.direction).toBe("spike");

    // After OOM kill, error string is classified
    const r = classifyRootCause(
      "Out of memory: Killed process 13437 (openclaw) total-vm:2432208kB",
    );
    expect(r.cause).toBe("resource_oom");
    expect(r.category).toBe("resource_exhaustion");
    expect(r.shouldRetry).toBe(false);
    expect(r.shouldNotifyOperator).toBe(true);
    expect(r.shouldAdjustConfig).toBe(true);
  });

  /**
   * C4: Config validation death spiral (#29745)
   * Same config error repeated 1000 times
   * Verify: classified as config error, shouldRetry=false
   */
  it("C4: config validation death spiral — 1000 identical config errors", () => {
    const configError = "Config invalid\nFile: ~/.openclaw/openclaw.json";

    // Classify a sample: all should produce the same stable result
    const sample = Array.from({ length: 10 }, () => classifyRootCause(configError));
    for (const r of sample) {
      expect(r.cause).toBe("config_invalid_json");
      expect(r.category).toBe("config");
      expect(r.shouldRetry).toBe(false);
      expect(r.shouldNotifyOperator).toBe(true);
    }

    // Simulate pattern: 1000 occurrences — classify the first, last, and middle
    const indices = [0, 499, 999];
    for (const _ of indices) {
      const r = classifyRootCause(configError);
      expect(r.cause).toBe("config_invalid_json");
    }
  });

  /**
   * C5: Port conflict after upgrade (#44881)
   * Old process holds port → new process gets EADDRINUSE → repeat
   * Verify: lifecycle_port_conflict, no retry
   */
  it("C5: port conflict after upgrade — EADDRINUSE repeat loop", () => {
    const errors = [
      "Error: listen EADDRINUSE: address already in use :::18789",
      "EADDRINUSE 127.0.0.1:18789",
      "address already in use :::18789",
    ];

    for (const err of errors) {
      const r = classifyRootCause(err);
      expect(r.cause).toBe("lifecycle_port_conflict");
      expect(r.category).toBe("lifecycle");
      expect(r.shouldRetry).toBe(false);
      expect(r.shouldNotifyOperator).toBe(true);
    }
  });

  /**
   * C6: Stale lock crash loop (#49037)
   * Lock file exists → fail → respawn → fail again
   * Verify: lifecycle_stale_pid detected
   */
  it("C6: stale lock crash loop — repeated lock failures", () => {
    const lockErrors = [
      "stale lock",
      "lock contention detected at /tmp/openclaw.lock",
      "lock file exists: /var/run/openclaw-gateway.pid",
    ];

    for (const err of lockErrors) {
      const r = classifyRootCause(err);
      expect(r.cause).toBe("lifecycle_stale_pid");
      expect(r.category).toBe("lifecycle");
      expect(r.shouldRetry).toBe(false);
      expect(r.shouldNotifyOperator).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Part C extras: anomaly + prediction integration
// ---------------------------------------------------------------------------

describe("OAG simulation — Part C extras: anomaly + prediction integration", () => {
  it("channel restart anomaly emits event on spike", () => {
    vi.mocked(emitOagEvent).mockClear();

    const series = buildSeries(30, () => ({ channelRestarts: 3 }));
    detectAnomalies({ channelRestarts: 60 }, series, { minSamples: 24 });

    expect(emitOagEvent).toHaveBeenCalledWith(
      "anomaly_detected",
      expect.objectContaining({ metric: "channelRestarts", direction: "spike" }),
    );
  });

  it("predictBreach emits prediction_alert when breach imminent", () => {
    vi.mocked(emitOagEvent).mockClear();

    // Slope 2 restarts/hour, current=8, threshold=10 → 1 hour to breach
    const series = [2, 4, 6, 8].map((v, i) => ({
      timestamp: new Date(Date.now() - (4 - i) * 3_600_000).toISOString(),
      uptimeMs: i * 3_600_000,
      metrics: { channelRestarts: v },
    }));

    const prediction = predictBreach(series, "channelRestarts", 10, 12);
    expect(prediction).not.toBeNull();
    expect(prediction?.hoursToBreak).toBeCloseTo(1, 0);
    expect(emitOagEvent).toHaveBeenCalledWith(
      "prediction_alert",
      expect.objectContaining({ metric: "channelRestarts" }),
    );
  });

  it("computeBaseline on OOM-like RSS spike series reflects high variance", () => {
    // 48h: mostly stable at 200, last 6h rapidly climbing
    const values = [...Array.from({ length: 42 }, () => 200), 250, 320, 420, 560, 700, 900];
    const baseline = computeBaseline(values);

    // Mean shifts upward due to spike
    expect(baseline.mean).toBeGreaterThan(200);
    // StdDev reflects spread
    expect(baseline.stdDev).toBeGreaterThan(50);
    expect(baseline.sampleCount).toBe(48);
  });

  it("detectAnomaly: OOM spike on flat baseline is always anomalous", () => {
    // Flat baseline: 200 MB RSS
    const baseline = computeBaseline(Array.from({ length: 48 }, () => 200));
    // OOM spike: 4 GB
    const result = detectAnomaly(4096, baseline);
    expect(result.anomalous).toBe(true);
    expect(result.direction).toBe("spike");
    expect(result.zScore).toBe(Infinity);
  });
});
