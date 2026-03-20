/**
 * Lightweight OAG diagnosis runner that doesn't require full session context.
 * Uses the configured LLM directly without the embedded runner overhead.
 */

import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ModelApi, ModelProviderConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveOagEvolutionAutoApply } from "./oag-config.js";
import { filterAutoApplicableDiagnosisRecommendations } from "./oag-diagnosis-dispatch.js";
import {
  completeDiagnosis,
  composeDiagnosisPrompt,
  parseDiagnosisResponse,
  type DiagnosisTrigger,
  type DiagnosisResult,
} from "./oag-diagnosis.js";
import { loadOagMemory, recordDiagnosis } from "./oag-memory.js";

const log = createSubsystemLogger("oag/diagnosis-lightweight");
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DIAGNOSIS_LLM_TIMEOUT_MS = 30_000;

type SupportedDiagnosisApi = Extract<ModelApi, "openai-completions" | "anthropic-messages">;

type DiagnosisModelConfig = {
  provider: string;
  model: string;
  api: SupportedDiagnosisApi;
  baseUrl: string;
  apiKey?: string;
  authMode?: "api-key" | "oauth" | "token" | "aws-sdk";
  authHeader?: boolean;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/, "");
}

function isAzureFoundryUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith(".services.ai.azure.com");
  } catch {
    return false;
  }
}

function isAzureOpenAiUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith(".openai.azure.com");
  } catch {
    return false;
  }
}

function isAzureUrl(baseUrl: string): boolean {
  return isAzureFoundryUrl(baseUrl) || isAzureOpenAiUrl(baseUrl);
}

function resolveAzureOpenAiBaseUrl(baseUrl: string, modelId: string): string {
  const normalizedUrl = normalizeBaseUrl(baseUrl).replace(/\/openai\/v1$/, "");
  if (normalizedUrl.includes("/openai/deployments/")) {
    return normalizedUrl;
  }
  return `${normalizedUrl}/openai/deployments/${modelId}`;
}

function resolveDiagnosisApi(params: {
  provider: string;
  providerConfig?: ModelProviderConfig;
  modelId: string;
}): SupportedDiagnosisApi | null {
  const configuredModel = params.providerConfig?.models?.find(
    (candidate) => candidate.id === params.modelId,
  );
  const api =
    configuredModel?.api ?? params.providerConfig?.api ?? inferDiagnosisApi(params.provider);
  if (api === "openai-completions" || api === "anthropic-messages") {
    return api;
  }
  return null;
}

function inferDiagnosisApi(provider: string): SupportedDiagnosisApi | null {
  if (provider === "anthropic") {
    return "anthropic-messages";
  }
  if (provider === "openai") {
    return "openai-completions";
  }
  return null;
}

/**
 * Resolve the configured default model and transport details for lightweight diagnosis.
 */
async function resolveDiagnosisModelConfig(
  cfg: OpenClawConfig,
): Promise<DiagnosisModelConfig | null> {
  const defaultModel = resolveDefaultModelForAgent({ cfg });
  const providerConfig = cfg.models?.providers?.[defaultModel.provider];
  const api = resolveDiagnosisApi({
    provider: defaultModel.provider,
    providerConfig,
    modelId: defaultModel.model,
  });
  if (!api) {
    log.warn(
      `OAG lightweight diagnosis does not support provider ${defaultModel.provider} model ${defaultModel.model}`,
    );
    return null;
  }

  const auth = await resolveApiKeyForProvider({
    provider: defaultModel.provider,
    cfg,
  });
  const apiKey = auth.source.includes("synthetic local key") ? undefined : auth.apiKey;

  return {
    provider: defaultModel.provider,
    model: defaultModel.model,
    api,
    baseUrl:
      api === "anthropic-messages"
        ? normalizeAnthropicBaseUrl(providerConfig?.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL)
        : normalizeBaseUrl(providerConfig?.baseUrl ?? DEFAULT_OPENAI_BASE_URL),
    apiKey,
    authMode: auth.mode,
    authHeader: providerConfig?.authHeader,
  };
}

/**
 * Run a lightweight diagnosis using the configured LLM directly.
 * This is a fallback when the embedded runner is not available.
 */
export async function runLightweightDiagnosis(
  trigger: DiagnosisTrigger,
  diagnosisId: string,
  promptOverride?: string,
): Promise<{ ran: boolean; result?: DiagnosisResult; applied: number }> {
  const cfg = loadConfig();

  const modelConfig = await resolveDiagnosisModelConfig(cfg);
  if (!modelConfig) {
    log.warn("No supported model configured for OAG diagnosis");
    return { ran: false, applied: 0 };
  }

  const memory = await loadOagMemory();
  const prompt = promptOverride ?? composeDiagnosisPrompt(trigger, memory);

  await recordDiagnosis({
    id: diagnosisId,
    triggeredAt: new Date().toISOString(),
    trigger: trigger.type,
    rootCause: "pending lightweight analysis",
    confidence: 0,
    recommendations: [],
    completedAt: "",
  });

  try {
    log.info(
      `Running lightweight diagnosis ${diagnosisId} with model ${modelConfig.provider}/${modelConfig.model}`,
    );

    const response = await callLlmDirectly(modelConfig, prompt);

    const result = parseDiagnosisResponse(response);
    if (!result) {
      log.warn(`Diagnosis ${diagnosisId}: failed to parse response`);
      return { ran: true, applied: 0 };
    }

    await completeDiagnosis(diagnosisId, response);

    const autoApply = resolveOagEvolutionAutoApply(cfg);
    const lowRisk = autoApply
      ? filterAutoApplicableDiagnosisRecommendations(result.recommendations)
      : [];

    if (lowRisk.length > 0) {
      const { applyOagConfigChanges } = await import("./oag-config-writer.js");
      const changes = lowRisk.map((r) => ({ configPath: r.configPath!, value: r.suggestedValue }));
      await applyOagConfigChanges(changes);
      log.info(`Diagnosis ${diagnosisId}: applied ${lowRisk.length} low-risk config changes`);
    }

    return { ran: true, result, applied: lowRisk.length };
  } catch (err) {
    log.error(`Lightweight diagnosis failed: ${String(err)}`);
    return { ran: false, applied: 0 };
  }
}

/**
 * Make a direct LLM API call without the embedded runner.
 * This is used when full session context is not available.
 */
async function callLlmDirectly(modelConfig: DiagnosisModelConfig, prompt: string): Promise<string> {
  if (modelConfig.api === "anthropic-messages") {
    return await callAnthropicDirectly(modelConfig, prompt);
  }
  return await callOpenAiCompatibleDirectly(modelConfig, prompt);
}

async function callOpenAiCompatibleDirectly(
  modelConfig: DiagnosisModelConfig,
  prompt: string,
): Promise<string> {
  const baseUrl = isAzureUrl(modelConfig.baseUrl)
    ? resolveAzureOpenAiBaseUrl(modelConfig.baseUrl, modelConfig.model)
    : modelConfig.baseUrl;
  const url = new URL("chat/completions", `${baseUrl}/`);
  if (isAzureUrl(modelConfig.baseUrl)) {
    url.searchParams.set("api-version", "2024-10-21");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (modelConfig.apiKey) {
    if (isAzureUrl(modelConfig.baseUrl) || modelConfig.authHeader === false) {
      headers["api-key"] = modelConfig.apiKey;
    } else {
      headers.Authorization = `Bearer ${modelConfig.apiKey}`;
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DIAGNOSIS_LLM_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelConfig.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2000,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callAnthropicDirectly(
  modelConfig: DiagnosisModelConfig,
  prompt: string,
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (modelConfig.apiKey) {
    if (modelConfig.authMode === "oauth" || modelConfig.authMode === "token") {
      headers.Authorization = `Bearer ${modelConfig.apiKey}`;
    } else {
      headers["x-api-key"] = modelConfig.apiKey;
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DIAGNOSIS_LLM_TIMEOUT_MS);

  try {
    const response = await fetch(`${modelConfig.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelConfig.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2000,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    return (data.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  } finally {
    clearTimeout(timeoutId);
  }
}
