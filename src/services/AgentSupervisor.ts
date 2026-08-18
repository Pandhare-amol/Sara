/**
 * Agent Supervisor
 * 
 * Manages the complete lifecycle of all agents.
 * 
 * Responsibilities:
 * - Agent discovery and initialization
 * - Startup/shutdown orchestration
 * - Dependency ordering
 * - Health monitoring
 * - Crash detection and recovery
 * - Capability registration
 * - Process lifecycle management
 */

import { AgentRegistry, getAgentRegistry } from './AgentRegistry';
import type {
  Agent,
  AgentState,
  AgentHealth,
  AgentSupervisorConfig,
  AgentDependency,
} from '../types/AgentTypes';

export class AgentSupervisor {
  private registry: AgentRegistry;
  private config: AgentSupervisorConfig;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private startupInProgress: boolean = false;
  private shutdownInProgress: boolean = false;
  private restartAttempts: Map<string, number> = new Map();

  constructor(registry: AgentRegistry, config: Partial<AgentSupervisorConfig> = {}) {
    this.registry = registry;
    this.config = {
      autoStartEssentialAgents: config.autoStartEssentialAgents ?? true,
      autoRestartOnFailure: config.autoRestartOnFailure ?? true,
      maxRestartAttempts: config.maxRestartAttempts ?? 3,
      restartBackoffMs: config.restartBackoffMs ?? 5000,
      healthCheckInterval: config.healthCheckInterval ?? 30000, // 30s
      processTimeout: config.processTimeout ?? 30000, // 30s
      enableLogging: config.enableLogging ?? true,
      logPath: config.logPath,
    };
  }

  /**
   * Initialize supervisor and start essential agents
   */
  async initialize(): Promise<void> {
    this.log('[Supervisor] Initializing...');

    try {
      // Start health check loop
      this.startHealthCheckLoop();

      if (this.config.autoStartEssentialAgents) {
        await this.startEssentialAgents();
      }

      this.log('[Supervisor] Initialization complete');
    } catch (error) {
      this.error('[Supervisor] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Start all essential agents
   */
  async startEssentialAgents(): Promise<void> {
    if (this.startupInProgress) return;
    this.startupInProgress = true;

    try {
      const essentialAgents = this.registry.getAgentsByType('ESSENTIAL');
      this.log(`[Supervisor] Starting ${essentialAgents.length} essential agents`);

      // Sort by dependencies - start dependencies first
      const sorted = this.sortByDependencies(essentialAgents);

      for (const agent of sorted) {
        await this.startAgent(agent);
      }

      this.log('[Supervisor] All essential agents started');
    } finally {
      this.startupInProgress = false;
    }
  }

  /**
   * Start a specific agent
   */
  async startAgent(agent: Agent, timeout: number = this.config.processTimeout): Promise<void> {
    const agentId = agent.metadata.registration.agentId;
    const agentName = agent.metadata.registration.name;

    try {
      this.log(`[Supervisor] Starting agent: ${agentName} (${agentId})`);
      this.registry.updateStatus(agentId, { state: 'STARTING' });

      // Check dependencies first
      const deps = this.registry.getDependencies(agentId);
      for (const dep of deps) {
        const depStatus = this.registry.getStatus(dep.metadata.registration.agentId);
        if (!depStatus || depStatus.state !== 'READY' && depStatus.state !== 'RUNNING') {
          this.log(`[Supervisor] Starting dependency: ${dep.metadata.registration.name}`);
          await this.startAgent(dep);
        }
      }

      // Start the agent
      const startPromise = agent.start();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Start timeout')), timeout);
      });

      await Promise.race([startPromise, timeoutPromise]);

      // Verify readiness
      const isReady = await agent.metadata.lifecycle.readinessCheck(agent.metadata);
      if (!isReady) {
        throw new Error('Agent failed readiness check');
      }

      this.registry.updateStatus(agentId, { state: 'READY' });
      this.log(`[Supervisor] ✓ Agent started: ${agentName}`);
      this.restartAttempts.delete(agentId);
    } catch (error) {
      const errorMsg = `Failed to start ${agentName}: ${error}`;
      this.error(errorMsg);
      this.registry.updateStatus(agentId, { 
        state: 'ERROR', 
        health: 'FAILING',
        lastError: {
          timestamp: Date.now(),
          message: String(error),
        }
      });
      throw error;
    }
  }

  /**
   * Stop a specific agent
   */
  async stopAgent(agent: Agent): Promise<void> {
    const agentId = agent.metadata.registration.agentId;
    const agentName = agent.metadata.registration.name;

    try {
      this.log(`[Supervisor] Stopping agent: ${agentName}`);
      this.registry.updateStatus(agentId, { state: 'STOPPING' });

      await agent.stop();

      this.registry.updateStatus(agentId, { state: 'STOPPED' });
      this.log(`[Supervisor] ✓ Agent stopped: ${agentName}`);
    } catch (error) {
      this.error(`Failed to stop ${agentName}:`, error);
      this.registry.updateStatus(agentId, { 
        state: 'ERROR',
        lastError: {
          timestamp: Date.now(),
          message: String(error),
        }
      });
    }
  }

  /**
   * Restart an agent
   */
  async restartAgent(agent: Agent): Promise<boolean> {
    const agentId = agent.metadata.registration.agentId;
    const agentName = agent.metadata.registration.name;

    const attempts = (this.restartAttempts.get(agentId) || 0) + 1;

    if (attempts > this.config.maxRestartAttempts) {
      this.error(`[Supervisor] Max restart attempts reached for ${agentName}`);
      this.registry.updateStatus(agentId, { 
        health: 'DEAD',
        state: 'ERROR'
      });
      return false;
    }

    try {
      this.log(`[Supervisor] Restarting agent ${agentName} (attempt ${attempts}/${this.config.maxRestartAttempts})`);

      await this.stopAgent(agent);

      // Backoff before restart
      await new Promise(resolve => 
        setTimeout(resolve, this.config.restartBackoffMs * attempts)
      );

      await this.startAgent(agent);

      this.restartAttempts.set(agentId, attempts);
      return true;
    } catch (error) {
      this.error(`[Supervisor] Restart failed for ${agentName}:`, error);
      return false;
    }
  }

  /**
   * Health check loop
   */
  private startHealthCheckLoop(): void {
    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.performHealthChecks();
      } catch (error) {
        this.error('[Supervisor] Health check error:', error);
      }
    }, this.config.healthCheckInterval);
  }

  /**
   * Perform health checks on all agents
   */
  private async performHealthChecks(): Promise<void> {
    const agents = this.registry.getAllAgents();

    for (const agent of agents) {
      try {
        const agentId = agent.metadata.registration.agentId;
        const status = this.registry.getStatus(agentId);

        if (!status) continue;

        // Skip if not running
        if (status.state !== 'READY' && status.state !== 'RUNNING') {
          continue;
        }

        // Perform health check
        const health = await agent.healthCheck();
        this.registry.updateStatus(agentId, { 
          health,
          lastHealthCheck: Date.now()
        });

        // Detect failure
        if (health === 'FAILING' || health === 'DEAD') {
          this.log(`[Supervisor] Agent health degraded: ${agent.metadata.registration.name}`);

          if (this.config.autoRestartOnFailure) {
            const recovered = await this.restartAgent(agent);
            if (!recovered) {
              this.log(`[Supervisor] Could not recover ${agent.metadata.registration.name}`);
            }
          }
        }
      } catch (error) {
        this.error('[Supervisor] Error during health check:', error);
      }
    }
  }

  /**
   * Shutdown all agents
   */
  async shutdown(): Promise<void> {
    if (this.shutdownInProgress) return;
    this.shutdownInProgress = true;

    try {
      this.log('[Supervisor] Shutting down all agents...');

      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
      }

      const agents = this.registry.getAllAgents().reverse(); // Reverse order for shutdown

      for (const agent of agents) {
        await this.stopAgent(agent);
      }

      this.log('[Supervisor] All agents shut down');
    } finally {
      this.shutdownInProgress = false;
    }
  }

  /**
   * Sort agents by dependencies (dependencies first)
   */
  private sortByDependencies(agents: Agent[]): Agent[] {
    const sorted: Agent[] = [];
    const visited = new Set<string>();

    const visit = (agent: Agent) => {
      const agentId = agent.metadata.registration.agentId;
      if (visited.has(agentId)) return;

      // Visit dependencies first
      const deps = this.registry.getDependencies(agentId);
      for (const dep of deps) {
        visit(dep);
      }

      sorted.push(agent);
      visited.add(agentId);
    };

    for (const agent of agents) {
      visit(agent);
    }

    return sorted;
  }

  /**
   * Get supervisor status
   */
  getStatus(): {
    healthy: boolean;
    agentsRunning: number;
    agentsTotal: number;
    agentsByHealth: Record<string, number>;
    failingAgents: string[];
  } {
    const stats = this.registry.getStats();
    const failingAgents: string[] = [];

    for (const agent of this.registry.getAllAgents()) {
      const status = this.registry.getStatus(agent.metadata.registration.agentId);
      if (status && (status.health === 'FAILING' || status.health === 'DEAD')) {
        failingAgents.push(agent.metadata.registration.name);
      }
    }

    const agentsRunning = (stats.byState['READY'] || 0) + (stats.byState['RUNNING'] || 0);

    return {
      healthy: failingAgents.length === 0,
      agentsRunning,
      agentsTotal: stats.totalAgents,
      agentsByHealth: stats.byHealth,
      failingAgents,
    };
  }

  // Logging utilities
  private log(message: string): void {
    if (this.config.enableLogging) {
      console.log(message);
    }
  }

  private error(message: string, error?: any): void {
    if (this.config.enableLogging) {
      console.error(message, error);
    }
  }
}

// Singleton instance
let supervisorInstance: AgentSupervisor | null = null;

export function getAgentSupervisor(config?: Partial<AgentSupervisorConfig>): AgentSupervisor {
  if (!supervisorInstance) {
    const registry = getAgentRegistry();
    supervisorInstance = new AgentSupervisor(registry, config);
  }
  return supervisorInstance;
}

export function createAgentSupervisor(config?: Partial<AgentSupervisorConfig>): AgentSupervisor {
  const registry = getAgentRegistry();
  return new AgentSupervisor(registry, config);
}
