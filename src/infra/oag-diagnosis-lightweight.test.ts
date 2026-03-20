import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfigReturn: {
    gateway: { oag: { evolution: { autoApply: false } } },
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-5" },
        models: {
          "openai/gpt-4o-mini": {},
          "anthropic/claude-sonnet-4-5": {},
        },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
          models: [
            {
              id: "gpt-4o-mini",
              name: "gpt-4o-mini",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
        anthropic: {
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com/v1",
          models: [
            {
              id: "claude-sonnet-4-5",
              name: "claude-sonnet-4-5",
              api: "anthropic-messages",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
  } as Record<string, unknown>,
  resolveApiKeyForProvider: vi.fn(async ({ provider }: { provider: string }) => ({
    apiKey: `${provider}-key`,
    source: `env:${provider}`,
    mode: provider === "anthropic" ? "api-key" : "api-key",
  })),
  composeDiagnosisPrompt: vi.fn(() => "diagnosis prompt"),
  parseDiagnosisResponse: vi.fn(() => ({
    rootCause: "timeout",
    analysis: "details",
    confidence: 0.9,
    recommendations: [],
    preventive: "monitor",
  })),
  completeDiagnosis: vi.fn(async () => ({
    rootCause: "timeout",
    analysis: "details",
    confidence: 0.9,
    recommendations: [],
    preventive: "monitor",
  })),
  recordDiagnosis: vi.fn(async () => undefined),
  loadOagMemory: vi.fn(async () => ({ version: 1, lifecycles: [], evolutions: [], diagnoses: [] })),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => mocks.loadConfigReturn,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: mocks.resolveApiKeyForProvider,
}));

vi.mock("./oag-diagnosis.js", () => ({
  composeDiagnosisPrompt: mocks.composeDiagnosisPrompt,
  parseDiagnosisResponse: mocks.parseDiagnosisResponse,
  completeDiagnosis: mocks.completeDiagnosis,
}));

vi.mock("./oag-memory.js", () => ({
  loadOagMemory: mocks.loadOagMemory,
  recordDiagnosis: mocks.recordDiagnosis,
}));

vi.mock("./oag-config-writer.js", () => ({
  applyOagConfigChanges: vi.fn(async () => ({ applied: true })),
}));

const { runLightweightDiagnosis } = await import("./oag-diagnosis-lightweight.js");

describe("oag-diagnosis-lightweight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it("uses the configured default model instead of the first allowlist key", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: '{"rootCause":"timeout","analysis":"details","confidence":0.9,"recommendations":[],"preventive":"monitor"}',
          },
        ],
      }),
    } as Response);

    const result = await runLightweightDiagnosis(
      { type: "recurring_pattern", description: "test" },
      "diag-default",
    );

    expect(result.ran).toBe(true);
    expect(mocks.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic" }),
    );
    expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    const init = vi.mocked(global.fetch).mock.calls[0]?.[1];
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("claude-sonnet-4-5");
  });

  it("uses anthropic transport for anthropic-messages models", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: '{"rootCause":"timeout","analysis":"details","confidence":0.9,"recommendations":[],"preventive":"monitor"}',
          },
        ],
      }),
    } as Response);

    await runLightweightDiagnosis(
      { type: "recurring_pattern", description: "test" },
      "diag-anthropic",
    );

    const [urlArg, init] = vi.mocked(global.fetch).mock.calls[0] ?? [];
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    expect(urlArg?.toString()).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "anthropic-key",
    });
  });

  it("supports openai-compatible transport for the configured default model", async () => {
    mocks.loadConfigReturn = {
      gateway: { oag: { evolution: { autoApply: false } } },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-4o-mini" },
          models: {
            "anthropic/claude-sonnet-4-5": {},
            "openai/gpt-4o-mini": {},
          },
        },
      },
      models: {
        providers: {
          openai: {
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-4o-mini",
                name: "gpt-4o-mini",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    };
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '{"rootCause":"timeout","analysis":"details","confidence":0.9,"recommendations":[],"preventive":"monitor"}',
            },
          },
        ],
      }),
    } as Response);

    await runLightweightDiagnosis(
      { type: "recurring_pattern", description: "test" },
      "diag-openai",
    );

    const [urlArg, init] = vi.mocked(global.fetch).mock.calls[0] ?? [];
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    expect(urlArg?.toString()).toBe("https://api.openai.com/v1/chat/completions");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer openai-key",
    });
  });

  it("respects the same auto-apply allowlist as dispatchDiagnosis", async () => {
    mocks.loadConfigReturn = {
      gateway: { oag: { evolution: { autoApply: true } } },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-5" },
          models: {
            "anthropic/claude-sonnet-4-5": {},
          },
        },
      },
      models: {
        providers: {
          anthropic: {
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com/v1",
            models: [
              {
                id: "claude-sonnet-4-5",
                name: "claude-sonnet-4-5",
                api: "anthropic-messages",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    };
    mocks.parseDiagnosisResponse.mockReturnValueOnce({
      rootCause: "timeout",
      analysis: "details",
      confidence: 0.9,
      recommendations: [
        {
          type: "config_change",
          description: "allowed",
          configPath: "gateway.oag.delivery.maxRetries",
          suggestedValue: 5,
          risk: "low",
        },
        {
          type: "config_change",
          description: "blocked",
          configPath: "gateway.oag.evolution.autoApply",
          suggestedValue: true,
          risk: "low",
        },
      ],
      preventive: "monitor",
    });
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "ignored" }] }),
    } as Response);

    const { applyOagConfigChanges } = await import("./oag-config-writer.js");

    const result = await runLightweightDiagnosis(
      { type: "recurring_pattern", description: "test" },
      "diag-allowlist",
    );

    expect(result).toMatchObject({ ran: true, applied: 1 });
    expect(applyOagConfigChanges).toHaveBeenCalledWith([
      { configPath: "gateway.oag.delivery.maxRetries", value: 5 },
    ]);
  });

  it("uses the provided prompt override instead of recomposing gateway context", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: '{"rootCause":"timeout","analysis":"details","confidence":0.9,"recommendations":[],"preventive":"monitor"}',
          },
        ],
      }),
    } as Response);

    await runLightweightDiagnosis(
      { type: "recovery_degraded", description: "real trigger" },
      "diag-prompt-override",
      "preserved prompt from gateway",
    );

    const init = vi.mocked(global.fetch).mock.calls[0]?.[1];
    const body = JSON.parse(init?.body as string);
    expect(body.messages).toEqual([{ role: "user", content: "preserved prompt from gateway" }]);
    expect(mocks.composeDiagnosisPrompt).not.toHaveBeenCalled();
  });
});
