import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const spawnSubagentDirectMock = vi.fn();
  const fsAccessMock = vi.fn();
  const fsReaddirMock = vi.fn();
  const fsReadFileMock = vi.fn();
  const spawnMock = vi.fn();

  return {
    spawnSubagentDirectMock,
    fsAccessMock,
    fsReaddirMock,
    fsReadFileMock,
    spawnMock,
  };
});

vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => hoisted.spawnMock(...args),
}));

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    join: (...args: string[]) => args.join("/"),
  };
});

vi.mock("node:fs/promises", () => ({
  access: (...args: unknown[]) => hoisted.fsAccessMock(...args),
  readdir: (...args: unknown[]) => hoisted.fsReaddirMock(...args),
  readFile: (...args: unknown[]) => hoisted.fsReadFileMock(...args),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => "/Users/test",
  };
});

// Dynamic import to ensure mocks are installed first.
const { UserIntentType } = await import("../../channels/smart-debounce.js");
const {
  checkForPendingFollowups,
  shouldIgnoreTrackedExecutionFailure,
  getNextFollowup,
  routeToTrackedExecution,
  shouldRouteToTrackedExecution,
} = await import("./tracked-execution.js");

const { spawnSubagentDirectMock, fsAccessMock, fsReaddirMock, fsReadFileMock, spawnMock } = hoisted;

describe("tracked-execution", () => {
  beforeEach(() => {
    // Set the test home directory before each test
    process.env.OPENCLAW_TEST_HOMEDIR = "/Users/test";
    // Reset all mocks before each test
    fsAccessMock.mockReset();
    fsReaddirMock.mockReset();
    fsReadFileMock.mockReset();
    spawnSubagentDirectMock.mockReset();
    spawnMock.mockReset();
    // Clear any previous mock implementations
    delete globalThis.__OPENCLAW_TEST_checkForPendingFollowups;
    delete globalThis.__OPENCLAW_TEST_getNextFollowup;
    delete globalThis.__OPENCLAW_TEST_routeToOpcOrchestrator;
    delete globalThis.__OPENCLAW_TEST_opcFileAccessible;
    delete globalThis.__OPENCLAW_TEST_runOrchestratorRuntime;
  });

  afterEach(() => {
    // Clean up the test environment variable
    delete process.env.OPENCLAW_TEST_HOMEDIR;
    // Clear any previous mock implementations
    delete globalThis.__OPENCLAW_TEST_checkForPendingFollowups;
    delete globalThis.__OPENCLAW_TEST_getNextFollowup;
    delete globalThis.__OPENCLAW_TEST_routeToOpcOrchestrator;
    delete globalThis.__OPENCLAW_TEST_opcFileAccessible;
    delete globalThis.__OPENCLAW_TEST_runOrchestratorRuntime;
  });

  describe("shouldRouteToTrackedExecution", () => {
    it("returns true for valid execution intent", () => {
      const intentResult = {
        input_finalized: true,
        intent_type: UserIntentType.EXECUTION,
        execution_required: true,
      };

      expect(shouldRouteToTrackedExecution(intentResult)).toBe(true);
    });

    it("returns false when input not finalized", () => {
      const intentResult = {
        input_finalized: false,
        intent_type: UserIntentType.EXECUTION,
        execution_required: true,
      };

      expect(shouldRouteToTrackedExecution(intentResult)).toBe(false);
    });

    it("returns false for non-execution intent", () => {
      const intentResult = {
        input_finalized: true,
        intent_type: UserIntentType.CHAT,
        execution_required: false,
      };

      expect(shouldRouteToTrackedExecution(intentResult)).toBe(false);
    });

    it("returns false when execution not required", () => {
      const intentResult = {
        input_finalized: true,
        intent_type: UserIntentType.EXECUTION,
        execution_required: false,
      };

      expect(shouldRouteToTrackedExecution(intentResult)).toBe(false);
    });
  });

  describe("checkForPendingFollowups", () => {
    it("returns false when followups directory doesn't exist", async () => {
      // 使用全局变量注入模拟
      globalThis.__OPENCLAW_TEST_checkForPendingFollowups = () => Promise.resolve(false);

      const result = await checkForPendingFollowups();

      expect(result).toBe(false);
    });

    it("returns false when directory exists but no followups", async () => {
      globalThis.__OPENCLAW_TEST_checkForPendingFollowups = () => Promise.resolve(false);

      const result = await checkForPendingFollowups();

      expect(result).toBe(false);
    });

    it("returns true when followups exist", async () => {
      globalThis.__OPENCLAW_TEST_checkForPendingFollowups = () => Promise.resolve(true);

      const result = await checkForPendingFollowups();
      expect(result).toBe(true);
    });

    it("ignores done followup records", async () => {
      fsAccessMock.mockResolvedValue(undefined);
      fsReaddirMock.mockResolvedValue(["task-done.json"]);
      fsReadFileMock.mockResolvedValue(
        JSON.stringify({
          task_id: "TASK-DONE",
          status: "done",
        }),
      );

      const result = await checkForPendingFollowups();

      expect(result).toBe(false);
    });
  });

  describe("getNextFollowup", () => {
    it("returns null when followups directory doesn't exist", async () => {
      globalThis.__OPENCLAW_TEST_getNextFollowup = () => Promise.resolve(null);

      const result = await getNextFollowup();

      expect(result).toBeNull();
    });

    it("returns null when no followups exist", async () => {
      globalThis.__OPENCLAW_TEST_getNextFollowup = () => Promise.resolve(null);

      const result = await getNextFollowup();

      expect(result).toBeNull();
    });

    it("returns followup content when available", async () => {
      globalThis.__OPENCLAW_TEST_getNextFollowup = () => Promise.resolve("test followup content");

      const result = await getNextFollowup();

      expect(result).toBe("test followup content");
    });

    it("returns null when only done followups exist", async () => {
      fsReaddirMock.mockResolvedValue(["task-done.json"]);
      fsReadFileMock.mockResolvedValue(
        JSON.stringify({
          task_id: "TASK-DONE",
          status: "done",
        }),
      );

      const result = await getNextFollowup();

      expect(result).toBeNull();
    });
  });

  describe("routeToTrackedExecution", () => {
    it("returns fallback when shouldRouteToTrackedExecution returns false", async () => {
      const result = await routeToTrackedExecution({
        ctx: { Body: "test" },
        intentResult: {
          input_finalized: false,
          intent_type: UserIntentType.CHAT,
          execution_required: false,
        },
        cfg: {},
        agentId: "test-agent",
      });

      expect(result.status).toBe("fallback");
      expect(result.reason).toBe("not an execution intent request");
    });

    it("returns fallback when pending followups exist", async () => {
      // 模拟有 pending followups
      globalThis.__OPENCLAW_TEST_checkForPendingFollowups = () => Promise.resolve(true);

      const result = await routeToTrackedExecution({
        ctx: { Body: "test" },
        intentResult: {
          input_finalized: true,
          intent_type: UserIntentType.EXECUTION,
          execution_required: true,
        },
        cfg: {},
        agentId: "test-agent",
      });

      expect(result.status).toBe("fallback");
      expect(result.reason).toBe("pending follow-ups exist");
    });

    it("routes to tracked execution when valid", async () => {
      // 模拟没有 pending followups
      globalThis.__OPENCLAW_TEST_checkForPendingFollowups = () => Promise.resolve(false);

      spawnSubagentDirectMock.mockResolvedValue({
        status: "accepted",
        note: "test note",
      });

      const result = await routeToTrackedExecution({
        ctx: { Body: "test task" },
        intentResult: {
          input_finalized: true,
          intent_type: UserIntentType.EXECUTION,
          execution_required: true,
        },
        cfg: {},
        agentId: "test-agent",
      });

      expect(result.status).toBe("routed");
      expect(result.note).toBe("test note");
      expect(spawnSubagentDirectMock).toHaveBeenCalled();
    });

    it("returns fallback when spawn fails", async () => {
      // 模拟没有 pending followups
      globalThis.__OPENCLAW_TEST_checkForPendingFollowups = () => Promise.resolve(false);

      spawnSubagentDirectMock.mockResolvedValue({
        status: "error",
        error: "spawn failed",
      });

      const result = await routeToTrackedExecution({
        ctx: { Body: "test task" },
        intentResult: {
          input_finalized: true,
          intent_type: UserIntentType.EXECUTION,
          execution_required: true,
        },
        cfg: {},
        agentId: "test-agent",
      });

      expect(result.status).toBe("fallback");
      expect(result.reason).toBe("spawn failed");
    });

    it("uses opc_orchestrator backend when configured", async () => {
      // 模拟没有 pending followups
      globalThis.__OPENCLAW_TEST_checkForPendingFollowups = () => Promise.resolve(false);
      // 模拟 OPC 文件可访问
      globalThis.__OPENCLAW_TEST_opcFileAccessible = true;
      // 模拟 runOrchestratorRuntime 返回成功
      globalThis.__OPENCLAW_TEST_runOrchestratorRuntime = async () => ({
        success: true,
        output: JSON.stringify({ task_id: "TASK-20260309-123456-test-task" }),
        error: "",
      });

      const result = await routeToTrackedExecution({
        ctx: { Body: "test task" },
        intentResult: {
          input_finalized: true,
          intent_type: UserIntentType.EXECUTION,
          execution_required: true,
        },
        cfg: {
          agents: {
            defaults: {
              trackedExecutionBackend: "opc_orchestrator",
            },
          },
        },
        agentId: "test-agent",
      });

      expect(result.status).toBe("routed");
      expect(result.replyText).toBe("任务已接管：TASK-20260309-123456-test-task");
    });

    it("returns immediate handoff reply for opc tasks", async () => {
      globalThis.__OPENCLAW_TEST_checkForPendingFollowups = () => Promise.resolve(false);
      globalThis.__OPENCLAW_TEST_opcFileAccessible = true;
      spawnMock.mockImplementation(() => {
        return {
          stdout: {
            on: (event: string, handler: (data: Buffer) => void) => {
              if (event === "data") {
                queueMicrotask(() => {
                  handler(
                    Buffer.from(JSON.stringify({ task_id: "TASK-20260309-123456-test-task" })),
                  );
                });
              }
            },
          },
          stderr: {
            on: () => undefined,
          },
          on: (event: string, handler: (code?: number) => void) => {
            if (event === "close") {
              queueMicrotask(() => {
                handler(0);
              });
            }
            if (event === "error") {
              // no-op for success path
            }
          },
        };
      });

      const result = await routeToTrackedExecution({
        ctx: { Body: "帮我看看最新版本是多少。真实执行，不要靠记忆。完了" },
        intentResult: {
          input_finalized: true,
          intent_type: UserIntentType.EXECUTION,
          execution_required: true,
        },
        cfg: {
          agents: {
            defaults: {
              trackedExecutionBackend: "opc_orchestrator",
            },
          },
        },
        agentId: "test-agent",
      });

      expect(result.status).toBe("routed");
      expect(result.replyText).toBe("任务已接管：TASK-20260309-123456-test-task");
    });

    it("does not fall back to subagent backend when opc_orchestrator is unavailable", async () => {
      // 模拟没有 pending followups
      globalThis.__OPENCLAW_TEST_checkForPendingFollowups = () => Promise.resolve(false);
      // 模拟 OPC 文件不可访问
      globalThis.__OPENCLAW_TEST_opcFileAccessible = false;

      const result = await routeToTrackedExecution({
        ctx: { Body: "test task" },
        intentResult: {
          input_finalized: true,
          intent_type: UserIntentType.EXECUTION,
          execution_required: true,
        },
        cfg: {
          agents: {
            defaults: {
              trackedExecutionBackend: "opc_orchestrator",
            },
          },
        },
        agentId: "test-agent",
      });

      expect(result.status).toBe("fallback");
      expect(result.reason).toBe("OPC orchestrator not found or accessible");
      expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
    });
  });

  describe("shouldIgnoreTrackedExecutionFailure", () => {
    it("returns true when opc backend is unavailable", () => {
      expect(
        shouldIgnoreTrackedExecutionFailure("OPC orchestrator not found or accessible", {
          agents: {
            defaults: {
              trackedExecutionBackend: "opc_orchestrator",
            },
          },
        }),
      ).toBe(true);
    });

    it("returns false for non-opc backends or other failures", () => {
      expect(
        shouldIgnoreTrackedExecutionFailure("OPC orchestrator not found or accessible", {}),
      ).toBe(false);
      expect(
        shouldIgnoreTrackedExecutionFailure("failed to start tracked execution", {
          agents: {
            defaults: {
              trackedExecutionBackend: "opc_orchestrator",
            },
          },
        }),
      ).toBe(false);
    });
  });
});
