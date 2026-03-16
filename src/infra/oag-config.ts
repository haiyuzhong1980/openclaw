import type { OpenClawConfig } from "../config/config.js";
import type { OagConfig } from "../config/types.oag.js";

const DEFAULTS = {
  delivery: {
    maxRetries: 5,
    recoveryBudgetMs: 60_000,
  },
  lock: {
    timeoutMs: 2_000,
    staleMs: 30_000,
  },
  health: {
    stalePollFactor: 2,
  },
  notes: {
    dedupWindowMs: 60_000,
    maxDeliveredHistory: 20,
  },
} as const;

function resolveOagSection(cfg?: OpenClawConfig): OagConfig | undefined {
  return cfg?.gateway?.oag;
}

export function resolveOagDeliveryMaxRetries(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.delivery?.maxRetries;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.delivery.maxRetries;
}

export function resolveOagDeliveryRecoveryBudgetMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.delivery?.recoveryBudgetMs;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.delivery.recoveryBudgetMs;
}

export function resolveOagLockTimeoutMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.lock?.timeoutMs;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.lock.timeoutMs;
}

export function resolveOagLockStaleMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.lock?.staleMs;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.lock.staleMs;
}

export function resolveOagStalePollFactor(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.health?.stalePollFactor;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.health.stalePollFactor;
}

export function resolveOagNoteDedupWindowMs(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.notes?.dedupWindowMs;
  return typeof v === "number" && v >= 0 ? v : DEFAULTS.notes.dedupWindowMs;
}

export function resolveOagMaxDeliveredNotes(cfg?: OpenClawConfig): number {
  const v = resolveOagSection(cfg)?.notes?.maxDeliveredHistory;
  return typeof v === "number" && v > 0 ? v : DEFAULTS.notes.maxDeliveredHistory;
}
