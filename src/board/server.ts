/**
 * Board HTTP Server Module
 * Lightweight web monitoring dashboard
 */

import { readFileSync, existsSync } from "node:fs";
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Types
// ============================================================================

export interface BoardConfig {
  port?: number;
  host?: string;
  refreshInterval?: number;
}

export interface BoardServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getAddress(): string;
}

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

// ============================================================================
// Implementation
// ============================================================================

export function createBoardServer(config: BoardConfig = {}): BoardServer {
  const port = config.port ?? 3984;
  const host = config.host ?? "127.0.0.1";
  const refreshInterval = config.refreshInterval ?? 5000;

  let server: http.Server | null = null;
  let agentStatuses: Map<string, AgentStatus> = new Map();
  let taskStatuses: Map<string, TaskStatus> = new Map();

  const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };

  function getMimeType(path: string): string {
    const ext = path.slice(path.lastIndexOf("."));
    return mimeTypes[ext] ?? "application/octet-stream";
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // API endpoints
    if (url.startsWith("/api/")) {
      await handleApiRequest(url, method, req, res);
      return;
    }

    // Static files
    if (url === "/" || url === "/index.html") {
      serveStatic("/index.html", res);
      return;
    }

    // Try to serve static file
    if (["/app.js", "/style.css"].includes(url)) {
      serveStatic(url, res);
      return;
    }

    // 404
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Not found" }));
  }

  async function handleApiRequest(
    url: string,
    method: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    res.setHeader("Content-Type", "application/json");

    // GET /api/status
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

    // GET /api/agents
    if (url === "/api/agents" && method === "GET") {
      res.end(JSON.stringify(Array.from(agentStatuses.values())));
      return;
    }

    // GET /api/tasks
    if (url === "/api/tasks" && method === "GET") {
      res.end(JSON.stringify(Array.from(taskStatuses.values())));
      return;
    }

    // POST /api/agents/:id/status
    const agentMatch = url.match(/^\/api\/agents\/([^/]+)\/status$/);
    if (agentMatch && method === "POST") {
      const agentId = agentMatch[1];
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
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
        res.end(JSON.stringify({ success: true }));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
      return;
    }

    // POST /api/tasks/:id/status
    const taskMatch = url.match(/^\/api\/tasks\/([^/]+)\/status$/);
    if (taskMatch && method === "POST") {
      const taskId = taskMatch[1];
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      try {
        const data = JSON.parse(body);
        const existing = taskStatuses.get(taskId);
        taskStatuses.set(taskId, {
          ...existing,
          id: taskId,
          status: data.status ?? "pending",
          agentId: data.agentId ?? existing?.agentId,
          startTime: data.startTime ?? existing?.startTime,
          endTime: data.endTime ?? existing?.endTime,
          result: data.result ?? existing?.result,
        });
        res.end(JSON.stringify({ success: true }));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "API endpoint not found" }));
  }

  function serveStatic(url: string, res: ServerResponse): void {
    const filePath = join(__dirname, "static", url === "/" ? "index.html" : url);

    if (!existsSync(filePath)) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end("File not found");
      return;
    }

    try {
      const content = readFileSync(filePath);
      res.setHeader("Content-Type", getMimeType(url));
      res.end(content);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.end("Internal server error");
    }
  }

  return {
    async start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = http.createServer(handleRequest);
        server.listen(port, host, () => {
          console.log(`Board server running at http://${host}:${port}`);
          resolve();
        });
        server.on("error", reject);
      });
    },

    async stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    getAddress(): string {
      return `http://${host}:${port}`;
    },
  };
}

export default createBoardServer;
