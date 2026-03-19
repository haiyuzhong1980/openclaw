/**
 * Lightweight OAG diagnosis runner that doesn't require full session context.
 * Uses the configured LLM directly without the embedded runner overhead.
 */

import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveOagEvolutionAutoApply } from "./oag-config.js";
import {
  completeDiagnosis,
  composeDiagnosisPrompt,
  parseDiagnosisResponse,
  type DiagnosisTrigger,
  type DiagnosisResult,
} from "./oag-diagnosis.js";
import { loadOagMemory, recordDiagnosis } from "./oag-memory.js";

const log = createSubsystemLogger("oag/diagnosis-lightweight");

/**
 * Resolve the first available model configuration from the config.
 * Returns the model name, base URL, and API key if available.
 */
function resolveFirstModelConfig(cfg: OpenClawConfig): {
  model: string;
  baseUrl?: string;
  apiKey?: string;
} | null {
  const models = cfg.agents?.defaults?.models;
  if (!models) {
    return null;
  }
  // Get the first configured model
  for (const key of Object.keys(models)) {
    const modelConfig = models[key];
    if (modelConfig?.model) {
      return {
        model: modelConfig.model,
        baseUrl: modelConfig.baseUrl,
        apiKey: modelConfig.apiKey,
      };
    }
  }
  return null;
}

/**
 * Run a lightweight diagnosis using the configured LLM directly.
 * This is a fallback when the embedded runner is not available.
 */
export async function runLightweightDiagnosis(
  trigger: DiagnosisTrigger,
  diagnosisId: string,
): Promise<{ ran: boolean; result?: DiagnosisResult; applied: number }> {
  const cfg = loadConfig();

  // Check if we have a model configured
  const modelConfig = resolveFirstModelConfig(cfg);
  if (!modelConfig) {
    log.warn("No model configured for OAG diagnosis");
    return { ran: false, applied: 0 };
  }

  const memory = await loadOagMemory();
  const prompt = composeDiagnosisPrompt(trigger, memory);

  // Record the diagnosis attempt
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
    log.info(`Running lightweight diagnosis ${diagnosisId} with model ${modelConfig.model}`);

    // Use the model config to make a direct LLM call
    // This is a simplified version that uses fetch to call the API
    const response = await callLlmDirectly(modelConfig, prompt);

    const result = parseDiagnosisResponse(response);
    if (!result) {
      log.warn(`Diagnosis ${diagnosisId}: failed to parse response`);
      return { ran: true, applied: 0 };
    }

    // Complete the diagnosis record
    await completeDiagnosis(diagnosisId, response);

    // Apply low-risk config recommendations if auto-apply is enabled
    const autoApply = resolveOagEvolutionAutoApply(cfg);
    const lowRisk = autoApply
      ? result.recommendations.filter(
          (r) => r.type === "config_change" && r.risk === "low" && r.configPath,
        )
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
async function callLlmDirectly(
  modelConfig: { model: string; baseUrl?: string; apiKey?: string },
  prompt: string,
): Promise<string> {
  const baseUrl = modelConfig.baseUrl || "https://api.openai.com/v1";
  const url = `${baseUrl}/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${modelConfig.apiKey || ""}`,
    },
    body: JSON.stringify({
      model: modelConfig.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content || "";
}
