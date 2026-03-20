/**
 * OMA Transport Module
 * Message queue for inter-agent communication
 */

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface QueuedMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  payload: unknown;
  timestamp: string;
  read: boolean;
}

export interface TransportOptions {
  persistDir?: string;
  maxQueueSize?: number;
  maxMessageAge?: number; // ms
}

// ============================================================================
//OMATransport Implementation
// ============================================================================

export class OMATransport extends EventEmitter {
  private queues: Map<string, QueuedMessage[]>;
  private persistDir: string;
  private maxQueueSize: number;
  private maxMessageAge: number;

  constructor(options: TransportOptions = {}) {
    super();
    this.queues = new Map();
    this.persistDir = options.persistDir ?? path.join(os.homedir(), ".openclaw", "transport");
    this.maxQueueSize = options.maxQueueSize ?? 1000;
    this.maxMessageAge = options.maxMessageAge ?? 24 * 60 * 60 * 1000; // 24h
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await mkdir(this.persistDir, { recursive: true });
    await this.loadQueues();
  }

  private async loadQueues(): Promise<void> {
    if (!existsSync(this.persistDir)) return;

    const files = await readdir(this.persistDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const agentId = file.replace(".json", "");
      const filePath = path.join(this.persistDir, file);
      const content = await readFile(filePath, "utf8");

      try {
        const messages = JSON.parse(content) as QueuedMessage[];
        this.queues.set(agentId, messages);
      } catch {
        // Ignore corrupted files
      }
    }
  }

  private async saveQueue(agentId: string): Promise<void> {
    const messages = this.queues.get(agentId) ?? [];
    const filePath = path.join(this.persistDir, `${agentId}.json`);
    await writeFile(filePath, JSON.stringify(messages, null, 2), "utf8");
  }

  // --------------------------------------------------------------------------
  // Send/Receive
  // --------------------------------------------------------------------------

  async send(from: string, to: string, type: string, payload: unknown): Promise<QueuedMessage> {
    const message: QueuedMessage = {
      id: this.generateId(),
      from,
      to,
      type,
      payload,
      timestamp: new Date().toISOString(),
      read: false,
    };

    // Get or create queue
    let queue = this.queues.get(to);
    if (!queue) {
      queue = [];
      this.queues.set(to, queue);
    }

    // Enforce max queue size
    if (queue.length >= this.maxQueueSize) {
      queue.shift(); // Remove oldest
    }

    queue.push(message);
    await this.saveQueue(to);

    this.emit("message", { to, message });
    return message;
  }

  async receive(agentId: string, markRead = true): Promise<QueuedMessage[]> {
    const queue = this.queues.get(agentId) ?? [];
    const now = Date.now();

    // Filter out expired messages
    const valid = queue.filter((m) => {
      const age = now - new Date(m.timestamp).getTime();
      return age < this.maxMessageAge;
    });

    if (markRead) {
      for (const m of valid) {
        m.read = true;
      }
      await this.saveQueue(agentId);
    }

    return valid;
  }

  async receiveUnread(agentId: string): Promise<QueuedMessage[]> {
    const messages = await this.receive(agentId, false);
    return messages.filter((m) => !m.read);
  }

  // --------------------------------------------------------------------------
  // Query
  // --------------------------------------------------------------------------

  getQueueSize(agentId: string): number {
    return this.queues.get(agentId)?.length ?? 0;
  }

  hasMessages(agentId: string): boolean {
    const queue = this.queues.get(agentId);
    return queue !== undefined && queue.length > 0;
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  async clear(agentId: string): Promise<void> {
    this.queues.delete(agentId);
    const filePath = path.join(this.persistDir, `${agentId}.json`);
    if (existsSync(filePath)) {
      await unlink(filePath);
    }
  }

  async prune(): Promise<void> {
    const now = Date.now();

    for (const [agentId, queue] of this.queues) {
      const valid = queue.filter((m) => {
        const age = now - new Date(m.timestamp).getTime();
        return age < this.maxMessageAge;
      });

      if (valid.length !== queue.length) {
        this.queues.set(agentId, valid);
        await this.saveQueue(agentId);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private generateId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export default OMATransport;
