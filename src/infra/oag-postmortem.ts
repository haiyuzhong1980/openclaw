import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { applyOagConfigChanges } from "./oag-config-writer.js";
import {
  resolveOagDeliveryMaxRetries,
  resolveOagDeliveryRecoveryBudgetMs,
  resolveOagEvolutionCooldownMs,
  resolveOagEvolutionMaxCumulativePercent,
  resolveOagEvolutionMaxNotificationsPerDay,
  resolveOagEvolutionMaxStepPercent,
  resolveOagEvolutionMinCrashesForAnalysis,
  resolveOagLockStaleMs,
  resolveOagStalePollFactor,
} from "./oag-config.js";
import { requestDiagnosis } from "./oag-diagnosis.js";
import { startEvolutionObservation } from "./oag-evolution-guard.js";
import { injectEvolutionNote } from "./oag-evolution-notify.js";
import {
  type OagMemory,
  appendAuditEntry,
  findRecurringIncidentPattern,
  getRecentCrashes,
  loadOagMemory,
  recordEvolution,
} from "./oag-memory.js";

const log = createSubsystemLogger("oag/postmortem");

// Non-configurable safety rails
const NOTIFICATION_WINDOW_MS = 24 * 60 * 60_000;
const MIN_PATTERN_OCCURRENCES = 3;
const ANALYSIS_WINDOW_HOURS = 48;

export type EvolutionRecommendation = {
  configPath: string;
  currentValue: number;
  suggestedValue: number;
  reason: string;
  risk: "low" | "medium" | "high";
  source: "heuristic";
};

type PostmortemResult = {
  analyzed: boolean;
  crashCount: number;
  patterns: number;
  recommendations: EvolutionRecommendation[];
  applied: EvolutionRecommendation[];
  skipped: EvolutionRecommendation[];
  userNotification?: string;
};

function clampChange(current: number, suggested: number, cfg: OpenClawConfig): number {
  const maxCumulative = resolveOagEvolutionMaxCumulativePercent(cfg);
  const maxStep = resolveOagEvolutionMaxStepPercent(cfg);
  const maxAllowed = current * (1 + maxCumulative / 100);
  const minAllowed = current * (1 - maxStep / 100);
  return Math.max(minAllowed, Math.min(maxAllowed, suggested));
}

function analyzePatterns(memory: OagMemory, cfg: OpenClawConfig): EvolutionRecommendation[] {
  const recommendations: EvolutionRecommendation[] = [];
  const patterns = findRecurringIncidentPattern(
    memory,
    ANALYSIS_WINDOW_HOURS,
    MIN_PATTERN_OCCURRENCES,
  );

  for (const pattern of patterns) {
    switch (pattern.type) {
      case "channel_crash_loop": {
        // Frequent crash loops suggest recovery is too aggressive
        const current = resolveOagDeliveryRecoveryBudgetMs(cfg);
        const suggested = clampChange(current, Math.round(current * 1.5), cfg);
        if (suggested > current) {
          recommendations.push({
            configPath: "gateway.oag.delivery.recoveryBudgetMs",
            currentValue: current,
            suggestedValue: suggested,
            reason: `Channel ${pattern.channel ?? "unknown"} crash-looped ${pattern.occurrences} times in ${ANALYSIS_WINDOW_HOURS}h — spreading recovery over longer window`,
            risk: "low",
            source: "heuristic",
          });
        }
        break;
      }
      case "delivery_recovery_failure": {
        const current = resolveOagDeliveryMaxRetries(cfg);
        const suggested = clampChange(current, current + 2, cfg);
        if (suggested > current) {
          recommendations.push({
            configPath: "gateway.oag.delivery.maxRetries",
            currentValue: current,
            suggestedValue: suggested,
            reason: `Delivery recovery failed ${pattern.occurrences} times — increasing retry budget`,
            risk: "low",
            source: "heuristic",
          });
        }
        break;
      }
      case "stale_detection": {
        const current = resolveOagStalePollFactor(cfg);
        const suggested = clampChange(current, Math.round(current * 1.3), cfg);
        if (suggested > current) {
          recommendations.push({
            configPath: "gateway.oag.health.stalePollFactor",
            currentValue: current,
            suggestedValue: suggested,
            reason: `Stale detection triggered ${pattern.occurrences} times for ${pattern.channel ?? "unknown"} — relaxing threshold to reduce false positives`,
            risk: "low",
            source: "heuristic",
          });
        }
        break;
      }
      case "lock_contention": {
        const current = resolveOagLockStaleMs(cfg);
        const suggested = clampChange(current, Math.round(current * 1.5), cfg);
        if (suggested > current) {
          recommendations.push({
            configPath: "gateway.oag.lock.staleMs",
            currentValue: current,
            suggestedValue: suggested,
            reason: `Lock contention detected ${pattern.occurrences} times — increasing stale threshold`,
            risk: "low",
            source: "heuristic",
          });
        }
        break;
      }
    }
  }

  return recommendations;
}

function hasExceededNotificationLimit(memory: OagMemory, cfg: OpenClawConfig): boolean {
  const cutoff = Date.now() - NOTIFICATION_WINDOW_MS;
  const recentEvolutions = memory.evolutions.filter((e) => Date.parse(e.appliedAt) > cutoff);
  return recentEvolutions.length >= resolveOagEvolutionMaxNotificationsPerDay(cfg);
}

function shouldRunEvolution(memory: OagMemory, cfg: OpenClawConfig): boolean {
  if (memory.evolutions.length === 0) {
    return true;
  }
  const lastEvolution = memory.evolutions[memory.evolutions.length - 1];
  const lastAt = Date.parse(lastEvolution.appliedAt);
  return Date.now() - lastAt > resolveOagEvolutionCooldownMs(cfg);
}

function buildUserNotification(result: PostmortemResult): string | undefined {
  if (result.applied.length === 0 && result.recommendations.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (result.applied.length > 0) {
    parts.push(
      `I analyzed ${result.crashCount} recent incidents and adjusted ${result.applied.length} parameter${result.applied.length > 1 ? "s" : ""}: ${result.applied.map((r) => r.reason).join("; ")}.`,
    );
  }
  if (result.skipped.length > 0) {
    parts.push(
      `${result.skipped.length} additional recommendation${result.skipped.length > 1 ? "s" : ""} require${result.skipped.length === 1 ? "s" : ""} operator review.`,
    );
  }
  return parts.join(" ");
}

let postmortemRunning = false;

export async function runPostRecoveryAnalysis(): Promise<PostmortemResult> {
  if (postmortemRunning) {
    log.info("Post-recovery: another postmortem is already running, skipping");
    return {
      analyzed: false,
      crashCount: 0,
      patterns: 0,
      recommendations: [],
      applied: [],
      skipped: [],
    };
  }
  postmortemRunning = true;
  try {
    const memory = await loadOagMemory();
    const cfg = loadConfig();
    const recentCrashes = getRecentCrashes(memory, ANALYSIS_WINDOW_HOURS);

    const result: PostmortemResult = {
      analyzed: false,
      crashCount: recentCrashes.length,
      patterns: 0,
      recommendations: [],
      applied: [],
      skipped: [],
    };

    const minCrashes = resolveOagEvolutionMinCrashesForAnalysis(cfg);
    if (recentCrashes.length < minCrashes) {
      log.info(
        `Post-recovery: ${recentCrashes.length} recent crashes (below threshold ${minCrashes}), skipping analysis`,
      );
      return result;
    }

    if (!shouldRunEvolution(memory, cfg)) {
      log.info("Post-recovery: evolution cooldown active, skipping");
      return result;
    }

    result.analyzed = true;
    const recommendations = analyzePatterns(memory, cfg);
    result.recommendations = recommendations;
    result.patterns = findRecurringIncidentPattern(
      memory,
      ANALYSIS_WINDOW_HOURS,
      MIN_PATTERN_OCCURRENCES,
    ).length;

    if (recommendations.length === 0) {
      log.info("Post-recovery: no actionable recommendations from pattern analysis");
      // Escalate to agent diagnosis when patterns exist but heuristics produced no recommendations
      if (result.patterns > 0) {
        const patternList = findRecurringIncidentPattern(
          memory,
          ANALYSIS_WINDOW_HOURS,
          MIN_PATTERN_OCCURRENCES,
        );
        const primary = patternList[0];
        if (primary) {
          try {
            await requestDiagnosis({
              type: "recurring_pattern",
              description: `Recurring ${primary.type} pattern (${primary.occurrences} occurrences) with no heuristic recommendation`,
              patternType: primary.type,
              channel: primary.channel,
              occurrences: primary.occurrences,
            });
            log.info(
              "Escalated to agent diagnosis — heuristic analysis found patterns but no actionable recommendations",
            );
          } catch (err) {
            log.warn(`Agent diagnosis request failed: ${String(err)}`);
          }
        }
      }
      return result;
    }

    // Apply low-risk recommendations automatically
    const applied: EvolutionRecommendation[] = [];
    const skipped: EvolutionRecommendation[] = [];

    for (const rec of recommendations) {
      if (rec.risk === "low") {
        applied.push(rec);
        log.info(
          `Post-recovery evolution: ${rec.configPath} ${rec.currentValue} → ${rec.suggestedValue} (${rec.reason})`,
        );
      } else {
        skipped.push(rec);
        log.info(
          `Post-recovery recommendation (needs review): ${rec.configPath} ${rec.currentValue} → ${rec.suggestedValue} (${rec.reason})`,
        );
      }
    }

    result.applied = applied;
    result.skipped = skipped;

    if (applied.length > 0) {
      const configChanges = applied.map((r) => ({
        configPath: r.configPath,
        value: r.suggestedValue,
      }));
      await applyOagConfigChanges(configChanges);
    }

    if (applied.length > 0) {
      const evolutionChanges = applied.map((r) => ({
        configPath: r.configPath,
        from: r.currentValue,
        to: r.suggestedValue,
      }));
      await recordEvolution({
        appliedAt: new Date().toISOString(),
        source: "adaptive",
        trigger: `post-recovery analysis (${recentCrashes.length} crashes in ${ANALYSIS_WINDOW_HOURS}h)`,
        changes: evolutionChanges,
        outcome: "pending",
      });
      await appendAuditEntry({
        timestamp: new Date().toISOString(),
        action: "evolution_applied",
        detail: `Adaptive evolution: ${applied.map((r) => `${r.configPath} ${r.currentValue} -> ${r.suggestedValue}`).join(", ")}`,
        changes: evolutionChanges,
      });
      await startEvolutionObservation({
        appliedAt: new Date().toISOString(),
        rollbackChanges: applied.map((r) => ({
          configPath: r.configPath,
          previousValue: r.currentValue,
        })),
      });
    }

    result.userNotification = buildUserNotification(result);

    if (
      result.userNotification &&
      applied.length > 0 &&
      !hasExceededNotificationLimit(memory, cfg)
    ) {
      const evolutionId = `ev-${Date.now()}`;
      await injectEvolutionNote({
        message: result.userNotification,
        evolutionId,
      });
    }

    return result;
  } finally {
    postmortemRunning = false;
  }
}
