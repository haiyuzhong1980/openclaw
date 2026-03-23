/**
 * Tracked Execution Router
 *
 * Routes execution intent requests to the tracked orchestrator runtime
 * instead of the main agent.
 *
 * Supports pluggable backend architecture:
 * - "subagent_session" (default): Universal backend for standard OpenClaw environments
 * - "opc_orchestrator": OPC-specific backend with TASK-* tracking and sentinel support
 */

// Type declarations for test helpers
declare global {
  var __OPENCLAW_TEST_checkForPendingFollowups: (() => Promise<boolean>) | undefined;
  var __OPENCLAW_TEST_getNextFollowup: (() => Promise<string | null>) | undefined;
  var __OPENCLAW_TEST_routeToOpcOrchestrator:
    | ((
        messageText: string,
        agentId: string,
        agentSessionKey: string | undefined,
        workspaceDir: string | undefined,
        ctx: MsgContext,
      ) => Promise<{ status: "routed"; note?: string } | { status: "fallback"; reason: string }>)
    | undefined;
  var __OPENCLAW_TEST_opcFileAccessible: boolean | undefined;
  var __OPENCLAW_TEST_runOrchestratorRuntime:
    | ((args: string[]) => Promise<{ success: boolean; output: string; error: string }>)
    | undefined;
}

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { spawnSubagentDirect, type SpawnSubagentContext } from "../../agents/subagent-spawn.js";
import { UserIntentType, type IntentAnalysisResult } from "../../channels/smart-debounce.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";

type RoutedResult =
  | { status: "routed"; note?: string; replyText?: string }
  | { status: "fallback"; reason: string };

/**
 * Tracked execution backend types
 */
export type TrackedExecutionBackend = "subagent_session" | "opc_orchestrator";

/**
 * Get the configured tracked execution backend from config
 */
function getConfiguredBackend(cfg: OpenClawConfig): TrackedExecutionBackend {
  return cfg.agents?.defaults?.trackedExecutionBackend ?? "subagent_session";
}

/**
 * Get the path to the task follow-ups directory
 */
export function getTaskFollowupsDirectory(): string {
  // For testing purposes, allow overriding the homedir via an environment variable
  const homedir = process.env.OPENCLAW_TEST_HOMEDIR ?? os.homedir();
  return join(homedir, ".openclaw", "sentinel", "task-followups");
}

type FollowupRecord = {
  status?: string;
};

async function listPendingFollowupFiles(): Promise<string[]> {
  const followupsDir = getTaskFollowupsDirectory();
  try {
    await fs.access(followupsDir);
    const files = await fs.readdir(followupsDir);
    const pending: string[] = [];
    for (const file of files) {
      if (file.startsWith(".") || file.trim().length === 0) {
        continue;
      }
      try {
        const raw = await fs.readFile(join(followupsDir, file), "utf8");
        const parsed = JSON.parse(raw) as FollowupRecord;
        if (parsed.status === "pending") {
          pending.push(file);
        }
      } catch {
        // Ignore unreadable / invalid follow-up records.
      }
    }
    return pending;
  } catch {
    return [];
  }
}

/**
 * Get the path to the orchestrator runtime script
 */
export function getOrchestratorRuntimePath(): string {
  // For testing purposes, allow overriding the homedir via an environment variable
  const homedir = process.env.OPENCLAW_TEST_HOMEDIR ?? os.homedir();
  return join(
    homedir,
    ".openclaw",
    "workspace",
    "skills",
    "task-orchestrator",
    "scripts",
    "orchestrator_runtime.py",
  );
}

/**
 * Get the path to the tracked request executor helper.
 */
function getTrackedRequestExecutorPath(): string {
  const homedir = process.env.OPENCLAW_TEST_HOMEDIR ?? os.homedir();
  return join(
    homedir,
    ".openclaw",
    "workspace",
    "skills",
    "task-orchestrator",
    "scripts",
    "execute_tracked_request.py",
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function persistTaskReplyTarget(
  taskId: string,
  ctx: MsgContext,
  sessionKey?: string,
): Promise<void> {
  const channel = ctx.OriginatingChannel;
  const to = ctx.OriginatingTo;
  if (!channel || !to) {
    return;
  }
  const homedir = process.env.OPENCLAW_TEST_HOMEDIR ?? os.homedir();
  const taskDir = join(homedir, ".openclaw", "orchestrator", "tasks", taskId);
  const statusPath = join(taskDir, "status.json");
  const raw = await fs.readFile(statusPath, "utf8");
  const status = JSON.parse(raw) as Record<string, unknown>;
  status.notification = {
    channel,
    to,
    accountId: ctx.AccountId ?? null,
    threadId: ctx.MessageThreadId ?? null,
    sessionKey: sessionKey ?? null,
    taskAcceptedReplySentAt: new Date().toISOString(),
    terminalReplySentAt: null,
    lastTerminalReplyError: null,
  };
  await fs.writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

export function formatTrackedExecutionFallback(reason: string): string {
  if (reason === "pending follow-ups exist") {
    return "当前有待处理的任务跟进，先不启动新任务。";
  }
  if (reason === "OPC orchestrator not found or accessible") {
    return "任务器当前不可用，未启动新任务。";
  }
  if (reason.includes("No executable plan matched")) {
    return "任务已接管，但当前还不会执行这类请求。";
  }
  return `任务器未接管此请求：${reason}`;
}

export function shouldIgnoreTrackedExecutionFailure(reason: string, cfg: OpenClawConfig): boolean {
  return (
    getConfiguredBackend(cfg) === "opc_orchestrator" &&
    reason === "OPC orchestrator not found or accessible"
  );
}

/**
 * Run orchestrator runtime command
 */
async function runOrchestratorRuntime(
  args: string[],
): Promise<{ success: boolean; output: string; error: string }> {
  return new Promise((resolve) => {
    const pythonPath = process.env.PYTHON ?? "python3";
    const scriptPath = getOrchestratorRuntimePath();

    const proc = spawn(pythonPath, [scriptPath, ...args], {
      cwd: os.homedir(),
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        success: code === 0,
        output: stdout.trim(),
        error: stderr.trim(),
      });
    });

    proc.on("error", () => {
      resolve({
        success: false,
        output: stdout.trim(),
        error: stderr.trim() || "Failed to spawn orchestrator runtime",
      });
    });
  });
}

/**
 * Subagent Session Backend (Default Universal Implementation)
 */
async function routeToSubagentSession(
  messageText: string,
  agentId: string,
  agentSessionKey: string | undefined,
  workspaceDir: string | undefined,
  ctx: MsgContext,
): Promise<RoutedResult> {
  const spawnContext: SpawnSubagentContext = {
    agentSessionKey,
    agentChannel: ctx.OriginatingChannel ?? undefined,
    agentAccountId: ctx.AccountId,
    agentTo: ctx.OriginatingTo ?? undefined,
    agentThreadId: ctx.MessageThreadId,
    workspaceDir,
  };

  const result = await spawnSubagentDirect(
    {
      task: messageText,
      label: "Tracked Execution",
      agentId,
      mode: "session",
      cleanup: "keep",
      expectsCompletionMessage: true,
    },
    spawnContext,
  );

  if (result.status === "accepted") {
    return {
      status: "routed",
      note: result.note,
    };
  }

  return {
    status: "fallback",
    reason: result.error ?? "failed to spawn tracked subagent session",
  };
}

/**
 * OPC Orchestrator Backend (OPC-Specific Implementation)
 */
async function routeToOpcOrchestrator(
  messageText: string,
  agentId: string,
  agentSessionKey: string | undefined,
  workspaceDir: string | undefined,
  ctx: MsgContext,
): Promise<RoutedResult> {
  // For testing purposes, allow mock implementation injection
  if (globalThis.__OPENCLAW_TEST_routeToOpcOrchestrator) {
    return globalThis.__OPENCLAW_TEST_routeToOpcOrchestrator(
      messageText,
      agentId,
      agentSessionKey,
      workspaceDir,
      ctx,
    );
  }

  // For testing purposes, allow mock of the fs.access check
  if (globalThis.__OPENCLAW_TEST_opcFileAccessible !== undefined) {
    if (!globalThis.__OPENCLAW_TEST_opcFileAccessible) {
      return {
        status: "fallback",
        reason: "OPC orchestrator not found or accessible",
      };
    }
  } else {
    // Check if OPC files exist before trying to use this backend
    try {
      await fs.access(getOrchestratorRuntimePath());
    } catch {
      return {
        status: "fallback",
        reason: "OPC orchestrator not found or accessible",
      };
    }
  }

  // For testing purposes, allow mock of runOrchestratorRuntime
  if (globalThis.__OPENCLAW_TEST_runOrchestratorRuntime) {
    const result = await globalThis.__OPENCLAW_TEST_runOrchestratorRuntime([]);
    if (result.success) {
      try {
        const parsed = JSON.parse(result.output);
        return {
          status: "routed",
          note: parsed.task_id ? `Started tracked task: ${parsed.task_id}` : undefined,
          replyText: parsed.task_id ? `任务已接管：${parsed.task_id}` : "任务已接管。",
        };
      } catch {
        return {
          status: "routed",
          note: "Started tracked task",
          replyText: "任务已接管。",
        };
      }
    }
    return {
      status: "fallback",
      reason: result.error ?? "failed to start tracked execution",
    };
  }

  const trackedExecutor = getTrackedRequestExecutorPath();
  const cwd = workspaceDir ?? join(os.homedir(), ".openclaw", "workspace");
  const wrappedCommand = `python3 ${shellQuote(trackedExecutor)} --request ${shellQuote(messageText)} --cwd ${shellQuote(cwd)}`;

  const result = await runOrchestratorRuntime([
    "start-tracked",
    "--title",
    messageText.slice(0, 100), // Truncate to reasonable length
    "--command",
    wrappedCommand,
    "--owner",
    "main",
    "--worker",
    "coder",
    "--cwd",
    cwd,
    "--background",
  ]);

  if (result.success) {
    try {
      const parsed = JSON.parse(result.output);
      const taskId = typeof parsed.task_id === "string" ? parsed.task_id : undefined;
      if (taskId) {
        try {
          await persistTaskReplyTarget(taskId, ctx, agentSessionKey);
        } catch {
          // Keep handoff behavior even if notification metadata could not be persisted.
        }
      }
      return {
        status: "routed",
        note: taskId ? `Started tracked task: ${taskId}` : undefined,
        replyText: taskId ? `任务已接管：${taskId}` : "任务已接管。",
      };
    } catch {
      return {
        status: "routed",
        note: "Started tracked task",
        replyText: "任务已接管。",
      };
    }
  }

  return {
    status: "fallback",
    reason: result.error ?? "failed to start tracked execution",
  };
}

export interface TrackedExecutionOptions {
  ctx: MsgContext;
  intentResult: IntentAnalysisResult;
  cfg: OpenClawConfig;
  agentId: string;
  agentSessionKey?: string;
  workspaceDir?: string;
}

/**
 * Check if we should route to tracked execution
 */
export function shouldRouteToTrackedExecution(intentResult: IntentAnalysisResult): boolean {
  return (
    intentResult.input_finalized &&
    intentResult.intent_type === UserIntentType.EXECUTION &&
    intentResult.execution_required
  );
}

/**
 * Check for pending follow-ups
 */
export async function checkForPendingFollowups(): Promise<boolean> {
  // For testing purposes, allow mock implementation injection
  if (globalThis.__OPENCLAW_TEST_checkForPendingFollowups) {
    return globalThis.__OPENCLAW_TEST_checkForPendingFollowups();
  }

  const pendingFollowups = await listPendingFollowupFiles();
  return pendingFollowups.length > 0;
}

/**
 * Get the next pending follow-up
 */
export async function getNextFollowup(): Promise<string | null> {
  // For testing purposes, allow mock implementation injection
  if (globalThis.__OPENCLAW_TEST_getNextFollowup) {
    return globalThis.__OPENCLAW_TEST_getNextFollowup();
  }

  const followupsDir = getTaskFollowupsDirectory();
  try {
    const pendingFollowups = await listPendingFollowupFiles();
    if (pendingFollowups.length > 0) {
      const followupFile = join(followupsDir, pendingFollowups[0]);
      const content = await fs.readFile(followupFile, "utf8");
      return content.trim();
    }
  } catch {
    // If there's an error reading, return null
  }

  return null;
}

/**
 * Route an execution intent request to the configured tracked orchestrator backend
 */
export async function routeToTrackedExecution(
  options: TrackedExecutionOptions,
): Promise<RoutedResult> {
  const { ctx, intentResult, agentId, agentSessionKey, workspaceDir, cfg } = options;

  if (!shouldRouteToTrackedExecution(intentResult)) {
    return {
      status: "fallback",
      reason: "not an execution intent request",
    };
  }

  // Check if there are pending follow-ups before starting a new execution
  const hasPendingFollowups = await checkForPendingFollowups();
  if (hasPendingFollowups) {
    return {
      status: "fallback",
      reason: "pending follow-ups exist",
    };
  }

  const messageText = ctx.BodyForAgent ?? ctx.Body ?? "";
  const backend = getConfiguredBackend(cfg);

  console.log(`Using tracked execution backend: ${backend}`);

  if (backend === "opc_orchestrator") {
    return await routeToOpcOrchestrator(messageText, agentId, agentSessionKey, workspaceDir, ctx);
  }

  // Use subagent_session as default or fallback
  return await routeToSubagentSession(messageText, agentId, agentSessionKey, workspaceDir, ctx);
}
