import type { ChannelId } from "../channels/plugins/types.js";

export type SessionStatus = {
  agentId?: string;
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  sessionId?: string;
  updatedAt: number | null;
  age: number | null;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens: number | null;
  totalTokensFresh: boolean;
  cacheRead?: number;
  cacheWrite?: number;
  remainingTokens: number | null;
  percentUsed: number | null;
  model: string | null;
  contextTokens: number | null;
  flags: string[];
};

export type HeartbeatStatus = {
  agentId: string;
  enabled: boolean;
  every: string;
  everyMs: number | null;
};

export type OagMetricsSummary = {
  channelRestarts: number;
  deliveryRecoveries: number;
  deliveryRecoveryFailures: number;
  activeIncidents: number;
  lastEvolution?: {
    appliedAt: string;
    outcome?: string;
    changeSummary?: string;
  };
};

export type StatusSummary = {
  runtimeVersion?: string | null;
  oagMetrics?: OagMetricsSummary;
  oagChannelHealth?: {
    congested: boolean;
    backloggedAfterRecovery?: boolean;
    affectedChannels: string[];
    affectedTargets?: Array<{
      channel: string;
      accountId?: string;
      sessionKeys: string[];
      pendingDeliveries?: number;
      recentFailures?: number;
    }>;
    pendingDeliveries: number;
    recentFailureCount: number;
    backlogAgeMinutes?: number;
    escalationRecommended?: boolean;
    recommendedAction?: string;
    verifyAttempts?: number;
    lastAction?: string;
    lastActionAt?: string;
    lastActionDetail?: string;
    lastVerifyAt?: string;
    lastRestartAt?: string;
    lastFailureAt?: string;
    lastRecoveredAt?: string;
    updatedAt?: string;
    sessionWatch?: {
      active: boolean;
      affectedChannels: string[];
      stateCounts?: Record<string, number>;
      escalationRecommended?: boolean;
      recommendedAction?: string;
      affectedSessions?: Array<{
        agentId?: string;
        sessionKey: string;
        sessionId?: string;
        channel?: string;
        accountId?: string;
        state?: string;
        reason?: string;
        silentMinutes?: number;
        blockedRetryCount?: number;
        escalationRecommended?: boolean;
        recommendedAction?: string;
      }>;
      lastAction?: string;
      lastActionAt?: string;
      lastActionDetail?: string;
      lastNudgeAt?: string;
      updatedAt?: string;
    };
    taskWatch?: {
      active: boolean;
      counts?: Record<string, number>;
      escalationRecommended?: boolean;
      recommendedAction?: string;
      affectedTasks?: Array<{
        taskId: string;
        followupType?: string;
        priority?: string;
        escalationCount?: number;
        currentStep?: number;
        totalSteps?: number;
        stepTitle?: string;
        progressAgeSeconds?: number;
        terminalStepStuck?: boolean;
        deferredBy?: string;
        notBefore?: string;
        message?: string;
      }>;
      updatedAt?: string;
    };
  };
  linkChannel?: {
    id: ChannelId;
    label: string;
    linked: boolean;
    authAgeMs: number | null;
  };
  heartbeat: {
    defaultAgentId: string;
    agents: HeartbeatStatus[];
  };
  channelSummary: string[];
  queuedSystemEvents: string[];
  sessions: {
    paths: string[];
    count: number;
    defaults: { model: string | null; contextTokens: number | null };
    recent: SessionStatus[];
    byAgent: Array<{
      agentId: string;
      path: string;
      count: number;
      recent: SessionStatus[];
    }>;
  };
};
