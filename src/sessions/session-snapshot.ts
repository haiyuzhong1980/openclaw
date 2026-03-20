/**
 * Session Snapshot Module
 * Save/restore session state
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir, unlink, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface SessionSnapshot {
  id: string;
  sessionId: string;
  agentId: string;
  createdAt: string;
  expiresAt?: string;
  metadata: {
    model: string;
    provider: string;
    workspace: string;
    channel?: string;
    userId?: string;
  };
  state: {
    messages: unknown[];
    variables: Record<string, unknown>;
    context: Record<string, unknown>;
  };
  stats: {
    messageCount: number;
    tokensUsed: number;
    cost: number;
  };
}

export interface SnapshotFilter {
  agentId?: string;
  sessionId?: string;
  channel?: string;
  createdAfter?: string;
  createdBefore?: string;
}

export interface SnapshotOptions {
  rootDir?: string;
  maxAge?: number; // milliseconds
  maxSnapshots?: number;
}

// ============================================================================
// SessionSnapshotStore Implementation
// ============================================================================

export class SessionSnapshotStore {
  private rootDir: string;
  private maxAge: number;
  private maxSnapshots: number;

  constructor(options: SnapshotOptions = {}) {
    this.rootDir = options.rootDir ?? path.join(os.homedir(), ".openclaw", "snapshots");
    this.maxAge = options.maxAge ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    this.maxSnapshots = options.maxSnapshots ?? 100;
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  // --------------------------------------------------------------------------
  // CRUD Operations
  // --------------------------------------------------------------------------

  async save(
    sessionId: string,
    agentId: string,
    state: SessionSnapshot["state"],
    metadata: SessionSnapshot["metadata"],
    stats: SessionSnapshot["stats"],
  ): Promise<SessionSnapshot> {
    await this.ensureInitialized();

    const snapshot: SessionSnapshot = {
      id: this.generateId(),
      sessionId,
      agentId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.maxAge).toISOString(),
      metadata,
      state,
      stats,
    };

    const filePath = this.getSnapshotPath(snapshot.id);
    await writeFile(filePath, JSON.stringify(snapshot, null, 2), "utf8");

    // Prune old snapshots
    await this.prune();

    return snapshot;
  }

  async load(snapshotId: string): Promise<SessionSnapshot | null> {
    const filePath = this.getSnapshotPath(snapshotId);

    if (!existsSync(filePath)) {
      return null;
    }

    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as SessionSnapshot;
  }

  async loadBySession(sessionId: string): Promise<SessionSnapshot | null> {
    const snapshots = await this.list({ sessionId });
    return snapshots.length > 0 ? snapshots[0] : null;
  }

  async delete(snapshotId: string): Promise<boolean> {
    const filePath = this.getSnapshotPath(snapshotId);

    if (!existsSync(filePath)) {
      return false;
    }

    await unlink(filePath);
    return true;
  }

  // --------------------------------------------------------------------------
  // Query Operations
  // --------------------------------------------------------------------------

  async list(filter?: SnapshotFilter): Promise<SessionSnapshot[]> {
    await this.ensureInitialized();

    const files = await readdir(this.rootDir);
    const snapshots: SessionSnapshot[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const filePath = path.join(this.rootDir, file);
      const content = await readFile(filePath, "utf8");
      const snapshot = JSON.parse(content) as SessionSnapshot;

      if (this.matchesFilter(snapshot, filter)) {
        snapshots.push(snapshot);
      }
    }

    // Sort by createdAt descending (newest first)
    snapshots.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return snapshots;
  }

  // --------------------------------------------------------------------------
  // Pruning
  // --------------------------------------------------------------------------

  async prune(): Promise<{ expired: number; excess: number }> {
    await this.ensureInitialized();

    const snapshots = await this.list();
    const now = Date.now();

    let expired = 0;
    let excess = 0;

    // Remove expired
    for (const s of snapshots) {
      if (s.expiresAt && new Date(s.expiresAt).getTime() < now) {
        await this.delete(s.id);
        expired++;
      }
    }

    // Remove excess (keep newest)
    const remaining = await this.list();
    if (remaining.length > this.maxSnapshots) {
      const toRemove = remaining.slice(this.maxSnapshots);
      for (const s of toRemove) {
        await this.delete(s.id);
        excess++;
      }
    }

    return { expired, excess };
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

  private getSnapshotPath(id: string): string {
    return path.join(this.rootDir, `${id}.json`);
  }

  private generateId(): string {
    return `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private matchesFilter(snapshot: SessionSnapshot, filter?: SnapshotFilter): boolean {
    if (!filter) return true;

    if (filter.agentId && snapshot.agentId !== filter.agentId) return false;
    if (filter.sessionId && snapshot.sessionId !== filter.sessionId) return false;
    if (filter.channel && snapshot.metadata.channel !== filter.channel) return false;
    if (filter.createdAfter && new Date(snapshot.createdAt) < new Date(filter.createdAfter))
      return false;
    if (filter.createdBefore && new Date(snapshot.createdAt) > new Date(filter.createdBefore))
      return false;

    return true;
  }
}

export default SessionSnapshotStore;
