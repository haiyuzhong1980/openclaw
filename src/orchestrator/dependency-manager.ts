/**
 * Dependency Manager Module
 * Manages task dependencies with cycle detection
 */

// ============================================================================
// Types
// ============================================================================

export interface DependencyNode {
  id: string;
  dependencies: Set<string>;
  dependents: Set<string>;
  status: "pending" | "ready" | "running" | "completed" | "failed";
}

export interface CycleResult {
  hasCycle: boolean;
  cyclePath: string[];
}

// ============================================================================
// DependencyManager Implementation
// ============================================================================

export class DependencyManager {
  private nodes: Map<string, DependencyNode>;

  constructor() {
    this.nodes = new Map();
  }

  // --------------------------------------------------------------------------
  // Node Management
  // --------------------------------------------------------------------------

  addNode(id: string): DependencyNode {
    if (this.nodes.has(id)) {
      return this.nodes.get(id)!;
    }

    const node: DependencyNode = {
      id,
      dependencies: new Set(),
      dependents: new Set(),
      status: "pending",
    };

    this.nodes.set(id, node);
    return node;
  }

  removeNode(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) {
      return false;
    }

    // Remove from all dependents
    for (const depId of node.dependencies) {
      const dep = this.nodes.get(depId);
      if (dep) {
        dep.dependents.delete(id);
      }
    }

    // Remove from all dependencies
    for (const depId of node.dependents) {
      const dep = this.nodes.get(depId);
      if (dep) {
        dep.dependencies.delete(id);
      }
    }

    this.nodes.delete(id);
    return true;
  }

  getNode(id: string): DependencyNode | undefined {
    return this.nodes.get(id);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  // --------------------------------------------------------------------------
  // Dependency Management
  // --------------------------------------------------------------------------

  addDependency(nodeId: string, dependsOn: string): boolean {
    const node = this.addNode(nodeId);
    const dep = this.addNode(dependsOn);

    // Check for self-dependency
    if (nodeId === dependsOn) {
      return false;
    }

    // Add dependency
    node.dependencies.add(dependsOn);
    dep.dependents.add(nodeId);

    // Check for cycle
    const cycleResult = this.detectCycle(nodeId);
    if (cycleResult.hasCycle) {
      // Rollback
      node.dependencies.delete(dependsOn);
      dep.dependents.delete(nodeId);
      return false;
    }

    return true;
  }

  removeDependency(nodeId: string, dependsOn: string): boolean {
    const node = this.nodes.get(nodeId);
    const dep = this.nodes.get(dependsOn);

    if (!node || !dep) {
      return false;
    }

    node.dependencies.delete(dependsOn);
    dep.dependents.delete(nodeId);

    return true;
  }

  // --------------------------------------------------------------------------
  // Status Management
  // --------------------------------------------------------------------------

  checkReady(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) {
      return false;
    }

    // Check if all dependencies are completed
    for (const depId of node.dependencies) {
      const dep = this.nodes.get(depId);
      if (!dep || dep.status !== "completed") {
        return false;
      }
    }

    return true;
  }

  markCompleted(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) {
      return false;
    }

    node.status = "completed";
    return true;
  }

  markFailed(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) {
      return false;
    }

    node.status = "failed";
    return true;
  }

  getReadyNodes(): string[] {
    const ready: string[] = [];

    for (const [id, node] of this.nodes) {
      if (node.status === "pending" && this.checkReady(id)) {
        ready.push(id);
      }
    }

    return ready;
  }

  // --------------------------------------------------------------------------
  // Cycle Detection
  // --------------------------------------------------------------------------

  detectCycle(startId?: string): CycleResult {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (nodeId: string): string[] | null => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const node = this.nodes.get(nodeId);
      if (node) {
        for (const depId of node.dependencies) {
          if (!visited.has(depId)) {
            const cyclePath = dfs(depId);
            if (cyclePath) {
              return cyclePath;
            }
          } else if (recursionStack.has(depId)) {
            // Found cycle
            const cycleStart = path.indexOf(depId);
            return path.slice(cycleStart);
          }
        }
      }

      path.pop();
      recursionStack.delete(nodeId);
      return null;
    };

    if (startId) {
      const cyclePath = dfs(startId);
      if (cyclePath) {
        return { hasCycle: true, cyclePath };
      }
    } else {
      for (const [id] of this.nodes) {
        if (!visited.has(id)) {
          const cyclePath = dfs(id);
          if (cyclePath) {
            return { hasCycle: true, cyclePath };
          }
        }
      }
    }

    return { hasCycle: false, cyclePath: [] };
  }

  // --------------------------------------------------------------------------
  // Topological Sort
  // --------------------------------------------------------------------------

  topologicalSort(): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const temp = new Set<string>();

    const visit = (nodeId: string): boolean => {
      if (temp.has(nodeId)) {
        return false;
      } // Cycle detected
      if (visited.has(nodeId)) {
        return true;
      }

      temp.add(nodeId);

      const node = this.nodes.get(nodeId);
      if (node) {
        for (const depId of node.dependencies) {
          if (!visit(depId)) {
            return false;
          }
        }
      }

      temp.delete(nodeId);
      visited.add(nodeId);
      result.push(nodeId);
      return true;
    };

    for (const [id] of this.nodes) {
      if (!visited.has(id)) {
        if (!visit(id)) {
          return []; // Cycle detected
        }
      }
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Visualization
  // --------------------------------------------------------------------------

  toDot(): string {
    const lines: string[] = ["digraph dependencies {"];
    lines.push("  rankdir=LR;");
    lines.push("");

    // Add nodes
    for (const [id, node] of this.nodes) {
      const color = this.getStatusColor(node.status);
      lines.push(`  "${id}" [fillcolor=${color}, style=filled];`);
    }

    lines.push("");

    // Add edges
    for (const [id, node] of this.nodes) {
      for (const depId of node.dependencies) {
        lines.push(`  "${id}" -> "${depId}";`);
      }
    }

    lines.push("}");
    return lines.join("\n");
  }

  private getStatusColor(status: DependencyNode["status"]): string {
    switch (status) {
      case "pending":
        return "lightgray";
      case "ready":
        return "lightblue";
      case "running":
        return "yellow";
      case "completed":
        return "lightgreen";
      case "failed":
        return "lightcoral";
      default:
        return "white";
    }
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  clear(): void {
    this.nodes.clear();
  }

  size(): number {
    return this.nodes.size;
  }

  getStats(): { total: number; pending: number; ready: number; completed: number; failed: number } {
    let pending = 0,
      ready = 0,
      completed = 0,
      failed = 0;

    for (const [, node] of this.nodes) {
      switch (node.status) {
        case "pending":
          if (this.checkReady(node.id)) {
            ready++;
          } else {
            pending++;
          }
          break;
        case "completed":
          completed++;
          break;
        case "failed":
          failed++;
          break;
      }
    }

    return { total: this.nodes.size, pending, ready, completed, failed };
  }
}

export default DependencyManager;
