import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory file system shared across all OAG modules
const memoryFiles = vi.hoisted(() => new Map<string, string>());

const configState = vi.hoisted(() => ({
  current: {
    gateway: {
      oag: {
        delivery: { recoveryBudgetMs: 60_000, maxRetries: 5 },
        lock: { timeoutMs: 2_000, staleMs: 30_000 },
        health: { stalePollFactor: 2 },
        notes: { dedupWindowMs: 60_000, maxDeliveredHistory: 20 },
      },
    },
  } as Record<string, unknown>,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => JSON.parse(JSON.stringify(configState.current)),
  writeConfigFile: vi.fn(async (cfg: unknown) => {
    configState.current = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  }),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/oag-server-integration-test",
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async (p: string) => {
      if (!memoryFiles.has(p)) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return memoryFiles.get(p) ?? "";
    }),
    writeFile: vi.fn(async (p: string, content: string) => {
      memoryFiles.set(p, content);
    }),
    rename: vi.fn(async (src: string, dest: string) => {
      const content = memoryFiles.get(src);
      if (content !== undefined) {
        memoryFiles.set(dest, content);
        memoryFiles.delete(src);
      }
    }),
    mkdir: vi.fn(async () => {}),
    copyFile: vi.fn(async (src: string, dest: string) => {
      const content = memoryFiles.get(src);
      if (content !== undefined) {
        memoryFiles.set(dest, content);
      }
    }),
    open: vi.fn(async () => ({
      writeFile: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    })),
    unlink: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ mtimeMs: Date.now() })),
  },
}));

vi.mock("node:fs", () => ({
  default: {
    watch: vi.fn(() => ({ close: vi.fn() })),
    readFileSync: vi.fn((p: string) => {
      if (!memoryFiles.has(p)) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return memoryFiles.get(p) ?? "";
    }),
  },
}));

// Import modules under test after all mocks
const { recordLifecycleShutdown, loadOagMemory, saveOagMemory } =
  await import("../infra/oag-memory.js");
const { recordOagIncident, collectActiveIncidents, clearActiveIncidents } =
  await import("../infra/oag-incident-collector.js");
const { incrementOagMetric, getOagMetrics, resetOagMetrics } =
  await import("../infra/oag-metrics.js");
const { runPostRecoveryAnalysis } = await import("../infra/oag-postmortem.js");
const { checkEvolutionHealth, startEvolutionObservation, clearObservation } =
  await import("../infra/oag-evolution-guard.js");
const { startFileWatcher, stopFileWatcher, resetOagEventBus } =
  await import("../infra/oag-event-bus.js");
const { runWhenIdle } = await import("../infra/oag-scheduler.js");

describe("server OAG integration (real scenarios)", () => {
  beforeEach(async () => {
    memoryFiles.clear();
    resetOagMetrics();
    clearActiveIncidents();
    await clearObservation();
    resetOagEventBus();
    configState.current = {
      gateway: {
        oag: {
          delivery: { recoveryBudgetMs: 60_000, maxRetries: 5 },
          lock: { timeoutMs: 2_000, staleMs: 30_000 },
          health: { stalePollFactor: 2 },
          notes: { dedupWindowMs: 60_000, maxDeliveredHistory: 20 },
        },
      },
    };
  });

  describe("recordLifecycleShutdown", () => {
    it("writes correct data structure to memory", async () => {
      const startedAt = Date.now() - 120_000;
      const now = new Date().toISOString();
      await recordLifecycleShutdown({
        startedAt,
        stopReason: "crash",
        metricsSnapshot: { channelRestarts: 3, deliveryRecoveries: 1 },
        incidents: [
          {
            type: "channel_crash_loop",
            channel: "telegram",
            detail: "ETIMEDOUT",
            count: 2,
            firstAt: now,
            lastAt: now,
          },
        ],
      });

      const memory = await loadOagMemory();
      expect(memory.lifecycles).toHaveLength(1);
      const lc = memory.lifecycles[0];
      expect(lc.id).toMatch(/^gw-\d+$/);
      expect(lc.stopReason).toBe("crash");
      expect(lc.metricsSnapshot).toEqual({ channelRestarts: 3, deliveryRecoveries: 1 });
      expect(lc.incidents).toHaveLength(1);
      expect(lc.incidents[0].type).toBe("channel_crash_loop");
      expect(lc.uptimeMs).toBeGreaterThan(0);
      expect(Date.parse(lc.startedAt)).not.toBeNaN();
      expect(Date.parse(lc.stoppedAt)).not.toBeNaN();
    });
  });

  describe("recordOagIncident + collectActiveIncidents", () => {
    it("accumulates incidents and respects the 100-entry cap", () => {
      // Record 105 unique incidents
      for (let i = 0; i < 105; i++) {
        recordOagIncident({
          type: "stale_detection",
          channel: `ch-${i}`,
          detail: `incident-${i}`,
        });
      }

      const incidents = collectActiveIncidents();
      expect(incidents.length).toBeLessThanOrEqual(100);
      // The oldest 5 should have been evicted
      const channels = incidents.map((inc) => inc.channel);
      for (let i = 0; i < 5; i++) {
        expect(channels).not.toContain(`ch-${i}`);
      }
      // The newest 100 should be present
      for (let i = 5; i < 105; i++) {
        expect(channels).toContain(`ch-${i}`);
      }
    });

    it("increments count for duplicate incident keys", () => {
      recordOagIncident({ type: "channel_crash_loop", channel: "telegram", detail: "first" });
      recordOagIncident({ type: "channel_crash_loop", channel: "telegram", detail: "second" });
      recordOagIncident({ type: "channel_crash_loop", channel: "telegram", detail: "third" });

      const incidents = collectActiveIncidents();
      expect(incidents).toHaveLength(1);
      expect(incidents[0].count).toBe(3);
      expect(incidents[0].detail).toBe("third");
    });
  });

  describe("incrementOagMetric + getOagMetrics", () => {
    it("correctly increments and returns updated values", () => {
      incrementOagMetric("channelRestarts");
      incrementOagMetric("channelRestarts");
      incrementOagMetric("deliveryRecoveries", 5);

      const metrics = getOagMetrics();
      expect(metrics.channelRestarts).toBe(2);
      expect(metrics.deliveryRecoveries).toBe(5);
      // Returns a snapshot, not a reference
      incrementOagMetric("channelRestarts");
      expect(metrics.channelRestarts).toBe(2);
      expect(getOagMetrics().channelRestarts).toBe(3);
    });
  });

  describe("runPostRecoveryAnalysis", () => {
    it("respects cooldown and produces recommendations on sufficient crashes", async () => {
      const now = new Date().toISOString();
      // Record enough crashes with recurring patterns
      for (let i = 0; i < 4; i++) {
        await recordLifecycleShutdown({
          startedAt: Date.now() - 60_000,
          stopReason: "crash",
          metricsSnapshot: { channelRestarts: 3 },
          incidents: [
            {
              type: "channel_crash_loop",
              channel: "telegram",
              detail: "ETIMEDOUT",
              count: 1,
              firstAt: now,
              lastAt: now,
            },
          ],
        });
      }

      // First analysis should run
      const first = await runPostRecoveryAnalysis();
      expect(first.analyzed).toBe(true);
      expect(first.recommendations.length).toBeGreaterThan(0);
      expect(first.applied.length).toBeGreaterThan(0);
      expect(first.userNotification).toBeDefined();

      // Second analysis should be blocked by cooldown
      const second = await runPostRecoveryAnalysis();
      expect(second.analyzed).toBe(false);
      expect(second.recommendations).toHaveLength(0);
    });

    it("skips analysis when crashes are below threshold", async () => {
      await recordLifecycleShutdown({
        startedAt: Date.now() - 60_000,
        stopReason: "crash",
        metricsSnapshot: {},
        incidents: [],
      });

      const result = await runPostRecoveryAnalysis();
      expect(result.analyzed).toBe(false);
      expect(result.crashCount).toBeLessThan(2);
    });
  });

  describe("checkEvolutionHealth", () => {
    it("detects regression and triggers rollback", async () => {
      // Set up an active observation with baseline metrics at 0
      await startEvolutionObservation({
        appliedAt: new Date().toISOString(),
        rollbackChanges: [
          { configPath: "gateway.oag.delivery.recoveryBudgetMs", previousValue: 60_000 },
        ],
      });

      // Record a pending evolution in memory so the rollback can mark it
      const memory = await loadOagMemory();
      memory.evolutions.push({
        appliedAt: new Date().toISOString(),
        source: "adaptive",
        trigger: "test",
        changes: [
          {
            configPath: "gateway.oag.delivery.recoveryBudgetMs",
            from: 60_000,
            to: 90_000,
          },
        ],
        outcome: "pending",
      });
      await saveOagMemory(memory);

      // Simulate regression: spike channel restarts past threshold (>=5)
      for (let i = 0; i < 6; i++) {
        incrementOagMetric("channelRestarts");
      }

      const result = await checkEvolutionHealth();
      expect(result.checked).toBe(true);
      expect(result.action).toBe("reverted");
      expect(result.reason).toContain("channel restarts spiked");

      // Verify the evolution record was marked as reverted
      const memoryAfter = await loadOagMemory();
      const lastEvolution = memoryAfter.evolutions[memoryAfter.evolutions.length - 1];
      expect(lastEvolution.outcome).toBe("reverted");
    });

    it("returns none when no observation is active", async () => {
      const result = await checkEvolutionHealth();
      expect(result.checked).toBe(false);
      expect(result.action).toBe("none");
    });
  });

  describe("startFileWatcher / stopFileWatcher lifecycle", () => {
    it("starts and stops without error", () => {
      const updateHandler = vi.fn();
      const cleanup = startFileWatcher("/tmp/test-state.json", updateHandler);
      expect(typeof cleanup).toBe("function");
      // Stop should not throw
      stopFileWatcher();
      cleanup();
    });
  });

  describe("runWhenIdle", () => {
    it("runs task immediately when idle", async () => {
      const isIdle = () => true;
      const task = vi.fn(async () => "done");
      const { result, waitedMs, ranImmediately } = await runWhenIdle(task, isIdle);
      expect(result).toBe("done");
      expect(ranImmediately).toBe(true);
      expect(waitedMs).toBe(0);
      expect(task).toHaveBeenCalledOnce();
    });

    it("waits for idle condition before executing", async () => {
      let idleAfter = false;
      const isIdle = () => idleAfter;
      const task = vi.fn(async () => 42);

      // Set idle after a short delay
      setTimeout(() => {
        idleAfter = true;
      }, 50);

      const { result, ranImmediately, waitedMs } = await runWhenIdle(task, isIdle, {
        initialPollMs: 20,
        maxWaitMs: 5_000,
      });
      expect(result).toBe(42);
      expect(ranImmediately).toBe(false);
      expect(waitedMs).toBeGreaterThan(0);
      expect(task).toHaveBeenCalledOnce();
    });

    it("runs task after max wait even if not idle", async () => {
      const isIdle = () => false;
      const task = vi.fn(async () => "forced");

      const { result, ranImmediately } = await runWhenIdle(task, isIdle, {
        maxWaitMs: 50,
        initialPollMs: 10,
      });
      expect(result).toBe("forced");
      expect(ranImmediately).toBe(false);
      expect(task).toHaveBeenCalledOnce();
    });
  });
});
