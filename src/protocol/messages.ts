/**
 * Message Protocol Module
 * Defines message types for multi-agent communication
 */

// ============================================================================
// Base Types
// ============================================================================

export type MessageType =
  | "task_assign"
  | "task_complete"
  | "task_fail"
  | "status_update"
  | "heartbeat"
  | "query"
  | "response"
  | "log"
  | "error"
  | "shutdown"
  | "spawn"
  | "sync";

export type MessagePriority = "low" | "normal" | "high" | "critical";

export interface MessageMeta {
  timestamp: string;
  source: string;
  target?: string;
  correlationId?: string;
  ttl?: number;
  priority?: MessagePriority;
}

// ============================================================================
// Message Interfaces
// ============================================================================

export interface BaseMessage {
  type: MessageType;
  meta: MessageMeta;
}

export interface TaskAssignMessage extends BaseMessage {
  type: "task_assign";
  payload: {
    taskId: string;
    taskType: string;
    instructions: string;
    inputs?: Record<string, unknown>;
    deadline?: string;
    dependencies?: string[];
  };
}

export interface TaskCompleteMessage extends BaseMessage {
  type: "task_complete";
  payload: {
    taskId: string;
    result: unknown;
    metrics?: {
      durationMs: number;
      tokensUsed?: number;
    };
  };
}

export interface TaskFailMessage extends BaseMessage {
  type: "task_fail";
  payload: {
    taskId: string;
    error: string;
    errorType?: "timeout" | "validation" | "execution" | "unknown";
    retryable?: boolean;
  };
}

export interface StatusUpdateMessage extends BaseMessage {
  type: "status_update";
  payload: {
    status: "idle" | "working" | "waiting" | "error";
    currentTask?: string;
    progress?: number;
    details?: string;
  };
}

export interface HeartbeatMessage extends BaseMessage {
  type: "heartbeat";
  payload: {
    agentId: string;
    status: "alive" | "busy" | "stalled";
    uptime: number;
    memoryUsage?: number;
  };
}

export interface QueryMessage extends BaseMessage {
  type: "query";
  payload: {
    queryType: "status" | "result" | "capability";
    targetTask?: string;
  };
}

export interface ResponseMessage extends BaseMessage {
  type: "response";
  payload: {
    success: boolean;
    data?: unknown;
    error?: string;
  };
}

export interface LogMessage extends BaseMessage {
  type: "log";
  payload: {
    level: "debug" | "info" | "warn" | "error";
    message: string;
    context?: Record<string, unknown>;
  };
}

export interface ErrorMessage extends BaseMessage {
  type: "error";
  payload: {
    code: string;
    message: string;
    recoverable: boolean;
    context?: Record<string, unknown>;
  };
}

export interface ShutdownMessage extends BaseMessage {
  type: "shutdown";
  payload: {
    reason: "completed" | "timeout" | "error" | "manual";
    graceful: boolean;
    timeout?: number;
  };
}

export interface SpawnMessage extends BaseMessage {
  type: "spawn";
  payload: {
    agentType: string;
    agentId: string;
    config?: Record<string, unknown>;
  };
}

export interface SyncMessage extends BaseMessage {
  type: "sync";
  payload: {
    syncType: "state" | "result" | "config";
    data: unknown;
  };
}

// ============================================================================
// Union Types
// ============================================================================

export type Message =
  | TaskAssignMessage
  | TaskCompleteMessage
  | TaskFailMessage
  | StatusUpdateMessage
  | HeartbeatMessage
  | QueryMessage
  | ResponseMessage
  | LogMessage
  | ErrorMessage
  | ShutdownMessage
  | SpawnMessage
  | SyncMessage;

// ============================================================================
// Factory Functions
// ============================================================================

export function createMessage<T extends MessageType>(
  type: T,
  source: string,
  payload: Extract<Message, { type: T }>["payload"],
  options?: Partial<MessageMeta>,
): Extract<Message, { type: T }> {
  return {
    type,
    meta: {
      timestamp: new Date().toISOString(),
      source,
      priority: "normal",
      ...options,
    },
    payload,
  } as Extract<Message, { type: T }>;
}

export function taskAssign(
  source: string,
  payload: TaskAssignMessage["payload"],
): TaskAssignMessage {
  return createMessage("task_assign", source, payload);
}

export function taskComplete(
  source: string,
  payload: TaskCompleteMessage["payload"],
): TaskCompleteMessage {
  return createMessage("task_complete", source, payload);
}

export function taskFail(source: string, payload: TaskFailMessage["payload"]): TaskFailMessage {
  return createMessage("task_fail", source, payload);
}

export function statusUpdate(
  source: string,
  payload: StatusUpdateMessage["payload"],
): StatusUpdateMessage {
  return createMessage("status_update", source, payload);
}

export function heartbeat(source: string, payload: HeartbeatMessage["payload"]): HeartbeatMessage {
  return createMessage("heartbeat", source, payload);
}

export function query(source: string, payload: QueryMessage["payload"]): QueryMessage {
  return createMessage("query", source, payload);
}

export function response(source: string, payload: ResponseMessage["payload"]): ResponseMessage {
  return createMessage("response", source, payload);
}

export function log(source: string, payload: LogMessage["payload"]): LogMessage {
  return createMessage("log", source, payload);
}

export function error(source: string, payload: ErrorMessage["payload"]): ErrorMessage {
  return createMessage("error", source, payload, { priority: "high" });
}

export function shutdown(source: string, payload: ShutdownMessage["payload"]): ShutdownMessage {
  return createMessage("shutdown", source, payload, { priority: "critical" });
}

export function spawn(source: string, payload: SpawnMessage["payload"]): SpawnMessage {
  return createMessage("spawn", source, payload);
}

export function sync(source: string, payload: SyncMessage["payload"]): SyncMessage {
  return createMessage("sync", source, payload);
}

// ============================================================================
// Utilities
// ============================================================================

export function isMessage(obj: unknown): obj is Message {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }
  const msg = obj as Partial<Message>;
  return typeof msg.type === "string" && typeof msg.meta === "object";
}

export function getMessagePriority(msg: Message): MessagePriority {
  return msg.meta.priority ?? "normal";
}

export function isExpired(msg: Message): boolean {
  if (!msg.meta.ttl) {
    return false;
  }
  const age = Date.now() - new Date(msg.meta.timestamp).getTime();
  return age > msg.meta.ttl;
}

export default Message;
