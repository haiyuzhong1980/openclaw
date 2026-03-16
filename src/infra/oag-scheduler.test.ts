import { describe, expect, it, vi } from "vitest";
import { runWhenIdle, createGatewayIdleCheck } from "./oag-scheduler.js";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

describe("oag-scheduler", () => {
  it("runs immediately when idle", async () => {
    const task = vi.fn(async () => "done");
    const result = await runWhenIdle(task, () => true);
    expect(result.ranImmediately).toBe(true);
    expect(result.waitedMs).toBe(0);
    expect(result.result).toBe("done");
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("waits then runs when gateway becomes idle", async () => {
    let callCount = 0;
    const isIdle = () => {
      callCount++;
      return callCount >= 3;
    };
    const task = vi.fn(async () => "waited");
    const result = await runWhenIdle(task, isIdle, { initialPollMs: 10, maxWaitMs: 5000 });
    expect(result.ranImmediately).toBe(false);
    expect(result.waitedMs).toBeGreaterThan(0);
    expect(result.result).toBe("waited");
  });

  it("runs anyway after max wait exceeded", async () => {
    const task = vi.fn(async () => "forced");
    const result = await runWhenIdle(task, () => false, { maxWaitMs: 50, initialPollMs: 10 });
    expect(result.ranImmediately).toBe(false);
    expect(result.result).toBe("forced");
  });

  it("aborts when signal is triggered", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await expect(
      runWhenIdle(
        async () => "never",
        () => false,
        {
          maxWaitMs: 10000,
          initialPollMs: 10,
          abortSignal: controller.signal,
        },
      ),
    ).rejects.toThrow("aborted");
  });
});

describe("createGatewayIdleCheck", () => {
  it("returns true when all counts are zero", () => {
    const check = createGatewayIdleCheck({
      getQueueSize: () => 0,
      getPendingReplies: () => 0,
      getActiveRuns: () => 0,
    });
    expect(check()).toBe(true);
  });

  it("returns false when any count is non-zero", () => {
    const check = createGatewayIdleCheck({
      getQueueSize: () => 1,
      getPendingReplies: () => 0,
      getActiveRuns: () => 0,
    });
    expect(check()).toBe(false);
  });
});
