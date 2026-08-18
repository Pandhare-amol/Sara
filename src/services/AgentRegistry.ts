/**
 * Agent Registry
 * 
 * Central registry for all SARA agents.
 * Provides:
 * - Agent discovery
 * - Agent metadata
 * - Capability lookup
 * - Status tracking
 * - Dependency resolution
 */

import type {
  Agent,
  AgentMetadata,
  AgentStatus,
  AgentState,
  AgentHealth,
  AgentRegistryEntry,
  AgentRegistration,
  AgentCapability,
  WellKnownAgents,
} from '../types/AgentTypes';

export class AgentRegistry {
  private agents: Map<string, Agent> = new Map();
  private metadata: Map<string, AgentMetadata> = new Map();
  private status: Map<string, AgentStatus> = new Map();
  private registryEntries: Map<string, AgentRegistryEntry> = new Map();

  /**
   * Register an agent
   */
  register(agent: Agent): void {
    const agentId = agent.metadata.registration.agentId;
    
    this.agents.set(agentId, agent);
    this.metadata.set(agentId, agent.metadata);
    this.status.set(agentId, agent.status);

    // Create registry entry
    const entry: AgentRegistryEntry = {
      agent,
      dependencies: [],
      dependents: [],
      lastStatusUpdate: Date.now(),
      isStarting: false,
      isShutting: false,
    };

    this.registryEntries.set(agentId, entry);

    console.log(`[AgentRegistry] Registered agent: ${agent.metadata.registration.name} (${agentId})`);
  }

  /**
   * Unregister an agent
   */
  unregister(agentId: string): boolean {
    const removed = this.agents.delete(agentId);
    this.metadata.delete(agentId);
    this.status.delete(agentId);
    this.registryEntries.delete(agentId);

    if (removed) {
      console.log(`[AgentRegistry] Unregistered agent: ${agentId}`);
    }

    return removed;
  }

  /**
   * Get agent by ID
   */
  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all agents
   */
  getAllAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agents by type
   */
  getAgentsByType(type: 'ESSENTIAL' | 'OPTIONAL' | 'SPECIALIZED'): Agent[] {
    return this.getAllAgents().filter(a => a.metadata.registration.type === type);
  }

  /**
   * Get agent metadata
   */
  getMetadata(agentId: string): AgentMetadata | undefined {
    return this.metadata.get(agentId);
  }

  /**
   * Get agent status
   */
  getStatus(agentId: string): AgentStatus | undefined {
    return this.status.get(agentId);
  }

  /**
   * Update agent status
   */
  updateStatus(agentId: string, status: Partial<AgentStatus>): void {
    const current = this.status.get(agentId);
    if (!current) return;

    const updated: AgentStatus = { ...current, ...status };
    this.status.set(agentId, updated);

    const entry = this.registryEntries.get(agentId);
    if (entry) {
      entry.lastStatusUpdate = Date.now();
    }
  }

  /**
   * Get all agents that this agent depends on
   */
  getDependencies(agentId: string): Agent[] {
    const metadata = this.metadata.get(agentId);
    if (!metadata) return [];

    return metadata.dependencies
      .map(dep => this.agents.get(dep.agentId))
      .filter((a) => a !== undefined) as Agent[];
  }

  /**
   * Get all agents that depend on this agent
   */
  getDependents(agentId: string): Agent[] {
    return this.getAllAgents().filter(agent => {
      return agent.metadata.dependencies.some(dep => dep.agentId === agentId);
    });
  }

  /**
   * Find agent by capability
   */
  findAgentWithCapability(capabilityName: string): Agent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.metadata.capabilities.some(cap => cap.name === capabilityName)) {
        return agent;
      }
    }
    return undefined;
  }

  /**
   * Get agents by health status
   */
  getAgentsByHealth(health: AgentHealth): Agent[] {
    return this.getAllAgents().filter(agent => {
      const status = this.status.get(agent.metadata.registration.agentId);
      return status?.health === health;
    });
  }

  /**
   * Get agents by state
   */
  getAgentsByState(state: AgentState): Agent[] {
    return this.getAllAgents().filter(agent => {
      const status = this.status.get(agent.metadata.registration.agentId);
      return status?.state === state;
    });
  }

  /**
   * Check if an agent is registered
   */
  isRegistered(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Get registry statistics
   */
  getStats(): {
    totalAgents: number;
    byType: Record<string, number>;
    byHealth: Record<string, number>;
    byState: Record<string, number>;
  } {
    const agents = this.getAllAgents();
    const stats = {
      totalAgents: agents.length,
      byType: {} as Record<string, number>,
      byHealth: {} as Record<string, number>,
      byState: {} as Record<string, number>,
    };

    for (const agent of agents) {
      const type = agent.metadata.registration.type;
      stats.byType[type] = (stats.byType[type] || 0) + 1;

      const status = this.status.get(agent.metadata.registration.agentId);
      if (status) {
        stats.byHealth[status.health] = (stats.byHealth[status.health] || 0) + 1;
        stats.byState[status.state] = (stats.byState[status.state] || 0) + 1;
      }
    }

    return stats;
  }

  /**
   * Clear all agents
   */
  clear(): void {
    this.agents.clear();
    this.metadata.clear();
    this.status.clear();
    this.registryEntries.clear();
  }
}

// Singleton instance
let registryInstance: AgentRegistry | null = null;

export function getAgentRegistry(): AgentRegistry {
  if (!registryInstance) {
    registryInstance = new AgentRegistry();
  }
  return registryInstance;
}

export function createAgentRegistry(): AgentRegistry {
  return new AgentRegistry();
}
