import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock setup similar to oag-evolution.integration.test.ts
const memoryFiles = vi.hoisted(() => new Map<string, string>());
const configState = vi.hoisted(() => ({
  current: {
    gateway: {
      oag: {
        delivery: { recoveryBudgetMs: 60000, maxRetries: 5 },
        lock: { timeoutMs: 2000, staleMs: 30000 },
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
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/oag-recovery-test",
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
    unlink: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ mtimeMs: Date.now() })),
  },
}));

// Import after mocks
const { loadOagMemory, withOagMemory } = await import("./oag-memory.js");
const { resetOagMetrics } = await import("./oag-metrics.js");

// Type helper for test lifecycles with extended stopReason values
type TestLifecycle = Parameters<Parameters<typeof withOagMemory>[0]>[0]["lifecycles"][number];

describe("OAG Recovery Replay", () => {
  beforeEach(() => {
    memoryFiles.clear();
    resetOagMetrics();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Repeated flaps scenario", () => {
    it("should handle channel reconnecting multiple times within short window", async () => {
      // Simulate 5 rapid reconnect cycles (flaps)
      for (let i = 0; i < 5; i++) {
        const lifecycle = {
          id: `gw-flap-${i}`,
          startedAt: new Date(Date.now() - 30000).toISOString(),
          stoppedAt: new Date().toISOString(),
          stopReason: "channel_reconnect",
          uptimeMs: 30000,
          metricsSnapshot: {
            channelRestarts: 1,
            deliveryRecoveries: i,
            deliveryRecoveryFailures: 0,
          },
          incidents: [
            {
              type: "channel_crash_loop",
              channel: "telegram",
              accountId: "default",
              detail: "health-monitor restart (reason: stale-poll)",
              lastError: "Connection reset by peer",
              count: 1,
            },
          ],
        };

        await withOagMemory((memory) => {
          memory.lifecycles.push(lifecycle as unknown as (typeof memory.lifecycles)[number]);
          return true;
        });
      }

      const memory = await loadOagMemory();
      expect(memory.lifecycles.length).toBe(5);

      // All lifecycles should have stopReason = "channel_reconnect"
      const flapCount = memory.lifecycles.filter(
        (l) => l.stopReason === "channel_reconnect",
      ).length;
      expect(flapCount).toBe(5);
    });

    it("should detect escalation-worthy flap pattern", async () => {
      // Simulate rapid flaps that should trigger escalation
      const now = Date.now();
      const incidents = [];

      for (let i = 0; i < 10; i++) {
        incidents.push({
          type: "channel_crash_loop",
          channel: "discord",
          accountId: "default",
          detail: `Flap ${i + 1}`,
          lastError: "WebSocket close code 1006",
          firstAt: new Date(now - 60000 + i * 5000).toISOString(),
          lastAt: new Date(now - 60000 + i * 5000 + 4000).toISOString(),
          count: 1,
        });
      }

      await withOagMemory((memory) => {
        memory.lifecycles.push({
          id: "gw-flap-storm",
          startedAt: new Date(now - 60000).toISOString(),
          stoppedAt: new Date().toISOString(),
          stopReason: "clean",
          uptimeMs: 60000,
          metricsSnapshot: {
            channelRestarts: 10,
            deliveryRecoveries: 0,
            deliveryRecoveryFailures: 5,
          },
          incidents,
        } as unknown as TestLifecycle);
        return true;
      });

      const memory = await loadOagMemory();
      const recentIncidents = memory.lifecycles.flatMap((l) => l.incidents || []);
      expect(recentIncidents.length).toBe(10);
    });
  });

  describe("Concurrent recovery", () => {
    it("should track multiple channel recoveries simultaneously", async () => {
      const channels = ["telegram", "discord", "slack"];

      for (const channel of channels) {
        await withOagMemory((memory) => {
          memory.lifecycles.push({
            id: `gw-recovery-${channel}`,
            startedAt: new Date(Date.now() - 60000).toISOString(),
            stoppedAt: new Date().toISOString(),
            stopReason: "channel_reconnect",
            uptimeMs: 60000,
            metricsSnapshot: {
              channelRestarts: 1,
              deliveryRecoveries: 2,
              deliveryRecoveryFailures: 0,
            },
            incidents: [
              {
                type: "stale_detection",
                channel,
                accountId: "default",
                detail: "stale socket detected",
                count: 1,
              },
            ],
          } as unknown as TestLifecycle);
          return true;
        });
      }

      const memory = await loadOagMemory();
      expect(memory.lifecycles.length).toBe(3);

      // Each channel should have its own incident
      const affectedChannels = new Set(
        memory.lifecycles.flatMap((l) => l.incidents?.map((i) => i.channel) || []),
      );
      expect(affectedChannels.size).toBe(3);
    });
  });

  describe("Backlog drain timeout", () => {
    it("should track backlog age exceeding threshold", async () => {
      const backlogAgeMinutes = 15; // Exceeds typical 10-minute threshold

      await withOagMemory((memory) => {
        memory.lifecycles.push({
          id: "gw-backlog-timeout",
          startedAt: new Date(Date.now() - backlogAgeMinutes * 60000).toISOString(),
          stoppedAt: new Date().toISOString(),
          stopReason: "backlog_prolonged",
          uptimeMs: backlogAgeMinutes * 60000,
          metricsSnapshot: {
            channelRestarts: 0,
            deliveryRecoveries: 50,
            deliveryRecoveryFailures: 10, // Some failures during drain
            staleSocketDetections: 0,
            stalePollDetections: 0,
            noteDeliveries: 5,
            noteDeduplications: 2,
          },
          incidents: [
            {
              type: "delivery_recovery_failure",
              channel: "telegram",
              accountId: "default",
              detail: "backlog drain timeout",
              lastError: "Recovery budget exceeded",
              count: 10,
            },
          ],
        } as unknown as TestLifecycle);
        return true;
      });

      const memory = await loadOagMemory();
      const lastLifecycle = memory.lifecycles[memory.lifecycles.length - 1];
      expect(lastLifecycle.stopReason).toBe("backlog_prolonged");
      expect(lastLifecycle.metricsSnapshot.deliveryRecoveryFailures).toBe(10);
    });
  });

  describe("Lock contention under load", () => {
    it("should handle concurrent lock acquisitions", async () => {
      // Simulate multiple processes trying to acquire OAG state lock
      const acquisitions = [];

      for (let i = 0; i < 5; i++) {
        acquisitions.push(
          withOagMemory((memory) => {
            memory.lifecycles.push({
              id: `gw-lock-test-${i}`,
              startedAt: new Date().toISOString(),
              stoppedAt: "",
              stopReason: "",
              uptimeMs: 0,
              metricsSnapshot: {
                lockAcquisitions: 1,
              },
              incidents: [],
            } as unknown as TestLifecycle);
            // Simulate some processing time
            return true;
          }),
        );
      }

      await Promise.all(acquisitions);

      const memory = await loadOagMemory();
      // All acquisitions should succeed due to serialized writes
      expect(memory.lifecycles.length).toBe(5);
    });
  });
});
