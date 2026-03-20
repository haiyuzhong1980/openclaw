/**
 * Cost Tracker Module
 * Tracks token consumption and API costs
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface CostRecord {
  id: string;
  timestamp: string;
  agentId: string;
  sessionId: string;
  taskId?: string;

  // Token usage
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;

  // Cost in USD
  inputCost: number;
  outputCost: number;
  totalCost: number;

  // Model info
  model: string;
  provider: string;
}

export interface CostSummary {
  totalCost: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byAgent: Record<string, AgentCostSummary>;
  byModel: Record<string, ModelCostSummary>;
  byProvider: Record<string, ProviderCostSummary>;
}

export interface AgentCostSummary {
  agentId: string;
  totalCost: number;
  totalTokens: number;
  sessions: number;
  tasks: number;
}

export interface ModelCostSummary {
  model: string;
  totalCost: number;
  totalTokens: number;
  calls: number;
  avgCostPerCall: number;
}

export interface ProviderCostSummary {
  provider: string;
  totalCost: number;
  totalTokens: number;
  models: string[];
}

export interface CostFilter {
  agentId?: string;
  sessionId?: string;
  taskId?: string;
  model?: string;
  provider?: string;
  from?: string;
  to?: string;
}

export interface PricingConfig {
  inputCostPer1k: number;
  outputCostPer1k: number;
}

// ============================================================================
// Default Pricing
// ============================================================================

const DEFAULT_PRICING: Record<string, PricingConfig> = {
  "gpt-4": { inputCostPer1k: 0.03, outputCostPer1k: 0.06 },
  "gpt-4-turbo": { inputCostPer1k: 0.01, outputCostPer1k: 0.03 },
  "gpt-3.5-turbo": { inputCostPer1k: 0.0005, outputCostPer1k: 0.0015 },
  "claude-3-opus": { inputCostPer1k: 0.015, outputCostPer1k: 0.075 },
  "claude-3-sonnet": { inputCostPer1k: 0.003, outputCostPer1k: 0.015 },
  "claude-3-haiku": { inputCostPer1k: 0.00025, outputCostPer1k: 0.00125 },
  "qianfan-code-latest": { inputCostPer1k: 0.0025, outputCostPer1k: 0.01 },
  default: { inputCostPer1k: 0.01, outputCostPer1k: 0.03 },
};

// ============================================================================
// CostTracker Implementation
// ============================================================================

export class CostTracker {
  private dataDir: string;
  private records: CostRecord[];
  private pricing: Record<string, PricingConfig>;

  constructor(options?: { dataDir?: string; pricing?: Record<string, PricingConfig> }) {
    this.dataDir = options?.dataDir ?? path.join(os.homedir(), ".openclaw", "cost");
    this.records = [];
    this.pricing = { ...DEFAULT_PRICING, ...options?.pricing };
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await this.loadRecords();
  }

  private async loadRecords(): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    const filePath = path.join(this.dataDir, `costs-${today}.json`);

    if (existsSync(filePath)) {
      const content = await readFile(filePath, "utf8");
      this.records = JSON.parse(content);
    } else {
      this.records = [];
    }
  }

  private async saveRecords(): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    const filePath = path.join(this.dataDir, `costs-${today}.json`);
    await writeFile(filePath, JSON.stringify(this.records, null, 2), "utf8");
  }

  // --------------------------------------------------------------------------
  // Recording
  // --------------------------------------------------------------------------

  record(params: {
    agentId: string;
    sessionId: string;
    taskId?: string;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
  }): CostRecord {
    const pricing = this.pricing[params.model] ?? this.pricing["default"];

    const inputCost = (params.inputTokens / 1000) * pricing.inputCostPer1k;
    const outputCost = (params.outputTokens / 1000) * pricing.outputCostPer1k;

    const record: CostRecord = {
      id: `cost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      agentId: params.agentId,
      sessionId: params.sessionId,
      taskId: params.taskId,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      totalTokens: params.inputTokens + params.outputTokens,
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
      model: params.model,
      provider: params.provider,
    };

    this.records.push(record);

    // Async save (non-blocking)
    this.saveRecords().catch(() => {});

    return record;
  }

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------

  getRecords(filter?: CostFilter): CostRecord[] {
    return this.records.filter((r) => this.matchesFilter(r, filter));
  }

  getSummary(filter?: CostFilter): CostSummary {
    const records = this.getRecords(filter);

    const byAgent: Record<string, AgentCostSummary> = {};
    const byModel: Record<string, ModelCostSummary> = {};
    const byProvider: Record<string, ProviderCostSummary> = {};

    let totalCost = 0;
    let totalTokens = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const r of records) {
      totalCost += r.totalCost;
      totalTokens += r.totalTokens;
      totalInputTokens += r.inputTokens;
      totalOutputTokens += r.outputTokens;

      // By agent
      if (!byAgent[r.agentId]) {
        byAgent[r.agentId] = {
          agentId: r.agentId,
          totalCost: 0,
          totalTokens: 0,
          sessions: 0,
          tasks: 0,
        };
      }
      byAgent[r.agentId].totalCost += r.totalCost;
      byAgent[r.agentId].totalTokens += r.totalTokens;

      // By model
      if (!byModel[r.model]) {
        byModel[r.model] = {
          model: r.model,
          totalCost: 0,
          totalTokens: 0,
          calls: 0,
          avgCostPerCall: 0,
        };
      }
      byModel[r.model].totalCost += r.totalCost;
      byModel[r.model].totalTokens += r.totalTokens;
      byModel[r.model].calls++;

      // By provider
      if (!byProvider[r.provider]) {
        byProvider[r.provider] = {
          provider: r.provider,
          totalCost: 0,
          totalTokens: 0,
          models: [],
        };
      }
      byProvider[r.provider].totalCost += r.totalCost;
      byProvider[r.provider].totalTokens += r.totalTokens;
      if (!byProvider[r.provider].models.includes(r.model)) {
        byProvider[r.provider].models.push(r.model);
      }
    }

    // Calculate averages
    for (const model of Object.values(byModel)) {
      model.avgCostPerCall = model.calls > 0 ? model.totalCost / model.calls : 0;
    }

    return {
      totalCost,
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      byAgent,
      byModel,
      byProvider,
    };
  }

  // --------------------------------------------------------------------------
  // Pricing Management
  // --------------------------------------------------------------------------

  setPricing(model: string, config: PricingConfig): void {
    this.pricing[model] = config;
  }

  getPricing(model: string): PricingConfig {
    return this.pricing[model] ?? this.pricing["default"];
  }

  // --------------------------------------------------------------------------
  // Export
  // --------------------------------------------------------------------------

  exportToJson(filter?: CostFilter): string {
    return JSON.stringify(this.getRecords(filter), null, 2);
  }

  exportToCsv(filter?: CostFilter): string {
    const records = this.getRecords(filter);
    const headers = [
      "id",
      "timestamp",
      "agentId",
      "sessionId",
      "taskId",
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "inputCost",
      "outputCost",
      "totalCost",
      "model",
      "provider",
    ];

    const rows = records.map((r) =>
      [
        r.id,
        r.timestamp,
        r.agentId,
        r.sessionId,
        r.taskId ?? "",
        r.inputTokens,
        r.outputTokens,
        r.totalTokens,
        r.inputCost.toFixed(6),
        r.outputCost.toFixed(6),
        r.totalCost.toFixed(6),
        r.model,
        r.provider,
      ].join(","),
    );

    return [headers.join(","), ...rows].join("\n");
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private matchesFilter(record: CostRecord, filter?: CostFilter): boolean {
    if (!filter) {
      return true;
    }

    if (filter.agentId && record.agentId !== filter.agentId) {
      return false;
    }
    if (filter.sessionId && record.sessionId !== filter.sessionId) {
      return false;
    }
    if (filter.taskId && record.taskId !== filter.taskId) {
      return false;
    }
    if (filter.model && record.model !== filter.model) {
      return false;
    }
    if (filter.provider && record.provider !== filter.provider) {
      return false;
    }
    if (filter.from && new Date(record.timestamp) < new Date(filter.from)) {
      return false;
    }
    if (filter.to && new Date(record.timestamp) > new Date(filter.to)) {
      return false;
    }

    return true;
  }

  clear(): void {
    this.records = [];
  }
}

export default CostTracker;
