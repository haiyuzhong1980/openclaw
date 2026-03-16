export type OagConfig = {
  delivery?: {
    maxRetries?: number;
    recoveryBudgetMs?: number;
  };
  lock?: {
    timeoutMs?: number;
    staleMs?: number;
  };
  health?: {
    stalePollFactor?: number;
  };
  notes?: {
    dedupWindowMs?: number;
    maxDeliveredHistory?: number;
  };
};
