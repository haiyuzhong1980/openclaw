/**
 * Agent Monitor Module
 * Heartbeat and health monitoring
 */

import { EventEmitter } from "node:events";

// ============================================================================
// Types
// ============================================================================

export interface AgentHealth {
  agentId: string;
  status: "alive" | "busy" | "stalled" | "dead";
  lastHeartbeat: string;
  consecutiveMisses: number;
  metrics: {
    uptime: number;
    tasksCompleted: number;
    tasksFailed: number;
    avgResponseTime: number;
  };
}

export interface MonitorConfig {
  heartbeatInterval?: number; // ms
  timeoutThreshold?: number; // ms
  maxMisses?: number;
}

// ============================================================================
// AgentMonitor Implementation
// ============================================================================

export class AgentMonitor extends EventEmitter {
  private agents: Map<string, AgentHealth>;
  private heartbeatInterval: number;
  private timeoutThreshold: number;
  private maxMisses: number;
  private checkTimer?: ReturnType<typeof setInterval>;

  constructor(config: MonitorConfig = {}) {
    super();
    this.agents = new Map();
    this.heartbeatInterval = config.heartbeatInterval ?? 30000; // 30s
    this.timeoutThreshold = config.timeoutThreshold ?? 300000; // 5 min
    this.maxMisses = config.maxMisses ?? 3;
  }

  // --------------------------------------------------------------------------
  // Agent Management
  // --------------------------------------------------------------------------

  register(agentId: string): void {
    this.agents.set(agentId, {
      agentId,
      status: "alive",
      lastHeartbeat: new Date().toISOString(),
      consecutiveMisses: 0,
      metrics: {
        uptime: 0,
        tasksCompleted: 0,
        tasksFailed: 0,
        avgResponseTime: 0,
      },
    });

    this.emit("agent:registered", { agentId });
  }

  unregister(agentId: string): boolean {
    const removed = this.agents.delete(agentId);
    if (removed) {
      this.emit("agent:unregistered", { agentId });
    }
    return removed;
  }

  // --------------------------------------------------------------------------
  // Heartbeat
  // --------------------------------------------------------------------------

  heartbeat(agentId: string, metadata?: { status?: "alive" | "busy"; task?: string }): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    agent.lastHeartbeat = new Date().toISOString();
    agent.consecutiveMisses = 0;
    agent.status = metadata?.status ?? "alive";

    this.emit("heartbeat", { agentId, status: agent.status });
    return true;
  }

  // --------------------------------------------------------------------------
  // Health Checks
  // --------------------------------------------------------------------------

  startMonitoring(): void {
    if (this.checkTimer) return;

    this.checkTimer = setInterval(() => {
      this.checkAgents();
    }, this.heartbeatInterval);
  }

  stopMonitoring(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
  }

  private checkAgents(): void {
    const now = Date.now();

    for (const [agentId, health] of this.agents) {
      const lastHeartbeat = new Date(health.lastHeartbeat).getTime();
      const elapsed = now - lastHeartbeat;

      if (elapsed > this.timeoutThreshold) {
        health.consecutiveMisses++;

        if (health.consecutiveMisses >= this.maxMisses) {
          health.status = "dead";
          this.emit("agent:dead", { agentId, health });
        } else {
          health.status = "stalled";
          this.emit("agent:stalled", { agentId, health });
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Metrics
  // --------------------------------------------------------------------------

  recordTaskComplete(agentId: string, responseTime: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.metrics.tasksCompleted++;
    agent.metrics.avgResponseTime =
      (agent.metrics.avgResponseTime * (agent.metrics.tasksCompleted - 1) + responseTime) /
      agent.metrics.tasksCompleted;
  }

  recordTaskFail(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.metrics.tasksFailed++;
  }

  // --------------------------------------------------------------------------
  // Query
  // --------------------------------------------------------------------------

  getHealth(agentId: string): AgentHealth | undefined {
    return this.agents.get(agentId);
  }

  getAllHealth(): AgentHealth[] {
    return Array.from(this.agents.values());
  }

  getAlive(): string[] {
    return Array.from(this.agents.values())
      .filter((h) => h.status === "alive" || h.status === "busy")
      .map((h) => h.agentId);
  }

  getDead(): string[] {
    return Array.from(this.agents.values())
      .filter((h) => h.status === "dead")
      .map((h) => h.agentId);
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  cleanup(): void {
    this.stopMonitoring();
    this.agents.clear();
  }
}

export default AgentMonitor;
