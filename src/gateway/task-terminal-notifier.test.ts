import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  let status = {
    task_id: "TASK-1",
    title: "test task",
    state: "failed",
    notification: {
      channel: "telegram",
      to: "123",
      accountId: null,
      threadId: null,
      sessionKey: "agent:main:test",
      taskAcceptedReplySentAt: "2026-03-09T10:00:00.000Z",
      terminalReplySentAt: null,
      lastTerminalReplyError: null,
    },
  };
  let events = [
    JSON.stringify({
      event: "tracked_run_failed",
      stdout: JSON.stringify({ reason: "No executable plan matched the request." }),
    }),
  ].join("\n");
  const routeReplyMock = vi.fn();
  const writeFileMock = vi.fn(async (_path: string, data: string) => {
    status = JSON.parse(data);
  });

  return {
    get status() {
      return status;
    },
    set status(next) {
      status = next;
    },
    get events() {
      return events;
    },
    set events(next: string) {
      events = next;
    },
    routeReplyMock,
    writeFileMock,
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => "/Users/test",
  };
});

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => [{ isDirectory: () => true, name: "TASK-1" }]),
  readFile: vi.fn(async (path: string) => {
    if (path.endsWith("status.json")) {
      return `${JSON.stringify(state.status)}\n`;
    }
    if (path.endsWith("events.jsonl")) {
      return state.events;
    }
    throw new Error(`unexpected read: ${path}`);
  }),
  writeFile: (...args: unknown[]) => state.writeFileMock(...args),
}));

vi.mock("../auto-reply/reply/route-reply.js", () => ({
  routeReply: (...args: unknown[]) => state.routeReplyMock(...args),
}));

const { startTaskTerminalNotifier } = await import("./task-terminal-notifier.js");

describe("task-terminal-notifier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.status = {
      task_id: "TASK-1",
      title: "test task",
      state: "failed",
      notification: {
        channel: "telegram",
        to: "123",
        accountId: null,
        threadId: null,
        sessionKey: "agent:main:test",
        taskAcceptedReplySentAt: "2026-03-09T10:00:00.000Z",
        terminalReplySentAt: null,
        lastTerminalReplyError: null,
      },
    };
    state.events = JSON.stringify({
      event: "tracked_run_failed",
      stdout: JSON.stringify({ reason: "No executable plan matched the request." }),
    });
    state.routeReplyMock.mockReset();
    state.routeReplyMock.mockResolvedValue({ ok: true });
    state.writeFileMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers one terminal follow-up for failed tracked tasks", async () => {
    const handle = startTaskTerminalNotifier({} as never);
    await vi.advanceTimersByTimeAsync(3_100);

    expect(state.routeReplyMock).toHaveBeenCalledTimes(1);
    expect(state.routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          text: "任务未完成：test task\n原因：当前还不会执行这类请求。\n任务ID：TASK-1",
        },
        channel: "telegram",
        to: "123",
      }),
    );
    expect(state.status.notification?.terminalReplySentAt).toBeTruthy();

    await vi.advanceTimersByTimeAsync(3_100);
    expect(state.routeReplyMock).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it("extracts structured result summaries for completed tracked tasks", async () => {
    state.status = {
      task_id: "TASK-2",
      title: "github lookup",
      state: "completed",
      notification: {
        channel: "telegram",
        to: "123",
        accountId: null,
        threadId: null,
        sessionKey: "agent:main:test",
        taskAcceptedReplySentAt: "2026-03-09T10:00:00.000Z",
        terminalReplySentAt: null,
        lastTerminalReplyError: null,
      },
    };
    state.events = [
      JSON.stringify({
        event: "tracked_run_completed",
        stdout: [
          "# Tracked Request Result",
          "Request: github lookup",
          "Result summary:",
          "GitHub Top Results:",
          "- openclaw/skill-a (120 stars)",
          "- openclaw/plugin-b (90 stars)",
        ].join("\n"),
      }),
    ].join("\n");

    const handle = startTaskTerminalNotifier({} as never);
    await vi.advanceTimersByTimeAsync(3_100);

    expect(state.routeReplyMock).toHaveBeenCalledTimes(1);
    expect(state.routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          text: [
            "任务已完成：github lookup",
            "结果：",
            "GitHub Top Results:",
            "- openclaw/skill-a (120 stars)",
            "- openclaw/plugin-b (90 stars)",
            "任务ID：TASK-2",
          ].join("\n"),
        },
      }),
    );

    await handle.stop();
  });

  it("does not truncate structured summaries when the task output already contains the requested count", async () => {
    state.status = {
      task_id: "TASK-3",
      title: "github top 5",
      state: "completed",
      notification: {
        channel: "telegram",
        to: "123",
        accountId: null,
        threadId: null,
        sessionKey: "agent:main:test",
        taskAcceptedReplySentAt: "2026-03-09T10:00:00.000Z",
        terminalReplySentAt: null,
        lastTerminalReplyError: null,
      },
    };
    state.events = [
      JSON.stringify({
        event: "tracked_run_completed",
        stdout: [
          "# Tracked Request Result",
          "Request: github top 5",
          "Result summary:",
          "GitHub Top Results:",
          "- repo/1 (100 stars)",
          "- repo/2 (90 stars)",
          "- repo/3 (80 stars)",
          "- repo/4 (70 stars)",
          "- repo/5 (60 stars)",
          "## Step 1: GitHub repositories",
        ].join("\n"),
      }),
    ].join("\n");

    const handle = startTaskTerminalNotifier({} as never);
    await vi.advanceTimersByTimeAsync(3_100);

    expect(state.routeReplyMock).toHaveBeenCalledTimes(1);
    expect(state.routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          text: [
            "任务已完成：github top 5",
            "结果：",
            "GitHub Top Results:",
            "- repo/1 (100 stars)",
            "- repo/2 (90 stars)",
            "- repo/3 (80 stars)",
            "- repo/4 (70 stars)",
            "- repo/5 (60 stars)",
            "任务ID：TASK-3",
          ].join("\n"),
        },
      }),
    );

    await handle.stop();
  });

  it("uses the full structured summary body for generic worker-agent completions", async () => {
    state.status = {
      task_id: "TASK-4",
      title: "generic worker task",
      state: "completed",
      notification: {
        channel: "telegram",
        to: "123",
        accountId: null,
        threadId: null,
        sessionKey: "agent:main:test",
        taskAcceptedReplySentAt: "2026-03-09T10:00:00.000Z",
        terminalReplySentAt: null,
        lastTerminalReplyError: null,
      },
    };
    state.events = [
      JSON.stringify({
        event: "tracked_run_completed",
        stdout: [
          "# Tracked Request Result",
          "Request: generic worker task",
          "Result summary:",
          "第一行结果",
          "第二行结果",
          "第三行结果",
          "## Step 1: Worker agent execution",
        ].join("\n"),
      }),
    ].join("\n");

    const handle = startTaskTerminalNotifier({} as never);
    await vi.advanceTimersByTimeAsync(3_100);

    expect(state.routeReplyMock).toHaveBeenCalledTimes(1);
    expect(state.routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          text: [
            "任务已完成：generic worker task",
            "结果：",
            "第一行结果",
            "第二行结果",
            "第三行结果",
            "任务ID：TASK-4",
          ].join("\n"),
        },
      }),
    );

    await handle.stop();
  });

  it("keeps markdown section headings in structured summaries", async () => {
    state.status = {
      task_id: "TASK-5",
      title: "discussion summary",
      state: "completed",
      notification: {
        channel: "telegram",
        to: "123",
        accountId: null,
        threadId: null,
        sessionKey: "agent:main:test",
        taskAcceptedReplySentAt: "2026-03-09T10:00:00.000Z",
        terminalReplySentAt: null,
        lastTerminalReplyError: null,
      },
    };
    state.events = [
      JSON.stringify({
        event: "tracked_run_completed",
        stdout: [
          "# Tracked Request Result",
          "Request: discussion summary",
          "Result summary:",
          "## 一、热门讨论区入口",
          "- 入口 A",
          "- 入口 B",
          "## 二、问题类",
          "- 问题 1",
          "## Step 1: Worker agent execution",
        ].join("\n"),
      }),
    ].join("\n");

    const handle = startTaskTerminalNotifier({} as never);
    await vi.advanceTimersByTimeAsync(3_100);

    expect(state.routeReplyMock).toHaveBeenCalledTimes(1);
    expect(state.routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          text: [
            "任务已完成：discussion summary",
            "结果：",
            "## 一、热门讨论区入口",
            "- 入口 A",
            "- 入口 B",
            "## 二、问题类",
            "- 问题 1",
            "任务ID：TASK-5",
          ].join("\n"),
        },
      }),
    );

    await handle.stop();
  });

  it("prefers the worker final response over the intermediate summary", async () => {
    state.status = {
      task_id: "TASK-6",
      title: "worker final response",
      state: "completed",
      notification: {
        channel: "telegram",
        to: "123",
        accountId: null,
        threadId: null,
        sessionKey: "agent:main:test",
        taskAcceptedReplySentAt: "2026-03-09T10:00:00.000Z",
        terminalReplySentAt: null,
        lastTerminalReplyError: null,
      },
    };
    state.events = [
      JSON.stringify({
        event: "tracked_run_completed",
        stdout: [
          "# Tracked Request Result",
          "Request: worker final response",
          "Result summary:",
          "摘要第一行",
          "摘要第二行",
          "## Step 1: Worker agent execution",
          "",
          "### Agent run",
          "- status: ok",
          "",
          "### Final response",
          "```",
          "最终答案第一行",
          "最终答案第二行",
          "```",
        ].join("\n"),
      }),
    ].join("\n");

    const handle = startTaskTerminalNotifier({} as never);
    await vi.advanceTimersByTimeAsync(3_100);

    expect(state.routeReplyMock).toHaveBeenCalledTimes(1);
    expect(state.routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          text: [
            "任务已完成：worker final response",
            "结果：",
            "最终答案第一行",
            "最终答案第二行",
            "任务ID：TASK-6",
          ].join("\n"),
        },
      }),
    );

    await handle.stop();
  });

  it("converts markdown tables to bullet rows for telegram terminal replies", async () => {
    state.status = {
      task_id: "TASK-7",
      title: "telegram table reply",
      state: "completed",
      notification: {
        channel: "telegram",
        to: "123",
        accountId: null,
        threadId: null,
        sessionKey: "agent:main:test",
        taskAcceptedReplySentAt: "2026-03-09T10:00:00.000Z",
        terminalReplySentAt: null,
        lastTerminalReplyError: null,
      },
    };
    state.events = [
      JSON.stringify({
        event: "tracked_run_completed",
        stdout: [
          "# Tracked Request Result",
          "Request: telegram table reply",
          "### Final response",
          "```",
          "## Issues",
          "| 标题 | 评论数 | 链接 |",
          "|------|--------|------|",
          "| issue a | 12 | https://example.com/a |",
          "| issue b | 8 | https://example.com/b |",
          "```",
        ].join("\n"),
      }),
    ].join("\n");

    const handle = startTaskTerminalNotifier({} as never);
    await vi.advanceTimersByTimeAsync(3_100);

    expect(state.routeReplyMock).toHaveBeenCalledTimes(1);
    expect(state.routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          text: [
            "任务已完成：telegram table reply",
            "结果：",
            "## Issues",
            "- 标题: issue a；评论数: 12；链接: https://example.com/a",
            "- 标题: issue b；评论数: 8；链接: https://example.com/b",
            "任务ID：TASK-7",
          ].join("\n"),
        },
      }),
    );

    await handle.stop();
  });

  it("falls back to the structured summary when final response is metadata-only json", async () => {
    state.status = {
      task_id: "TASK-8",
      title: "metadata only json",
      state: "completed",
      notification: {
        channel: "telegram",
        to: "123",
        accountId: null,
        threadId: null,
        sessionKey: "agent:main:test",
        taskAcceptedReplySentAt: "2026-03-09T10:00:00.000Z",
        terminalReplySentAt: null,
        lastTerminalReplyError: null,
      },
    };
    state.events = [
      JSON.stringify({
        event: "tracked_run_completed",
        stdout: [
          "# Tracked Request Result",
          "Request: metadata only json",
          "Result summary:",
          "协同情况:",
          "- 主 agent: 负责汇总",
          "验收结果:",
          "- 通过: issues, skills",
          "### Final response",
          "```",
          JSON.stringify({
            runId: "run-1",
            status: "ok",
            result: {
              payloads: [],
              meta: {
                systemPromptReport: {
                  sessionKey: "agent:main:main",
                },
              },
            },
          }),
          "```",
        ].join("\n"),
      }),
    ].join("\n");

    const handle = startTaskTerminalNotifier({} as never);
    await vi.advanceTimersByTimeAsync(3_100);

    expect(state.routeReplyMock).toHaveBeenCalledTimes(1);
    expect(state.routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          text: [
            "任务已完成：metadata only json",
            "结果：",
            "协同情况:",
            "- 主 agent: 负责汇总",
            "验收结果:",
            "- 通过: issues, skills",
            "任务ID：TASK-8",
          ].join("\n"),
        },
      }),
    );

    await handle.stop();
  });
});
