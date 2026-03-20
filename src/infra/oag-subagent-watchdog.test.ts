import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "../agents/subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearInternalHooks,
  triggerInternalHook,
  createInternalHookEvent,
} from "../hooks/internal-hooks.js";

const hookRunnerMocks = vi.hoisted(() => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: () => false,
    runSubagentEnded: vi.fn(async () => {}),
  })),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunnerMocks.getGlobalHookRunner(),
}));

// Mock oag-event-bus
const mockEmitOagEvent = vi.fn();
vi.mock("./oag-event-bus.js", () => ({
  emitOagEvent: (...args: unknown[]) => mockEmitOagEvent(...args),
}));

// Mock logging
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createRunEntry(): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child-1",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "task",
    cleanup: "keep",
    createdAt: Date.now(),
  };
}

async function emitRealSubagentEndedEvent(overrides?: {
  accountId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
  outcome?: "ok" | "error" | "timeout";
  error?: string;
}): Promise<void> {
  const { emitSubagentEndedHookOnce } = await import("../agents/subagent-registry-completion.js");
  const entry = {
    ...createRunEntry(),
    ...(overrides?.childSessionKey ? { childSessionKey: overrides.childSessionKey } : {}),
    ...(overrides?.requesterSessionKey
      ? { requesterSessionKey: overrides.requesterSessionKey }
      : {}),
  };

  await emitSubagentEndedHookOnce({
    entry,
    reason: SUBAGENT_ENDED_REASON_COMPLETE,
    sendFarewell: true,
    accountId: overrides?.accountId,
    outcome: overrides?.outcome,
    error: overrides?.error,
    inFlightRunIds: new Set<string>(),
    persist: vi.fn(),
  });
}

describe("oag-subagent-watchdog", () => {
  beforeEach(async () => {
    clearInternalHooks();
    mockEmitOagEvent.mockClear();
    // Reset watchdog state between tests
    const { resetSubagentWatchdog } = await import("./oag-subagent-watchdog.js");
    resetSubagentWatchdog();
  });

  afterEach(() => {
    clearInternalHooks();
  });

  describe("basic functionality", () => {
    it("emits anomaly_detected on single subagent error", async () => {
      const { startSubagentWatchdog } = await import("./oag-subagent-watchdog.js");

      startSubagentWatchdog();

      await triggerInternalHook(
        createInternalHookEvent("subagent", "ended", "child-session-1", {
          targetSessionKey: "child-session-1",
          targetKind: "subagent",
          reason: "subagent-complete",
          childSessionKey: "child-session-1",
          outcome: "error",
          error: "Task failed",
          runId: "run-001",
        }),
      );

      expect(mockEmitOagEvent).toHaveBeenCalledWith(
        "anomaly_detected",
        expect.objectContaining({
          type: "subagent_failure",
          subtype: "single_failure",
          childSessionKey: "child-session-1",
          error: "Task failed",
        }),
      );
    });

    it("emits anomaly_detected on single subagent timeout", async () => {
      const { startSubagentWatchdog } = await import("./oag-subagent-watchdog.js");

      startSubagentWatchdog();

      await triggerInternalHook(
        createInternalHookEvent("subagent", "ended", "child-session-2", {
          targetSessionKey: "child-session-2",
          targetKind: "subagent",
          reason: "subagent-complete",
          childSessionKey: "child-session-2",
          outcome: "timeout",
          runId: "run-002",
        }),
      );

      expect(mockEmitOagEvent).toHaveBeenCalledWith(
        "anomaly_detected",
        expect.objectContaining({
          type: "subagent_timeout",
          subtype: "single_timeout",
          childSessionKey: "child-session-2",
        }),
      );
    });

    it("does not emit on successful outcome", async () => {
      const { startSubagentWatchdog } = await import("./oag-subagent-watchdog.js");

      startSubagentWatchdog();

      await triggerInternalHook(
        createInternalHookEvent("subagent", "ended", "child-session-3", {
          targetSessionKey: "child-session-3",
          targetKind: "subagent",
          reason: "subagent-complete",
          childSessionKey: "child-session-3",
          outcome: "ok",
          runId: "run-003",
        }),
      );

      expect(mockEmitOagEvent).not.toHaveBeenCalled();
    });

    it("can be disabled via config", async () => {
      const { startSubagentWatchdog } = await import("./oag-subagent-watchdog.js");

      startSubagentWatchdog({ enabled: false });

      await triggerInternalHook(
        createInternalHookEvent("subagent", "ended", "child-session-4", {
          targetSessionKey: "child-session-4",
          targetKind: "subagent",
          reason: "subagent-complete",
          childSessionKey: "child-session-4",
          outcome: "error",
          error: "Task failed",
        }),
      );

      expect(mockEmitOagEvent).not.toHaveBeenCalled();
    });

    it("cleanup function stops the watchdog", async () => {
      const { startSubagentWatchdog } = await import("./oag-subagent-watchdog.js");

      const cleanup = startSubagentWatchdog();

      // Trigger once to verify it's working
      await triggerInternalHook(
        createInternalHookEvent("subagent", "ended", "child-session-5", {
          targetSessionKey: "child-session-5",
          targetKind: "subagent",
          reason: "subagent-complete",
          childSessionKey: "child-session-5",
          outcome: "error",
        }),
      );

      expect(mockEmitOagEvent).toHaveBeenCalledTimes(1);

      // Cleanup
      cleanup();

      // Trigger again - should not emit
      await triggerInternalHook(
        createInternalHookEvent("subagent", "ended", "child-session-6", {
          targetSessionKey: "child-session-6",
          targetKind: "subagent",
          reason: "subagent-complete",
          childSessionKey: "child-session-6",
          outcome: "error",
        }),
      );

      // Still 1, not 2
      expect(mockEmitOagEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe("real subagent completion wiring", () => {
    it("consumes real subagent completion events emitted by the registry", async () => {
      const { startSubagentWatchdog } = await import("./oag-subagent-watchdog.js");

      startSubagentWatchdog();
      await emitRealSubagentEndedEvent({
        accountId: "acct-real",
        outcome: "error",
        error: "Task failed from registry",
      });

      expect(mockEmitOagEvent).toHaveBeenCalledWith(
        "anomaly_detected",
        expect.objectContaining({
          type: "subagent_failure",
          subtype: "single_failure",
          childSessionKey: "agent:main:subagent:child-1",
          requesterSessionKey: "agent:main:main",
          error: "Task failed from registry",
        }),
      );
    });
  });

  describe("cascade failure detection", () => {
    it("detects cascade failure pattern", async () => {
      const { startSubagentWatchdog, resetSubagentWatchdog } =
        await import("./oag-subagent-watchdog.js");

      resetSubagentWatchdog();
      startSubagentWatchdog({ failureThreshold: 3 });

      // Trigger 3 failures
      for (let i = 0; i < 3; i++) {
        await triggerInternalHook(
          createInternalHookEvent("subagent", "ended", `child-session-${i}`, {
            targetSessionKey: `child-session-${i}`,
            targetKind: "subagent",
            reason: "subagent-complete",
            childSessionKey: `child-session-${i}`,
            outcome: "error",
            error: `Error ${i}`,
          }),
        );
      }

      // Should emit: 2 single failures + 1 cascade detection
      // The cascade detection happens on the 3rd failure
      const cascadeEvents = mockEmitOagEvent.mock.calls.filter(
        (call) => call[1]?.subtype === "cascade_failure",
      );
      expect(cascadeEvents.length).toBe(1);
      expect(cascadeEvents[0][1]).toMatchObject({
        type: "subagent_failure",
        subtype: "cascade_failure",
        failureCount: 3,
      });
    });
  });

  describe("timeout storm detection", () => {
    it("detects timeout storm pattern", async () => {
      const { startSubagentWatchdog, resetSubagentWatchdog } =
        await import("./oag-subagent-watchdog.js");

      resetSubagentWatchdog();
      startSubagentWatchdog({ timeoutThreshold: 2 });

      // Trigger 2 timeouts
      for (let i = 0; i < 2; i++) {
        await triggerInternalHook(
          createInternalHookEvent("subagent", "ended", `child-timeout-${i}`, {
            targetSessionKey: `child-timeout-${i}`,
            targetKind: "subagent",
            reason: "subagent-complete",
            childSessionKey: `child-timeout-${i}`,
            outcome: "timeout",
          }),
        );
      }

      // Should have detected timeout storm
      const stormEvents = mockEmitOagEvent.mock.calls.filter(
        (call) => call[1]?.subtype === "timeout_storm",
      );
      expect(stormEvents.length).toBe(1);
      expect(stormEvents[0][1]).toMatchObject({
        type: "subagent_timeout",
        subtype: "timeout_storm",
        timeoutCount: 2,
      });
    });
  });

  describe("deep nesting detection", () => {
    it("detects issues at deep nesting levels", async () => {
      const { startSubagentWatchdog, resetSubagentWatchdog } =
        await import("./oag-subagent-watchdog.js");

      resetSubagentWatchdog();
      startSubagentWatchdog();

      // Trigger failures at depth 2
      for (let i = 0; i < 2; i++) {
        await triggerInternalHook(
          createInternalHookEvent("subagent", "ended", `child-deep-${i}`, {
            targetSessionKey: `child-deep-${i}`,
            targetKind: "subagent",
            reason: "subagent-complete",
            childSessionKey: `child-deep-${i}`,
            outcome: "error",
            depth: 2,
          }),
        );
      }

      // Should detect deep nesting issue
      const deepEvents = mockEmitOagEvent.mock.calls.filter(
        (call) => call[1]?.subtype === "deep_nesting_issue",
      );
      expect(deepEvents.length).toBe(1);
      expect(deepEvents[0][1]).toMatchObject({
        type: "subagent_failure",
        subtype: "deep_nesting_issue",
        depth: 2,
      });
    });
  });

  describe("config resolution", () => {
    it("resolves config from OpenClawConfig", async () => {
      const { resolveSubagentWatchdogConfig } = await import("./oag-subagent-watchdog.js");

      const cfg = {
        gateway: {
          oag: {
            subagentWatchdog: {
              enabled: false,
              failureThreshold: 5,
              timeoutThreshold: 3,
            },
          },
        },
      } as unknown as OpenClawConfig;

      const config = resolveSubagentWatchdogConfig(cfg);

      expect(config.enabled).toBe(false);
      expect(config.failureThreshold).toBe(5);
      expect(config.timeoutThreshold).toBe(3);
    });

    it("uses defaults when no config provided", async () => {
      const { resolveSubagentWatchdogConfig } = await import("./oag-subagent-watchdog.js");

      const config = resolveSubagentWatchdogConfig(undefined);

      expect(config.enabled).toBe(true);
      expect(config.failureThreshold).toBe(3);
      expect(config.timeoutThreshold).toBe(2);
    });
  });

  describe("suggestions", () => {
    it("includes suggestion for cascade failure", async () => {
      const { startSubagentWatchdog, resetSubagentWatchdog } =
        await import("./oag-subagent-watchdog.js");

      resetSubagentWatchdog();
      startSubagentWatchdog({ failureThreshold: 2 });

      // Trigger 2 failures
      for (let i = 0; i < 2; i++) {
        await triggerInternalHook(
          createInternalHookEvent("subagent", "ended", `child-${i}`, {
            targetSessionKey: `child-${i}`,
            targetKind: "subagent",
            reason: "subagent-complete",
            childSessionKey: `child-${i}`,
            outcome: "error",
          }),
        );
      }

      const cascadeEvents = mockEmitOagEvent.mock.calls.filter(
        (call) => call[1]?.subtype === "cascade_failure",
      );
      expect(cascadeEvents[0][1].suggestion).toBeDefined();
      expect(cascadeEvents[0][1].suggestion.action).toBe("review_subagent_tasks");
    });
  });

  describe("outcome stats", () => {
    it("tracks outcome statistics", async () => {
      const { startSubagentWatchdog, getSubagentOutcomeStats, resetSubagentWatchdog } =
        await import("./oag-subagent-watchdog.js");

      resetSubagentWatchdog();
      startSubagentWatchdog();

      // Mix of outcomes
      await triggerInternalHook(
        createInternalHookEvent("subagent", "ended", "child-1", {
          targetSessionKey: "child-1",
          targetKind: "subagent",
          reason: "subagent-complete",
          childSessionKey: "child-1",
          outcome: "ok",
        }),
      );
      await triggerInternalHook(
        createInternalHookEvent("subagent", "ended", "child-2", {
          targetSessionKey: "child-2",
          targetKind: "subagent",
          reason: "subagent-complete",
          childSessionKey: "child-2",
          outcome: "error",
        }),
      );
      await triggerInternalHook(
        createInternalHookEvent("subagent", "ended", "child-3", {
          targetSessionKey: "child-3",
          targetKind: "subagent",
          reason: "subagent-complete",
          childSessionKey: "child-3",
          outcome: "timeout",
        }),
      );

      const stats = getSubagentOutcomeStats();

      expect(stats.totalOutcomes).toBe(3);
      expect(stats.failures).toBe(1);
      expect(stats.timeouts).toBe(1);
      expect(stats.successes).toBe(1);
    });
  });

  describe("duplicate registration prevention", () => {
    it("does not register duplicate handler on second start", async () => {
      const { startSubagentWatchdog, isSubagentWatchdogRunning, resetSubagentWatchdog } =
        await import("./oag-subagent-watchdog.js");

      resetSubagentWatchdog();
      const cleanup1 = startSubagentWatchdog();
      expect(isSubagentWatchdogRunning()).toBe(true);

      // Second start should not register a new handler
      const cleanup2 = startSubagentWatchdog();
      expect(isSubagentWatchdogRunning()).toBe(true);

      // Trigger once
      await triggerInternalHook(
        createInternalHookEvent("subagent", "ended", "child-session", {
          targetSessionKey: "child-session",
          targetKind: "subagent",
          reason: "subagent-complete",
          childSessionKey: "child-session",
          outcome: "error",
        }),
      );

      // Should only emit once (not twice from duplicate handler)
      expect(mockEmitOagEvent).toHaveBeenCalledTimes(1);

      cleanup1();
      cleanup2();
    });

    it("isSubagentWatchdogRunning returns correct state", async () => {
      const { startSubagentWatchdog, isSubagentWatchdogRunning, resetSubagentWatchdog } =
        await import("./oag-subagent-watchdog.js");

      resetSubagentWatchdog();
      expect(isSubagentWatchdogRunning()).toBe(false);

      const cleanup = startSubagentWatchdog();
      expect(isSubagentWatchdogRunning()).toBe(true);

      cleanup();
      expect(isSubagentWatchdogRunning()).toBe(false);
    });
  });
});
