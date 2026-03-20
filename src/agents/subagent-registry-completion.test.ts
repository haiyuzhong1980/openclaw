import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearInternalHooks, registerInternalHook } from "../hooks/internal-hooks.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const lifecycleMocks = vi.hoisted(() => ({
  getGlobalHookRunner: vi.fn(),
  runSubagentEnded: vi.fn(async () => {}),
  getSubagentDepthFromSessionStore: vi.fn(() => 0),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => lifecycleMocks.getGlobalHookRunner(),
}));

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: (...args: unknown[]) =>
    lifecycleMocks.getSubagentDepthFromSessionStore(...args),
}));

import { emitSubagentEndedHookOnce } from "./subagent-registry-completion.js";

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

describe("emitSubagentEndedHookOnce", () => {
  const createEmitParams = (
    overrides?: Partial<Parameters<typeof emitSubagentEndedHookOnce>[0]>,
  ) => {
    const entry = overrides?.entry ?? createRunEntry();
    return {
      entry,
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
      accountId: "acct-1",
      inFlightRunIds: new Set<string>(),
      persist: vi.fn(),
      ...overrides,
    };
  };

  beforeEach(() => {
    clearInternalHooks();
    lifecycleMocks.getGlobalHookRunner.mockClear();
    lifecycleMocks.runSubagentEnded.mockClear();
    lifecycleMocks.getSubagentDepthFromSessionStore.mockReset().mockReturnValue(0);
  });

  it("records ended hook marker even when no subagent_ended hooks are registered", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => false,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const params = createEmitParams();
    const handler = vi.fn();
    registerInternalHook("subagent:ended", handler);

    const emitted = await emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(true);
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(typeof params.entry.endedHookEmittedAt).toBe("number");
    expect(params.persist).toHaveBeenCalledTimes(1);
  });

  it("runs subagent_ended hooks when available", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const params = createEmitParams();
    const handler = vi.fn();
    registerInternalHook("subagent:ended", handler);

    const emitted = await emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(true);
    expect(lifecycleMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(typeof params.entry.endedHookEmittedAt).toBe("number");
    expect(params.persist).toHaveBeenCalledTimes(1);
  });

  it("emits an internal subagent:ended hook with real watchdog context", async () => {
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => false,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });
    lifecycleMocks.getSubagentDepthFromSessionStore.mockReturnValue(2);

    const params = createEmitParams({
      accountId: "acct-9",
      outcome: "error",
      error: "task failed",
    });
    const handler = vi.fn();
    registerInternalHook("subagent:ended", handler);

    const emitted = await emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    const [event] = handler.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      type: "subagent",
      action: "ended",
      sessionKey: params.entry.childSessionKey,
      context: expect.objectContaining({
        targetSessionKey: params.entry.childSessionKey,
        targetKind: "subagent",
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        accountId: "acct-9",
        runId: params.entry.runId,
        outcome: "error",
        error: "task failed",
        childSessionKey: params.entry.childSessionKey,
        requesterSessionKey: params.entry.requesterSessionKey,
        depth: 1,
      }),
    });
  });

  it("returns false when runId is blank", async () => {
    const params = createEmitParams({
      entry: { ...createRunEntry(), runId: "   " },
    });
    const emitted = await emitSubagentEndedHookOnce(params);
    expect(emitted).toBe(false);
    expect(params.persist).not.toHaveBeenCalled();
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
  });

  it("returns false when ended hook marker already exists", async () => {
    const params = createEmitParams({
      entry: { ...createRunEntry(), endedHookEmittedAt: Date.now() },
    });
    const emitted = await emitSubagentEndedHookOnce(params);
    expect(emitted).toBe(false);
    expect(params.persist).not.toHaveBeenCalled();
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
  });

  it("returns false when runId is already in flight", async () => {
    const entry = createRunEntry();
    const inFlightRunIds = new Set<string>([entry.runId]);
    const params = createEmitParams({ entry, inFlightRunIds });
    const emitted = await emitSubagentEndedHookOnce(params);
    expect(emitted).toBe(false);
    expect(params.persist).not.toHaveBeenCalled();
    expect(lifecycleMocks.runSubagentEnded).not.toHaveBeenCalled();
  });

  it("returns false when subagent hook execution throws", async () => {
    lifecycleMocks.runSubagentEnded.mockRejectedValueOnce(new Error("boom"));
    lifecycleMocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: () => true,
      runSubagentEnded: lifecycleMocks.runSubagentEnded,
    });

    const entry = createRunEntry();
    const inFlightRunIds = new Set<string>();
    const params = createEmitParams({ entry, inFlightRunIds });
    const emitted = await emitSubagentEndedHookOnce(params);

    expect(emitted).toBe(false);
    expect(params.persist).not.toHaveBeenCalled();
    expect(inFlightRunIds.has(entry.runId)).toBe(false);
    expect(entry.endedHookEmittedAt).toBeUndefined();
  });
});
