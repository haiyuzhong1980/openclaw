/**
 * OAG Subagent Watchdog - Monitors subagent failures and anomalies
 *
 * Subscribes to subagent:ended hook, detects failure patterns (cascading failures,
 * frequent timeouts, error storms), and triggers OAG anomaly_detected event.
 */

import type { OpenClawConfig } from "../config/config.js";
import {
  registerInternalHook,
  unregisterInternalHook,
  type InternalHookHandler,
} from "../hooks/internal-hooks.js";
import { isSubagentEndedEvent, type SubagentEndedHookContext } from "../hooks/internal-hooks.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { emitOagEvent } from "./oag-event-bus.js";

const log = createSubsystemLogger("oag/subagent-watchdog");

// Configuration defaults
const DEFAULT_FAILURE_THRESHOLD = 3; // failures within window to trigger alert
const DEFAULT_TIMEOUT_THRESHOLD = 2; // timeouts within window to trigger alert
const DEFAULT_WINDOW_MS = 300_000; // 5 minutes

// Track recent subagent outcomes for pattern detection
interface SubagentOutcomeRecord {
  childSessionKey: string;
  outcome: SubagentEndedHookContext["outcome"];
  error?: string;
  timestamp: number;
  depth?: number;
}

const recentOutcomes: SubagentOutcomeRecord[] = [];

export interface SubagentWatchdogConfig {
  enabled: boolean;
  failureThreshold: number;
  timeoutThreshold: number;
  windowMs: number;
}

/**
 * Deep merge two config objects.
 */
function deepMergeConfig(
  base: SubagentWatchdogConfig,
  override: Partial<SubagentWatchdogConfig>,
): SubagentWatchdogConfig {
  return {
    ...base,
    ...override,
  };
}

/**
 * Resolve the subagent watchdog configuration from OpenClaw config.
 */
export function resolveSubagentWatchdogConfig(cfg?: OpenClawConfig): SubagentWatchdogConfig {
  const watchdogConfig = cfg?.gateway?.oag?.subagentWatchdog;

  return {
    enabled: watchdogConfig?.enabled ?? true,
    failureThreshold: watchdogConfig?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
    timeoutThreshold: watchdogConfig?.timeoutThreshold ?? DEFAULT_TIMEOUT_THRESHOLD,
    windowMs: watchdogConfig?.windowMs ?? DEFAULT_WINDOW_MS,
  };
}

/**
 * Clean up old outcome records outside the time window.
 */
function pruneOldOutcomes(windowMs: number): void {
  const cutoff = Date.now() - windowMs;
  while (recentOutcomes.length > 0 && recentOutcomes[0]?.timestamp < cutoff) {
    recentOutcomes.shift();
  }
}

/**
 * Count failures within the time window.
 */
function countRecentFailures(): number {
  return recentOutcomes.filter((r) => r.outcome === "error").length;
}

/**
 * Count timeouts within the time window.
 */
function countRecentTimeouts(): number {
  return recentOutcomes.filter((r) => r.outcome === "timeout").length;
}

/**
 * Detect cascade failure pattern (multiple failures in short time).
 */
function detectCascadeFailure(config: SubagentWatchdogConfig): {
  isCascade: boolean;
  failureCount: number;
} {
  pruneOldOutcomes(config.windowMs);
  const failureCount = countRecentFailures();
  return {
    isCascade: failureCount >= config.failureThreshold,
    failureCount,
  };
}

/**
 * Detect timeout storm pattern (multiple timeouts in short time).
 */
function detectTimeoutStorm(config: SubagentWatchdogConfig): {
  isStorm: boolean;
  timeoutCount: number;
} {
  pruneOldOutcomes(config.windowMs);
  const timeoutCount = countRecentTimeouts();
  return {
    isStorm: timeoutCount >= config.timeoutThreshold,
    timeoutCount,
  };
}

/**
 * Detect deep nesting issues (failures at depth >= 2).
 */
function detectDeepNestingIssue(): { hasIssue: boolean; depth: number } {
  const deepFailures = recentOutcomes.filter(
    (r) => (r.depth ?? 0) >= 2 && (r.outcome === "error" || r.outcome === "timeout"),
  );
  if (deepFailures.length >= 2) {
    return { hasIssue: true, depth: Math.max(...deepFailures.map((r) => r.depth ?? 0)) };
  }
  return { hasIssue: false, depth: 0 };
}

let currentConfig: SubagentWatchdogConfig = {
  enabled: true,
  failureThreshold: DEFAULT_FAILURE_THRESHOLD,
  timeoutThreshold: DEFAULT_TIMEOUT_THRESHOLD,
  windowMs: DEFAULT_WINDOW_MS,
};

let currentHandler: InternalHookHandler | null = null;
let isRunning = false;

/**
 * Reset the watchdog state (for testing).
 * @internal
 */
export function resetSubagentWatchdog(): void {
  if (currentHandler) {
    unregisterInternalHook("subagent:ended", currentHandler);
    currentHandler = null;
  }
  isRunning = false;
  recentOutcomes.length = 0;
  currentConfig = {
    enabled: true,
    failureThreshold: DEFAULT_FAILURE_THRESHOLD,
    timeoutThreshold: DEFAULT_TIMEOUT_THRESHOLD,
    windowMs: DEFAULT_WINDOW_MS,
  };
}

/**
 * Check if the watchdog is currently running.
 */
export function isSubagentWatchdogRunning(): boolean {
  return isRunning;
}

/**
 * Start the Subagent Watchdog
 *
 * If already running, will update config and keep the existing handler.
 * Use the returned cleanup function to stop the watchdog.
 *
 * @param config Optional partial config override
 * @returns Cleanup function to stop the watchdog
 */
export function startSubagentWatchdog(config?: Partial<SubagentWatchdogConfig>): () => void {
  // Deep merge config
  currentConfig = deepMergeConfig(currentConfig, config ?? {});

  if (!currentConfig.enabled) {
    log.info("Subagent watchdog disabled by config");
    return () => {};
  }

  // Prevent duplicate registration - if already running, just update config
  if (isRunning && currentHandler) {
    log.info("Subagent watchdog config updated (already running)");
    return () => {
      if (currentHandler) {
        unregisterInternalHook("subagent:ended", currentHandler);
        currentHandler = null;
        isRunning = false;
      }
      log.info("Subagent watchdog stopped");
    };
  }

  const handler: InternalHookHandler = async (event) => {
    if (!isSubagentEndedEvent(event)) {
      return;
    }

    const { context } = event;

    // Record the outcome
    recentOutcomes.push({
      childSessionKey: context.childSessionKey ?? context.targetSessionKey,
      outcome: context.outcome,
      error: context.error,
      timestamp: Date.now(),
      depth: context.depth,
    });

    // Only analyze non-successful outcomes
    if (context.outcome === "ok" || !context.outcome) {
      return;
    }

    // Detect patterns
    const cascadeCheck = detectCascadeFailure(currentConfig);
    const timeoutCheck = detectTimeoutStorm(currentConfig);
    const deepNestingCheck = detectDeepNestingIssue();

    // Emit anomaly events based on detected patterns
    if (cascadeCheck.isCascade) {
      log.warn(`Cascade failure detected: ${cascadeCheck.failureCount} failures in window`);

      emitOagEvent("anomaly_detected", {
        type: "subagent_failure",
        subtype: "cascade_failure",
        severity: "warning",
        failureCount: cascadeCheck.failureCount,
        windowMs: currentConfig.windowMs,
        childSessionKey: context.childSessionKey ?? context.targetSessionKey,
        requesterSessionKey: context.requesterSessionKey,
        runId: context.runId,
        error: context.error,
        suggestion: {
          action: "review_subagent_tasks",
          message: `Multiple subagent failures (${cascadeCheck.failureCount}) detected within ${Math.round(currentConfig.windowMs / 60000)} minutes. Consider reviewing task complexity or error handling.`,
        },
      });
    }

    if (timeoutCheck.isStorm) {
      log.warn(`Timeout storm detected: ${timeoutCheck.timeoutCount} timeouts in window`);

      emitOagEvent("anomaly_detected", {
        type: "subagent_timeout",
        subtype: "timeout_storm",
        severity: "warning",
        timeoutCount: timeoutCheck.timeoutCount,
        windowMs: currentConfig.windowMs,
        childSessionKey: context.childSessionKey ?? context.targetSessionKey,
        requesterSessionKey: context.requesterSessionKey,
        runId: context.runId,
        suggestion: {
          action: "adjust_timeout_settings",
          message: `Multiple subagent timeouts (${timeoutCheck.timeoutCount}) detected. Consider increasing timeout or simplifying tasks.`,
        },
      });
    }

    if (deepNestingCheck.hasIssue) {
      log.warn(`Deep nesting issue detected at depth ${deepNestingCheck.depth}`);

      emitOagEvent("anomaly_detected", {
        type: "subagent_failure",
        subtype: "deep_nesting_issue",
        severity: "info",
        depth: deepNestingCheck.depth,
        childSessionKey: context.childSessionKey ?? context.targetSessionKey,
        requesterSessionKey: context.requesterSessionKey,
        runId: context.runId,
        suggestion: {
          action: "reduce_nesting",
          message: `Failures detected at nesting depth ${deepNestingCheck.depth}. Consider flattening the agent hierarchy.`,
        },
      });
    }

    // Also emit individual failure events for single failures
    if (context.outcome === "error" && !cascadeCheck.isCascade) {
      emitOagEvent("anomaly_detected", {
        type: "subagent_failure",
        subtype: "single_failure",
        severity: "info",
        childSessionKey: context.childSessionKey ?? context.targetSessionKey,
        requesterSessionKey: context.requesterSessionKey,
        runId: context.runId,
        error: context.error,
        reason: context.reason,
      });
    }

    if (context.outcome === "timeout" && !timeoutCheck.isStorm) {
      emitOagEvent("anomaly_detected", {
        type: "subagent_timeout",
        subtype: "single_timeout",
        severity: "info",
        childSessionKey: context.childSessionKey ?? context.targetSessionKey,
        requesterSessionKey: context.requesterSessionKey,
        runId: context.runId,
        suggestion: {
          action: "consider_timeout_adjustment",
        },
      });
    }
  };

  currentHandler = handler;
  isRunning = true;
  registerInternalHook("subagent:ended", handler);

  log.info("Subagent watchdog started", {
    failureThreshold: currentConfig.failureThreshold,
    timeoutThreshold: currentConfig.timeoutThreshold,
    windowMs: currentConfig.windowMs,
  });

  // Return cleanup function
  return () => {
    if (currentHandler) {
      unregisterInternalHook("subagent:ended", currentHandler);
      currentHandler = null;
      isRunning = false;
    }
    log.info("Subagent watchdog stopped");
  };
}

/**
 * Update Subagent Watchdog configuration at runtime.
 */
export function updateSubagentWatchdogConfig(config: Partial<SubagentWatchdogConfig>): void {
  currentConfig = deepMergeConfig(currentConfig, config);
  log.info("Subagent watchdog config updated");
}

/**
 * Get recent outcome statistics (for diagnostics).
 */
export function getSubagentOutcomeStats(): {
  totalOutcomes: number;
  failures: number;
  timeouts: number;
  successes: number;
} {
  return {
    totalOutcomes: recentOutcomes.length,
    failures: recentOutcomes.filter((r) => r.outcome === "error").length,
    timeouts: recentOutcomes.filter((r) => r.outcome === "timeout").length,
    successes: recentOutcomes.filter((r) => r.outcome === "ok").length,
  };
}
