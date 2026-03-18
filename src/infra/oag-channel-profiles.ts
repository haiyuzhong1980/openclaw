// Transport types that determine OAG behavior
export type ChannelTransport = "websocket" | "polling" | "webhook" | "local";

// Transport-specific OAG defaults
export type TransportProfile = {
  transport: ChannelTransport;
  staleThresholdMs: number; // how long before "stale" detection
  recoveryBudgetMs: number; // time budget for delivery recovery
  maxRetries: number; // delivery retry attempts
  stalePollFactor: number; // multiplier for polling channels (1.0 for non-polling)
  restartBackoffInitialMs: number;
  restartBackoffMaxMs: number;
};

// Registry: channelId -> transport type
const CHANNEL_TRANSPORT_MAP: Record<string, ChannelTransport> = {
  // WebSocket channels
  discord: "websocket",
  slack: "websocket",
  whatsapp: "websocket",
  mattermost: "websocket",
  irc: "websocket",

  // Polling channels
  telegram: "polling",
  matrix: "polling",
  zalo: "polling",
  zalouser: "polling",
  "nextcloud-talk": "polling",
  tlon: "polling",
  nostr: "polling", // relay-based but uses polling pattern

  // Webhook channels (passive receivers)
  line: "webhook",
  googlechat: "webhook",
  msteams: "webhook",
  "synology-chat": "webhook",

  // Local process channels
  imessage: "local",
  bluebubbles: "local",
  signal: "local", // local daemon
};

// Transport-specific defaults
const TRANSPORT_PROFILES: Record<ChannelTransport, TransportProfile> = {
  websocket: {
    transport: "websocket",
    staleThresholdMs: 30 * 60_000, // 30min -- WebSocket should have heartbeats
    recoveryBudgetMs: 30_000, // 30s -- fast reconnect
    maxRetries: 5,
    stalePollFactor: 1, // not applicable
    restartBackoffInitialMs: 5_000,
    restartBackoffMaxMs: 5 * 60_000,
  },
  polling: {
    transport: "polling",
    staleThresholdMs: 30 * 60_000, // base 30min, multiplied by stalePollFactor
    recoveryBudgetMs: 90_000, // 90s -- polling is slower to recover
    maxRetries: 8, // more retries (polling is flakier)
    stalePollFactor: 2, // effective threshold: 60min
    restartBackoffInitialMs: 10_000, // slower initial backoff
    restartBackoffMaxMs: 10 * 60_000,
  },
  webhook: {
    transport: "webhook",
    staleThresholdMs: 0, // no stale detection (passive)
    recoveryBudgetMs: 60_000, // standard
    maxRetries: 5,
    stalePollFactor: 1,
    restartBackoffInitialMs: 5_000,
    restartBackoffMaxMs: 5 * 60_000,
  },
  local: {
    transport: "local",
    staleThresholdMs: 30 * 60_000,
    recoveryBudgetMs: 15_000, // 15s -- local process restarts fast
    maxRetries: 3, // fewer retries (if daemon is dead, retrying won't help)
    stalePollFactor: 2,
    restartBackoffInitialMs: 3_000,
    restartBackoffMaxMs: 2 * 60_000,
  },
};

export function resolveChannelTransport(channelId: string): ChannelTransport {
  return CHANNEL_TRANSPORT_MAP[channelId] ?? "websocket"; // default to websocket (safest)
}

export function getTransportProfile(channelId: string): TransportProfile {
  const transport = resolveChannelTransport(channelId);
  return TRANSPORT_PROFILES[transport];
}

// For extensions to register their transport type at runtime
export function registerChannelTransport(channelId: string, transport: ChannelTransport): void {
  CHANNEL_TRANSPORT_MAP[channelId] = transport;
}

export function isPollingChannel(channelId: string): boolean {
  const transport = resolveChannelTransport(channelId);
  return transport === "polling" || transport === "local";
}

export function isPassiveChannel(channelId: string): boolean {
  return resolveChannelTransport(channelId) === "webhook";
}

// ---------------------------------------------------------------------------
// Channel-specific anomaly detection baselines
// Different channels have different "normal" error profiles. These baselines
// let OAG distinguish expected noise from real anomalies.
// ---------------------------------------------------------------------------

/** Per-incident-type baseline: expected count per hour and acceptable variance. */
export type Baseline = {
  /** Expected incidents per hour under normal operation. */
  expectedPerHour: number;
  /** Standard deviation -- used to compute dynamic thresholds. */
  stddev: number;
  /** Human-readable note explaining why this baseline exists. */
  note: string;
};

// Z-score thresholds: noisier channels tolerate higher scores before alerting.
const CHANNEL_ANOMALY_THRESHOLDS: Record<string, number> = {
  discord: 2.5, // rate limit bursts are common
  slack: 2.5, // WebSocket 408 reconnects are frequent
  signal: 2.0, // low-traffic daemon; raised from 1.5 to reduce false positives
};

const DEFAULT_ANOMALY_THRESHOLD = 2.0;

/**
 * Returns the Z-score threshold above which an incident rate is considered
 * anomalous for the given channel. Higher = more tolerant of noise.
 */
export function getChannelAnomalyThreshold(channel: string): number {
  return CHANNEL_ANOMALY_THRESHOLDS[channel] ?? DEFAULT_ANOMALY_THRESHOLD;
}

// Channel-specific factory baselines keyed by incident type.
const CHANNEL_BASELINES: Record<string, Record<string, Baseline>> = {
  discord: {
    rate_limit: {
      expectedPerHour: 12,
      stddev: 5,
      note: "Discord rate limits fire frequently under normal bot traffic",
    },
    auth_resource: {
      expectedPerHour: 0.1,
      stddev: 0.2,
      note: "Code 4014 (disallowed intents) -- rare, flag quickly",
    },
  },
  telegram: {
    poll_stall: {
      expectedPerHour: 2,
      stddev: 1.5,
      note: "Long-poll stalls are channel-specific and expected periodically",
    },
    network_timeout: {
      expectedPerHour: 4,
      stddev: 2,
      note: "Telegram API timeouts higher than other channels",
    },
  },
  signal: {
    general: {
      expectedPerHour: 0.5,
      stddev: 0.3,
      note: "Low traffic daemon -- any incident is more significant",
    },
  },
  slack: {
    websocket_408: {
      expectedPerHour: 6,
      stddev: 3,
      note: "WebSocket 408 timeout/reconnect is a common Slack pattern",
    },
    reconnect: {
      expectedPerHour: 3,
      stddev: 2,
      note: "Slack reconnects are frequent; higher baseline than other WS channels",
    },
  },
  whatsapp: {
    auth_pairing: {
      expectedPerHour: 2,
      stddev: 1,
      note: "Session rotation is normal for WhatsApp Web multi-device pairing",
    },
  },
  web: {
    auth_pairing: {
      expectedPerHour: 2,
      stddev: 1,
      note: "Session rotation is normal for WhatsApp Web multi-device pairing",
    },
  },
};

/**
 * Returns channel-specific factory baselines keyed by incident type,
 * or undefined for channels without pre-defined baselines.
 */
export function getChannelBaselines(channel: string): Record<string, Baseline> | undefined {
  const baselines = CHANNEL_BASELINES[channel];
  if (!baselines) {
    return undefined;
  }
  return { ...baselines };
}
