export type CrashRootCause =
  | "rate_limit"
  | "auth_token_invalid"
  | "auth_blocked"
  | "auth_pairing"
  | "auth_resource"
  | "network_dns"
  | "network_timeout"
  | "network_tls"
  | "network_refused"
  | "network_poll_stall"
  | "network_watchdog"
  | "llm_timeout"
  | "config_missing_module"
  | "config_invalid_json"
  | "config_unknown_model"
  | "config_sdk_mismatch"
  | "lifecycle_drain"
  | "lifecycle_launchctl"
  | "lifecycle_stale_pid"
  | "lifecycle_port_conflict"
  | "agent_missing_context"
  | "agent_file_hallucination"
  | "agent_command_missing"
  | "agent_browser"
  | "resource_oom"
  | "resource_swap"
  | "internal_segfault"
  | "internal_bug"
  | "unknown";

export type RootCauseResult = {
  cause: CrashRootCause;
  confidence: number; // 0-1
  category:
    | "rate_limit"
    | "auth_failure"
    | "network"
    | "config"
    | "lifecycle"
    | "agent"
    | "resource_exhaustion"
    | "internal"
    | "unknown";
  shouldRetry: boolean;
  shouldNotifyOperator: boolean;
  shouldAdjustConfig: boolean;
};

// Build patterns from REAL log data (38 error patterns found in 10 days of production logs):
const ROOT_CAUSE_PATTERNS: Array<[RegExp, CrashRootCause, number]> = [
  // Rate limiting (2,456 real events)
  [/API rate limit|rate.?limit reached|too many req/i, "rate_limit", 0.95],
  [/\b429\b|HTTP 429|status[:\s]+429|429.*Too Many/i, "rate_limit", 0.85],
  [/lane wait exceeded|waitedMs/i, "rate_limit", 0.7],

  // Auth failure (2,244 real events)
  [/401.*Unauthorized|failed.*401|401.*failed/i, "auth_token_invalid", 0.95],
  [/身份验证失败|authentication failed/i, "auth_token_invalid", 0.9],
  [
    /403.*Forbidden|IP.*blocked|account.*blocked|account.*banned|permanently banned/i,
    "auth_blocked",
    0.9,
  ],
  [/pairing required|code=1008/i, "auth_pairing", 0.95],
  [/resource not granted|close.*code.*3001|code=3001|error.*3001/i, "auth_resource", 0.85],
  [/Message Content Intent|privileged.*intent/i, "auth_resource", 0.8],
  [/token.*expired|token.*invalid/i, "auth_token_invalid", 0.9],

  // Lifecycle-specific ETIMEDOUT patterns must precede the generic network ETIMEDOUT pattern
  // so that "spawnSync launchctl ETIMEDOUT" routes to lifecycle, not network_timeout.
  [/spawnSync launchctl ETIMEDOUT/i, "lifecycle_launchctl", 0.95],

  // LLM-specific timeout must precede the generic timeout pattern
  [/LLM request timed out/i, "llm_timeout", 0.9],

  // Network (3,300+ real events)
  [/autoSelectFamily.*false.*ipv4first/i, "network_dns", 0.8],
  [/ENOTFOUND|getaddrinfo.*failed/i, "network_dns", 0.95],
  // Port-specific ECONNREFUSED must precede generic so Redis/Postgres get higher confidence
  [/ECONNREFUSED.*(6379|5432)/i, "network_refused", 0.97],
  [/ECONNREFUSED|connection refused/i, "network_refused", 0.95],
  [/ETIMEDOUT|timed? ?out|timeout after \d+ms/i, "network_timeout", 0.85],
  [/TLS.*handshake|secure.*connection/i, "network_tls", 0.9],
  [/Polling stall.*no getUpdates/i, "network_poll_stall", 0.9],
  [/reconnect watchdog timeout/i, "network_watchdog", 0.95],
  [/socket hang up|ECONNRESET/i, "network_timeout", 0.8],
  [/fetch failed|network.*error/i, "network_timeout", 0.7],

  // Config (542 real events)
  [/Cannot find module/i, "config_missing_module", 0.95],
  [/JSON5? parse failed|invalid.*config.*json/i, "config_invalid_json", 0.95],
  [/Unknown model|unknown.*model/i, "config_unknown_model", 0.9],
  [/missing.*migration|migration.*missing|migration.*failed/i, "config_invalid_json", 0.6],
  [/is not a function|SDK.*mismatch/i, "config_sdk_mismatch", 0.85],

  // Lifecycle (32 real events, highest impact)
  [/another.*instance.*already.*listening|already listening on/i, "lifecycle_port_conflict", 0.85],
  [/GatewayDrainingError|draining for restart/i, "lifecycle_drain", 0.95],
  [/worker terminated|process (exited|crashed|terminated) unexpectedly/i, "lifecycle_drain", 0.5],
  [/kill-failed.*pid.*not found/i, "lifecycle_stale_pid", 0.9],
  [/address already in use|EADDRINUSE|Errno 48/i, "lifecycle_port_conflict", 0.95],

  // Agent tool misuse (430 real events)
  [/guildId required/i, "agent_missing_context", 0.95],
  [/ENOENT.*no such file/i, "agent_file_hallucination", 0.85],
  [/command not found/i, "agent_command_missing", 0.9],
  [/tab not found|Chrome CDP|Failed to start Chrome/i, "agent_browser", 0.9],

  // Resource exhaustion (from GitHub issues #47430, #45440, #41778, #35773, #45160, #44790)
  [/Out of memory|OOM|ENOMEM|heap out of memory/i, "resource_oom", 0.95],
  [/Killed process.*total-vm|oom.?killer/i, "resource_oom", 0.9],
  [/swap exhaustion|orphaned.*process/i, "resource_swap", 0.85],

  // Discord close code 4014 — privileged intents not granted (from #21099)
  [/Fatal Gateway error: 4014|close.*code.*4014/i, "auth_resource", 0.9],

  // WebSocket 408 / unexpected server response (from #45852, #43689)
  [/Unexpected server response: 408|WebSocket.*408/i, "network_timeout", 0.85],

  // Config validation errors (from #29745, #40265)
  [/Config invalid|Unrecognized key|config.*validation.*error/i, "config_invalid_json", 0.9],

  // Stale lock / lock contention (from #49037)
  [/stale lock|lock contention|lock file exists/i, "lifecycle_stale_pid", 0.85],

  // Signal crashes: SIGILL / segfault (from #38260)
  [/SIGILL|segfault|invalid opcode|SIGSEGV/i, "internal_segfault", 0.95],

  // Internal bugs
  [/TypeError|ReferenceError|SyntaxError/i, "internal_bug", 0.7],
  [/Cannot read propert(y|ies) of (null|undefined)/i, "internal_bug", 0.65],
  [/KeyError|AttributeError/i, "internal_bug", 0.8],
  [/Unhandled.*rejection/i, "internal_bug", 0.75],
  [/write after end/i, "internal_bug", 0.8],
];

const CATEGORY_MAP: Record<string, RootCauseResult["category"]> = {
  rate_limit: "rate_limit",
  auth_token_invalid: "auth_failure",
  auth_blocked: "auth_failure",
  auth_pairing: "auth_failure",
  auth_resource: "auth_failure",
  network_dns: "network",
  network_timeout: "network",
  network_tls: "network",
  network_refused: "network",
  network_poll_stall: "network",
  network_watchdog: "network",
  llm_timeout: "network",
  config_missing_module: "config",
  config_invalid_json: "config",
  config_unknown_model: "config",
  config_sdk_mismatch: "config",
  lifecycle_drain: "lifecycle",
  lifecycle_launchctl: "lifecycle",
  lifecycle_stale_pid: "lifecycle",
  lifecycle_port_conflict: "lifecycle",
  agent_missing_context: "agent",
  agent_file_hallucination: "agent",
  agent_command_missing: "agent",
  agent_browser: "agent",
  resource_oom: "resource_exhaustion",
  resource_swap: "resource_exhaustion",
  internal_segfault: "internal",
  internal_bug: "internal",
  unknown: "unknown",
};

// Strategy per cause
const STRATEGY: Record<
  RootCauseResult["category"],
  Pick<RootCauseResult, "shouldRetry" | "shouldNotifyOperator" | "shouldAdjustConfig">
> = {
  rate_limit: { shouldRetry: true, shouldNotifyOperator: false, shouldAdjustConfig: true },
  auth_failure: { shouldRetry: false, shouldNotifyOperator: true, shouldAdjustConfig: false },
  network: { shouldRetry: true, shouldNotifyOperator: false, shouldAdjustConfig: true },
  config: { shouldRetry: false, shouldNotifyOperator: true, shouldAdjustConfig: false },
  lifecycle: { shouldRetry: false, shouldNotifyOperator: true, shouldAdjustConfig: false },
  agent: { shouldRetry: false, shouldNotifyOperator: false, shouldAdjustConfig: false },
  resource_exhaustion: { shouldRetry: false, shouldNotifyOperator: true, shouldAdjustConfig: true },
  internal: { shouldRetry: false, shouldNotifyOperator: true, shouldAdjustConfig: false },
  unknown: { shouldRetry: true, shouldNotifyOperator: false, shouldAdjustConfig: true },
};

export function classifyRootCause(lastError: string | undefined | null): RootCauseResult {
  if (!lastError) {
    return { cause: "unknown", confidence: 0, category: "unknown", ...STRATEGY.unknown };
  }
  for (const [pattern, cause, confidence] of ROOT_CAUSE_PATTERNS) {
    if (pattern.test(lastError)) {
      const category = CATEGORY_MAP[cause] ?? "unknown";
      return { cause, confidence, category, ...STRATEGY[category] };
    }
  }
  return { cause: "unknown", confidence: 0, category: "unknown", ...STRATEGY.unknown };
}
