/**
 * Board API Module
 * REST API endpoints for monitoring
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// Re-export types
export interface AgentStatus {
  id: string;
  status: "idle" | "working" | "error";
  currentTask?: string;
  lastActivity: string;
  tokensUsed: number;
  cost: number;
}

export interface TaskStatus {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  agentId?: string;
  startTime?: string;
  endTime?: string;
  result?: unknown;
}

// In-memory storage
const agentStatuses = new Map<string, AgentStatus>();
const taskStatuses = new Map<string, TaskStatus>();

// API handlers
export async function handleApiRequest(
  url: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.setHeader("Content-Type", "application/json");

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") {
    res.end();
    return;
  }

  // GET /api/status - Overall status
  if (url === "/api/status" && method === "GET") {
    res.end(
      JSON.stringify({
        agents: Object.fromEntries(agentStatuses),
        tasks: Object.fromEntries(taskStatuses),
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }

  // GET /api/agents - List all agents
  if (url === "/api/agents" && method === "GET") {
    res.end(JSON.stringify(Array.from(agentStatuses.values())));
    return;
  }

  // GET /api/tasks - List all tasks
  if (url === "/api/tasks" && method === "GET") {
    res.end(JSON.stringify(Array.from(taskStatuses.values())));
    return;
  }

  // POST /api/agents/:id/status - Update agent status
  const agentMatch = url.match(/^\/api\/agents\/([^/]+)\/status$/);
  if (agentMatch && method === "POST") {
    const agentId = agentMatch[1];
    const body = await readBody(req);

    try {
      const data = JSON.parse(body);
      agentStatuses.set(agentId, {
        id: agentId,
        status: data.status ?? "idle",
        currentTask: data.currentTask,
        lastActivity: new Date().toISOString(),
        tokensUsed: data.tokensUsed ?? 0,
        cost: data.cost ?? 0,
      });
      res.end(JSON.stringify({ success: true, agentId }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
    return;
  }

  // POST /api/tasks/:id/status - Update task status
  const taskMatch = url.match(/^\/api\/tasks\/([^/]+)\/status$/);
  if (taskMatch && method === "POST") {
    const taskId = taskMatch[1];
    const body = await readBody(req);

    try {
      const data = JSON.parse(body);
      const existing = taskStatuses.get(taskId);
      taskStatuses.set(taskId, {
        ...existing,
        id: taskId,
        status: data.status ?? existing?.status ?? "pending",
        agentId: data.agentId ?? existing?.agentId,
        startTime: data.startTime ?? existing?.startTime,
        endTime: data.endTime ?? existing?.endTime,
        result: data.result ?? existing?.result,
      });
      res.end(JSON.stringify({ success: true, taskId }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
    return;
  }

  // DELETE /api/agents/:id - Remove agent
  const agentDeleteMatch = url.match(/^\/api\/agents\/([^/]+)$/);
  if (agentDeleteMatch && method === "DELETE") {
    const agentId = agentDeleteMatch[1];
    agentStatuses.delete(agentId);
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // DELETE /api/tasks/:id - Remove task
  const taskDeleteMatch = url.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskDeleteMatch && method === "DELETE") {
    const taskId = taskDeleteMatch[1];
    taskStatuses.delete(taskId);
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // 404 for unknown endpoints
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "API endpoint not found" }));
}

// Helper to read request body
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

// Export storage for external access
export { agentStatuses, taskStatuses };
