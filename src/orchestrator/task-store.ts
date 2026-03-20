/**
 * Task Store Module
 * Persistent task management with file locking
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface Task {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  assignedTo?: string;
  lockedBy?: string;
  lockedAt?: string;
  priority: number;
  retries: number;
  maxRetries: number;
  payload: Record<string, unknown>;
  result?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskFilter {
  status?: Task["status"];
  createdBy?: string;
  assignedTo?: string;
  priorityMin?: number;
  priorityMax?: number;
  createdAfter?: string;
  createdBefore?: string;
}

export interface TaskStoreOptions {
  rootDir?: string;
  lockTimeoutMs?: number;
  maxConcurrentLocks?: number;
}

// ============================================================================
// TaskStore Implementation
// ============================================================================

export class TaskStore {
  private rootDir: string;
  private lockDir: string;
  private lockTimeoutMs: number;
  private activeLocks: Map<string, { lockPath: string; acquiredAt: number }>;

  constructor(options: TaskStoreOptions = {}) {
    this.rootDir = options.rootDir ?? path.join(os.homedir(), ".openclaw", "orchestrator", "tasks");
    this.lockDir = path.join(this.rootDir, ".locks");
    this.lockTimeoutMs = options.lockTimeoutMs ?? 300000; // 5 minutes
    this.activeLocks = new Map();
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(this.lockDir, { recursive: true });
  }

  // --------------------------------------------------------------------------
  // CRUD Operations
  // --------------------------------------------------------------------------

  async create(task: Omit<Task, "id" | "createdAt" | "updatedAt" | "retries">): Promise<Task> {
    await this.ensureInitialized();

    const id = this.generateId();
    const now = new Date().toISOString();

    const fullTask: Task = {
      ...task,
      id,
      createdAt: now,
      updatedAt: now,
      retries: 0,
    };

    const taskPath = this.getTaskPath(id);
    await writeFile(taskPath, JSON.stringify(fullTask, null, 2), "utf8");

    return fullTask;
  }

  async get(id: string): Promise<Task | null> {
    const taskPath = this.getTaskPath(id);

    if (!existsSync(taskPath)) {
      return null;
    }

    const content = await readFile(taskPath, "utf8");
    return JSON.parse(content) as Task;
  }

  async update(id: string, updates: Partial<Task>): Promise<Task | null> {
    const task = await this.get(id);

    if (!task) {
      return null;
    }

    const updated: Task = {
      ...task,
      ...updates,
      id: task.id, // Prevent ID modification
      createdAt: task.createdAt, // Prevent createdAt modification
      updatedAt: new Date().toISOString(),
    };

    const taskPath = this.getTaskPath(id);
    await writeFile(taskPath, JSON.stringify(updated, null, 2), "utf8");

    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const taskPath = this.getTaskPath(id);

    if (!existsSync(taskPath)) {
      return false;
    }

    // Release any active lock
    await this.releaseLock(id);

    await unlink(taskPath);
    return true;
  }

  // --------------------------------------------------------------------------
  // Query Operations
  // --------------------------------------------------------------------------

  async list(filter?: TaskFilter): Promise<Task[]> {
    await this.ensureInitialized();

    const files = await readdir(this.rootDir);
    const taskFiles = files.filter((f) => f.endsWith(".json") && f !== "status.json");

    const tasks: Task[] = [];

    for (const file of taskFiles) {
      const content = await readFile(path.join(this.rootDir, file), "utf8");
      const task = JSON.parse(content) as Task;

      if (this.matchesFilter(task, filter)) {
        tasks.push(task);
      }
    }

    // Sort by priority (descending) then createdAt (ascending)
    tasks.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    return tasks;
  }

  async getPending(limit?: number): Promise<Task[]> {
    const tasks = await this.list({ status: "pending" });
    return limit ? tasks.slice(0, limit) : tasks;
  }

  async getByCreator(createdBy: string): Promise<Task[]> {
    return this.list({ createdBy });
  }

  async getByAssignee(assignedTo: string): Promise<Task[]> {
    return this.list({ assignedTo });
  }

  // --------------------------------------------------------------------------
  // Lock Operations
  // --------------------------------------------------------------------------

  async acquireLock(taskId: string, agentId: string): Promise<boolean> {
    await this.ensureInitialized();

    const task = await this.get(taskId);
    if (!task) {
      return false;
    }

    // Check if already locked
    if (task.lockedBy && task.lockedAt) {
      const lockAge = Date.now() - new Date(task.lockedAt).getTime();

      // If lock is still valid and held by another agent
      if (lockAge < this.lockTimeoutMs && task.lockedBy !== agentId) {
        return false;
      }
    }

    // Check for stale lock file
    const lockPath = this.getLockPath(taskId);
    if (existsSync(lockPath)) {
      const lockContent = await readFile(lockPath, "utf8");
      const lock = JSON.parse(lockContent);

      const lockAge = Date.now() - lock.acquiredAt;

      // If lock is stale, clean it up
      if (lockAge >= this.lockTimeoutMs) {
        await unlink(lockPath);
      } else if (lock.agentId !== agentId) {
        return false;
      }
    }

    // Acquire lock
    const lockData = {
      taskId,
      agentId,
      acquiredAt: Date.now(),
    };

    await writeFile(lockPath, JSON.stringify(lockData), "utf8");

    // Update task
    await this.update(taskId, {
      lockedBy: agentId,
      lockedAt: new Date().toISOString(),
    });

    // Track in memory
    this.activeLocks.set(taskId, { lockPath, acquiredAt: lockData.acquiredAt });

    return true;
  }

  async releaseLock(taskId: string): Promise<void> {
    const lockPath = this.getLockPath(taskId);

    if (existsSync(lockPath)) {
      await unlink(lockPath);
    }

    this.activeLocks.delete(taskId);

    // Update task
    await this.update(taskId, {
      lockedBy: undefined,
      lockedAt: undefined,
    });
  }

  async releaseStaleLocks(): Promise<string[]> {
    const released: string[] = [];
    const now = Date.now();

    for (const [taskId, { lockPath, acquiredAt }] of this.activeLocks) {
      if (now - acquiredAt >= this.lockTimeoutMs) {
        await this.releaseLock(taskId);
        released.push(taskId);
      }
    }

    return released;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private ensureInitialized(): Promise<void> {
    if (!existsSync(this.rootDir)) {
      return this.initialize();
    }
    return Promise.resolve();
  }

  private getTaskPath(id: string): string {
    return path.join(this.rootDir, `${id}.json`);
  }

  private getLockPath(taskId: string): string {
    return path.join(this.lockDir, `${taskId}.lock`);
  }

  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = createHash("sha256")
      .update(`${Math.random()}-${process.pid}`)
      .digest("hex")
      .slice(0, 8);
    return `TASK-${timestamp}-${random}`.toUpperCase();
  }

  private matchesFilter(task: Task, filter?: TaskFilter): boolean {
    if (!filter) {
      return true;
    }

    if (filter.status && task.status !== filter.status) {
      return false;
    }
    if (filter.createdBy && task.createdBy !== filter.createdBy) {
      return false;
    }
    if (filter.assignedTo && task.assignedTo !== filter.assignedTo) {
      return false;
    }
    if (filter.priorityMin !== undefined && task.priority < filter.priorityMin) {
      return false;
    }
    if (filter.priorityMax !== undefined && task.priority > filter.priorityMax) {
      return false;
    }
    if (filter.createdAfter && new Date(task.createdAt) < new Date(filter.createdAfter)) {
      return false;
    }
    if (filter.createdBefore && new Date(task.createdAt) > new Date(filter.createdBefore)) {
      return false;
    }

    return true;
  }
}

// Default export
export default TaskStore;
