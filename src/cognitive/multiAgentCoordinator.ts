/**
 * Multi-Agent Coordination System
 * 
 * Enables multiple cognitive agents to work together on complex tasks:
 * - Task delegation across agents
 * - Result aggregation and conflict resolution
 * - Agent capability discovery and matching
 * - Collaborative learning from joint execution
 * 
 * Use cases:
 * - Large tasks decomposed into subtasks for parallel execution
 * - Specialized agents handling domain-specific work
 * - Knowledge sharing between agents
 * - Emergent collective intelligence
 */

import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

export interface AgentCapability {
  agentId: string;
  capability: string;
  confidence: number;      // 0-1
  lastUsed: number;        // timestamp
  successRate: number;     // 0-1
}

export interface CoordinationTask {
  id: string;
  parentTaskId?: string;
  goal: string;
  subtasks: CoordinationTask[];
  assignedAgent?: string;
  status: 'pending' | 'assigned' | 'executing' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  timestamp: number;
}

export interface AgentMessage {
  senderId: string;
  recipientId: string;
  type: 'request' | 'response' | 'broadcast';
  content: {
    taskId: string;
    goal: string;
    context?: Record<string, unknown>;
    data?: unknown;
  };
  timestamp: number;
}

export interface CollaborativeResult {
  taskId: string;
  results: Map<string, unknown>;
  consensus?: unknown;
  conflicts: string[];
  confidence: number;
  timestamp: number;
}

/**
 * Coordinates work between multiple cognitive agents
 */
export class MultiAgentCoordinator {
  private agents: Map<string, AgentCapability[]> = new Map();
  private tasks: Map<string, CoordinationTask> = new Map();
  private messageLog: AgentMessage[] = [];
  private dataPath: string;
  private collaborativeResults: CollaborativeResult[] = [];

  constructor(dataPath: string = './data') {
    this.dataPath = dataPath;
    this.loadAgentRegistry();
  }

  /**
   * Register an agent with its capabilities
   */
  registerAgent(agentId: string, capabilities: string[]): void {
    const agentCapabilities: AgentCapability[] = capabilities.map((cap) => ({
      agentId,
      capability: cap,
      confidence: 0.5,
      lastUsed: 0,
      successRate: 0.5,
    }));

    this.agents.set(agentId, agentCapabilities);
    this.persistAgentRegistry();
  }

  /**
   * Find best agent(s) for a specific capability
   */
  findAgentForCapability(capability: string, topN: number = 1): AgentCapability[] {
    const candidates: AgentCapability[] = [];

    this.agents.forEach((caps) => {
      caps.forEach((cap) => {
        if (this.capabilityMatches(cap.capability, capability)) {
          candidates.push(cap);
        }
      });
    });

    // Sort by confidence and success rate
    candidates.sort(
      (a, b) =>
        b.confidence * b.successRate - a.confidence * a.successRate
    );

    return candidates.slice(0, topN);
  }

  /**
   * Check if a capability matches (with fuzzy matching)
   */
  private capabilityMatches(registered: string, requested: string): boolean {
    // Exact match
    if (registered === requested) return true;

    // Substring match
    if (registered.includes(requested) || requested.includes(registered)) {
      return true;
    }

    // Semantic similarity (simplified)
    const regWords = registered.toLowerCase().split(/[\s_-]/);
    const reqWords = requested.toLowerCase().split(/[\s_-]/);
    const matches = regWords.filter((w) => reqWords.includes(w)).length;
    return matches >= Math.min(regWords.length, reqWords.length) * 0.6;
  }

  /**
   * Delegate a task to agent(s)
   */
  async delegateTask(
    goal: string,
    context?: Record<string, unknown>,
    requestedCapabilities?: string[]
  ): Promise<string> {
    const taskId = uuidv4();
    const task: CoordinationTask = {
      id: taskId,
      goal,
      subtasks: [],
      status: 'pending',
      timestamp: Date.now(),
    };

    // If specific capabilities requested, decompose into subtasks
    if (requestedCapabilities && requestedCapabilities.length > 0) {
      for (const capability of requestedCapabilities) {
        const subtask: CoordinationTask = {
          id: uuidv4(),
          parentTaskId: taskId,
          goal: `${goal} - ${capability}`,
          subtasks: [],
          status: 'pending',
          timestamp: Date.now(),
        };

        const agent = this.findAgentForCapability(capability, 1)[0];
        if (agent) {
          subtask.assignedAgent = agent.agentId;
          subtask.status = 'assigned';

          // Record message
          this.messageLog.push({
            senderId: 'coordinator',
            recipientId: agent.agentId,
            type: 'request',
            content: {
              taskId: subtask.id,
              goal: subtask.goal,
              context,
            },
            timestamp: Date.now(),
          });
        }

        task.subtasks.push(subtask);
      }

      task.status = 'assigned';
    } else {
      // Simple delegation to best available agent
      const agents = Array.from(this.agents.keys());
      if (agents.length > 0) {
        const agent = agents[0]; // Simple: use first agent
        task.assignedAgent = agent;
        task.status = 'assigned';

        this.messageLog.push({
          senderId: 'coordinator',
          recipientId: agent,
          type: 'request',
          content: { taskId, goal, context },
          timestamp: Date.now(),
        });
      }
    }

    this.tasks.set(taskId, task);
    return taskId;
  }

  /**
   * Report task completion and update agent capabilities
   */
  recordTaskCompletion(
    taskId: string,
    result: unknown,
    success: boolean,
    agentId?: string
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = success ? 'completed' : 'failed';
    task.result = result;

    // Update agent success rate
    if (agentId && this.agents.has(agentId)) {
      const capabilities = this.agents.get(agentId)!;
      capabilities.forEach((cap) => {
        const alpha = 0.1; // Learning rate
        cap.successRate = cap.successRate * (1 - alpha) + (success ? 1 : 0) * alpha;
        cap.confidence = Math.min(1, cap.confidence + 0.05);
        cap.lastUsed = Date.now();
      });
    }

    // Record response message
    this.messageLog.push({
      senderId: agentId || 'unknown',
      recipientId: 'coordinator',
      type: 'response',
      content: { taskId, goal: task.goal, data: result },
      timestamp: Date.now(),
    });

    this.persistAgentRegistry();
  }

  /**
   * Aggregate results from multiple agents
   */
  aggregateResults(taskId: string): CollaborativeResult {
    const task = this.tasks.get(taskId);
    if (!task) {
      return {
        taskId,
        results: new Map(),
        conflicts: ['Task not found'],
        confidence: 0,
        timestamp: Date.now(),
      };
    }

    const results = new Map<string, unknown>();
    const conflicts: string[] = [];

    for (const subtask of task.subtasks) {
      if (subtask.result) {
        const agentId = subtask.assignedAgent || 'unknown';
        results.set(agentId, subtask.result);

        // Simple conflict detection
        if (results.size > 1) {
          const resultValues = Array.from(results.values());
          if (!this.resultsConsensus(resultValues)) {
            conflicts.push(
              `Agent ${agentId} result conflicts with previous results`
            );
          }
        }
      }
    }

    // Calculate confidence based on agent success rates
    let totalConfidence = 0;
    let count = 0;
    this.agents.forEach((caps) => {
      caps.forEach((cap) => {
        totalConfidence += cap.successRate * cap.confidence;
        count++;
      });
    });

    const avgConfidence = count > 0 ? totalConfidence / count : 0;

    const result: CollaborativeResult = {
      taskId,
      results,
      consensus: this.findConsensus(Array.from(results.values())),
      conflicts,
      confidence: avgConfidence,
      timestamp: Date.now(),
    };

    this.collaborativeResults.push(result);
    this.persistCollaborativeResults();

    return result;
  }

  /**
   * Check if multiple results reach consensus
   */
  private resultsConsensus(results: unknown[]): boolean {
    if (results.length < 2) return true;

    const first = JSON.stringify(results[0]);
    return results.every((r) => JSON.stringify(r) === first);
  }

  /**
   * Find consensus among multiple results
   */
  private findConsensus(results: unknown[]): unknown {
    if (results.length === 0) return null;
    if (results.length === 1) return results[0];

    // For arrays: intersect
    if (Array.isArray(results[0])) {
      const commonElements = (results[0] as unknown[]).filter((item) =>
        (results as unknown[][]).every((arr) =>
          arr.includes(item)
        )
      );
      return commonElements;
    }

    // For objects: merge
    if (typeof results[0] === 'object') {
      const merged = {};
      results.forEach((r) => {
        if (typeof r === 'object' && r !== null) {
          Object.assign(merged, r);
        }
      });
      return merged;
    }

    // For primitives: majority vote
    const counts = new Map<string, number>();
    results.forEach((r) => {
      const key = String(r);
      counts.set(key, (counts.get(key) || 0) + 1);
    });

    let maxCount = 0;
    let consensus = results[0];
    counts.forEach((count, key) => {
      if (count > maxCount) {
        maxCount = count;
        consensus = key;
      }
    });

    return consensus;
  }

  /**
   * Get agent statistics
   */
  getAgentStats(): Record<string, unknown> {
    const stats: Record<string, unknown> = {};

    this.agents.forEach((capabilities, agentId) => {
      const avgSuccessRate =
        capabilities.reduce((sum, cap) => sum + cap.successRate, 0) /
        (capabilities.length || 1);
      const avgConfidence =
        capabilities.reduce((sum, cap) => sum + cap.confidence, 0) /
        (capabilities.length || 1);

      stats[agentId] = {
        capabilities: capabilities.map((c) => c.capability),
        avgSuccessRate,
        avgConfidence,
        taskCount: Array.from(this.tasks.values()).filter(
          (t) => t.assignedAgent === agentId
        ).length,
      };
    });

    return stats;
  }

  /**
   * Get collaborative insights
   */
  getCollaborativeInsights(): Record<string, unknown> {
    const totalCollaborations = this.collaborativeResults.length;
    const avgConfidence =
      totalCollaborations > 0
        ? this.collaborativeResults.reduce((sum, r) => sum + r.confidence, 0) /
          totalCollaborations
        : 0;

    const conflictCount = this.collaborativeResults.reduce(
      (sum, r) => sum + r.conflicts.length,
      0
    );

    return {
      totalCollaborations,
      avgConfidence,
      conflictCount,
      avgConflictsPerTask:
        totalCollaborations > 0 ? conflictCount / totalCollaborations : 0,
      messageCount: this.messageLog.length,
    };
  }

  private persistAgentRegistry(): void {
    const registryPath = path.join(this.dataPath, 'agent_registry.json');
    const registry: Record<string, AgentCapability[]> = {};

    this.agents.forEach((caps, agentId) => {
      registry[agentId] = caps;
    });

    try {
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    } catch (err) {
      console.error('[MultiAgentCoordinator] Failed to persist agent registry', err);
    }
  }

  private loadAgentRegistry(): void {
    const registryPath = path.join(this.dataPath, 'agent_registry.json');

    try {
      if (fs.existsSync(registryPath)) {
        const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        Object.entries(data).forEach(([agentId, caps]) => {
          this.agents.set(agentId, caps as AgentCapability[]);
        });
      }
    } catch (err) {
      console.warn('[MultiAgentCoordinator] No existing agent registry', err);
    }
  }

  private persistCollaborativeResults(): void {
    const resultsPath = path.join(this.dataPath, 'collaborative_results.json');

    try {
      const serializable = this.collaborativeResults.map((r) => ({
        taskId: r.taskId,
        results: Object.fromEntries(r.results),
        consensus: r.consensus,
        conflicts: r.conflicts,
        confidence: r.confidence,
        timestamp: r.timestamp,
      }));

      fs.writeFileSync(resultsPath, JSON.stringify(serializable, null, 2));
    } catch (err) {
      console.error('[MultiAgentCoordinator] Failed to persist results', err);
    }
  }
}

// Singleton instance
let coordinatorInstance: MultiAgentCoordinator | null = null;

export function getMultiAgentCoordinator(dataPath?: string): MultiAgentCoordinator {
  if (!coordinatorInstance) {
    coordinatorInstance = new MultiAgentCoordinator(dataPath);
  }
  return coordinatorInstance;
}
