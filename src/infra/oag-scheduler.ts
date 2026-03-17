import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveOagSchedulerMaxWaitMs } from "./oag-config.js";

const log = createSubsystemLogger("oag/scheduler");

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const BACKOFF_FACTOR = 1.5;
const MAX_POLL_INTERVAL_MS = 60_000;

export type IdleCheck = () => boolean;

/**
 * Wait for the gateway to become idle before running a task.
 * Returns true if the task ran, false if max wait was exceeded (task still runs).
 */
export async function runWhenIdle<T>(
  task: () => Promise<T>,
  isIdle: IdleCheck,
  options?: {
    maxWaitMs?: number;
    initialPollMs?: number;
    abortSignal?: AbortSignal;
    cfg?: OpenClawConfig;
  },
): Promise<{ result: T; waitedMs: number; ranImmediately: boolean }> {
  const maxWaitMs = options?.maxWaitMs ?? resolveOagSchedulerMaxWaitMs(options?.cfg);
  const startedAt = Date.now();

  if (isIdle()) {
    const result = await task();
    return { result, waitedMs: 0, ranImmediately: true };
  }

  let pollMs = options?.initialPollMs ?? DEFAULT_POLL_INTERVAL_MS;

  while (true) {
    if (options?.abortSignal?.aborted) {
      throw new Error("OAG scheduler aborted");
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= maxWaitMs) {
      log.info(
        `OAG scheduler: max wait ${Math.round(maxWaitMs / 1000)}s exceeded, running task anyway`,
      );
      const result = await task();
      return { result, waitedMs: elapsed, ranImmediately: false };
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, pollMs);
      options?.abortSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("OAG scheduler aborted"));
        },
        { once: true },
      );
    });

    if (isIdle()) {
      const elapsed = Date.now() - startedAt;
      log.info(`OAG scheduler: gateway idle after ${Math.round(elapsed / 1000)}s, running task`);
      const result = await task();
      return { result, waitedMs: elapsed, ranImmediately: false };
    }

    // Exponential backoff on poll interval
    pollMs = Math.min(pollMs * BACKOFF_FACTOR, MAX_POLL_INTERVAL_MS);
  }
}

/**
 * Create an idle checker for the gateway using the existing queue/reply/run counts.
 * This is a factory so callers can inject their own dependencies.
 */
export function createGatewayIdleCheck(deps: {
  getQueueSize: () => number;
  getPendingReplies: () => number;
  getActiveRuns: () => number;
}): IdleCheck {
  return () =>
    deps.getQueueSize() === 0 && deps.getPendingReplies() === 0 && deps.getActiveRuns() === 0;
}
