import * as fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { routeReply } from "../auto-reply/reply/route-reply.js";
import type { OriginatingChannelType } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("task-terminal-notifier");
const TASK_SCAN_INTERVAL_MS = 3_000;

type NotificationState = {
  channel?: OriginatingChannelType;
  to?: string;
  accountId?: string | null;
  threadId?: string | number | null;
  sessionKey?: string | null;
  taskAcceptedReplySentAt?: string | null;
  terminalReplySentAt?: string | null;
  lastTerminalReplyError?: string | null;
};

type TaskStatus = {
  task_id?: string;
  title?: string;
  state?: string;
  notification?: NotificationState;
};

type TaskEvent = {
  event?: string;
  stdout?: string;
  stderr?: string;
};

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(trimmed);
}

function convertMarkdownTablesToBullets(text: string): string {
  const lines = text.split("\n");
  const normalized: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    if (!line.trim().startsWith("|") || !isMarkdownTableSeparator(next)) {
      normalized.push(line);
      continue;
    }

    const headers = parseMarkdownTableRow(line);
    index += 2;
    while (index < lines.length) {
      const rowLine = lines[index] ?? "";
      if (!rowLine.trim().startsWith("|")) {
        index -= 1;
        break;
      }
      const cells = parseMarkdownTableRow(rowLine);
      const parts = headers
        .map((header, cellIndex) => {
          const value = cells[cellIndex] ?? "";
          if (!header || !value) {
            return null;
          }
          return `${header}: ${value}`;
        })
        .filter(Boolean);
      normalized.push(parts.length > 0 ? `- ${parts.join("；")}` : rowLine);
      index += 1;
    }
  }

  return normalized.join("\n");
}

function taskRoot(): string {
  return join(os.homedir(), ".openclaw", "orchestrator", "tasks");
}

function extractSemver(value: string): string | undefined {
  return value.match(/\b\d+\.\d+\.\d+\b/)?.[0];
}

function extractTextPayloadsFromJson(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as {
    payloads?: Array<{ text?: unknown }>;
    result?: { payloads?: Array<{ text?: unknown }> };
  };
  const payloads = [
    ...(Array.isArray(record.payloads) ? record.payloads : []),
    ...(Array.isArray(record.result?.payloads) ? record.result.payloads : []),
  ];
  return payloads
    .map((payload) => (typeof payload?.text === "string" ? payload.text.trim() : ""))
    .filter(Boolean);
}

function extractFinalResponse(stdout: string): string | undefined {
  const match = stdout.match(/### Final response(?:\r?\n){1,2}```(?:\r?\n)?([\s\S]*?)\r?\n```/);
  const text = match?.[1]?.trim();
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const payloadTexts = extractTextPayloadsFromJson(parsed);
    if (payloadTexts.length > 0) {
      return payloadTexts.join("\n\n");
    }
    return undefined;
  } catch {
    return text;
  }
}

function summarizeOutput(stdout: string): string | undefined {
  const finalResponse = extractFinalResponse(stdout);
  if (finalResponse) {
    return `结果：\n${finalResponse}`;
  }
  const semver = extractSemver(stdout);
  if (semver) {
    return `结果：${semver}`;
  }
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const summaryIndex = lines.findIndex((line) => line === "Result summary:");
  if (summaryIndex >= 0) {
    const summaryLines: string[] = [];
    for (const line of lines.slice(summaryIndex + 1)) {
      if (
        /^## Step\b/.test(line) ||
        /^### Agent run\b/.test(line) ||
        /^### Final response\b/.test(line)
      ) {
        break;
      }
      summaryLines.push(line);
    }
    if (summaryLines.length > 0) {
      return `结果：\n${summaryLines.join("\n")}`;
    }
  }
  const compact = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join("\n");
  return compact || undefined;
}

function mapFailureReason(value: string): string {
  if (value.includes("No executable plan matched")) {
    return "当前还不会执行这类请求。";
  }
  return value;
}

async function readTaskEvents(taskDir: string): Promise<TaskEvent[]> {
  const eventsPath = join(taskDir, "events.jsonl");
  try {
    const raw = await fs.readFile(eventsPath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TaskEvent);
  } catch {
    return [];
  }
}

async function buildTerminalReply(taskDir: string, status: TaskStatus): Promise<string | null> {
  const taskId = status.task_id ?? "unknown-task";
  const title = status.title ?? taskId;
  const events = await readTaskEvents(taskDir);
  const lastCompleted = [...events]
    .toReversed()
    .find((event) => event.event === "tracked_run_completed");
  const lastFailed = [...events].toReversed().find((event) => event.event === "tracked_run_failed");

  if (status.state === "completed") {
    const summary = summarizeOutput(lastCompleted?.stdout ?? "");
    if (summary) {
      return `任务已完成：${title}\n${summary}\n任务ID：${taskId}`;
    }
    return `任务已完成：${title}\n任务ID：${taskId}`;
  }

  if (status.state === "failed" || status.state === "blocked") {
    let reason = (lastFailed?.stdout ?? "").trim();
    try {
      const parsed = JSON.parse(reason) as { reason?: string };
      if (typeof parsed.reason === "string" && parsed.reason.trim()) {
        reason = parsed.reason.trim();
      }
    } catch {
      // Keep raw stdout when it is not JSON.
    }
    const text = reason ? mapFailureReason(reason) : "任务执行失败。";
    return `任务未完成：${title}\n原因：${text}\n任务ID：${taskId}`;
  }

  return null;
}

async function notifyTask(cfg: OpenClawConfig, taskDir: string, statusPath: string): Promise<void> {
  const raw = await fs.readFile(statusPath, "utf8");
  const status = JSON.parse(raw) as TaskStatus;
  const notification = status.notification;
  if (!notification?.channel || !notification.to || notification.terminalReplySentAt) {
    return;
  }
  if (!["completed", "failed", "blocked"].includes(status.state ?? "")) {
    return;
  }

  const text = await buildTerminalReply(taskDir, status);
  if (!text) {
    return;
  }
  const payloadText =
    notification.channel === "telegram" ? convertMarkdownTablesToBullets(text) : text;

  const result = await routeReply({
    payload: { text: payloadText },
    channel: notification.channel,
    to: notification.to,
    sessionKey: notification.sessionKey ?? undefined,
    accountId: notification.accountId ?? undefined,
    threadId: notification.threadId ?? undefined,
    cfg,
  });

  status.notification = {
    ...notification,
    terminalReplySentAt: result.ok ? new Date().toISOString() : null,
    lastTerminalReplyError: result.ok ? null : (result.error ?? "unknown delivery failure"),
  };
  await fs.writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");

  if (!result.ok) {
    log.warn(
      `failed to deliver task terminal reply (${status.task_id ?? "unknown"}): ${result.error ?? "unknown"}`,
    );
  }
}

export type TaskTerminalNotifierHandle = {
  stop: () => Promise<void>;
};

export function startTaskTerminalNotifier(cfg: OpenClawConfig): TaskTerminalNotifierHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      const entries = await fs.readdir(taskRoot(), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const taskDir = join(taskRoot(), entry.name);
        const statusPath = join(taskDir, "status.json");
        try {
          await notifyTask(cfg, taskDir, statusPath);
        } catch (err) {
          log.warn(`task terminal notifier failed for ${entry.name}: ${String(err)}`);
        }
      }
    } catch {
      // Ignore missing task root.
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, TASK_SCAN_INTERVAL_MS);
  void tick();

  return {
    stop: async () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
