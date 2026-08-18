/**
 * Agent Type System
 * Defines all agent metadata, lifecycle, capabilities, and status
 */

export type AgentType = 'ESSENTIAL' | 'OPTIONAL' | 'SPECIALIZED';
export type AgentState = 'CREATED' | 'STARTING' | 'READY' | 'RUNNING' | 'PAUSED' | 'STOPPING' | 'STOPPED' | 'ERROR';
export type AgentHealth = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'FAILING' | 'DEAD';

/**
 * Capability definition - what an agent can do
 */
export interface AgentCapability {
  id: string;
  name: string;
  description: string;
  version: string;
  parameters: Record<string, any>;
  expectedResult: string;
  verification: {
    method: 'automatic' | 'manual' | 'visual' | 'process' | 'file';
    checkFunction: (result: any) => boolean;
  };
  confirmed: boolean; // whether the agent confirmed successful execution
}

/**
 * Permissions define what an agent is allowed to do
 */
export interface AgentPermissions {
  systemAccess: {
    processManagement: boolean;
    windowManagement: boolean;
    inputControl: boolean;
    fileAccess: boolean;
    registryAccess: boolean;
  };
  networkAccess: {
    internet: boolean;
    localStorage: boolean;
    clipboard: boolean;
  };
  userInteraction: {
    requiresConfirmation: boolean;
    canSendMessages: boolean;
    canDeleteFiles: boolean;
    canModifySettings: boolean;
  };
}

/**
 * Agent dependency - another agent that must be running
 */
export interface AgentDependency {
  agentId: string;
  name: string;
  minVersion: string;
  requiredState: AgentState;
  purpose: string;
}

/**
 * Process info for a running agent
 */
export interface AgentProcessInfo {
  processId: number | null;
  port: number | null;
  status: 'not_running' | 'starting' | 'running' | 'stopping';
  uptime: number;
  lastHeartbeat: number;
  resourceUsage: {
    cpuPercent: number;
    memoryMb: number;
  };
}

/**
 * Agent registration info
 */
export interface AgentRegistration {
  agentId: string;
  name: string;
  type: AgentType;
  version: string;
  description: string;
  createdAt: number;
  modifiedAt: number;
  author?: string;
  homepage?: string;
  license?: string;
}

/**
 * Agent status - current runtime state
 */
export interface AgentStatus {
  agentId: string;
  name: string;
  state: AgentState;
  health: AgentHealth;
  lastStateChange: number;
  lastHealthCheck: number;
  lastError?: {
    timestamp: number;
    message: string;
    stack?: string;
  };
  successCount: number;
  failureCount: number;
  totalDuration: number;
  averageDuration: number;
}

/**
 * Complete agent metadata
 */
export interface AgentMetadata {
  registration: AgentRegistration;
  capabilities: AgentCapability[];
  permissions: AgentPermissions;
  dependencies: AgentDependency[];
  lifecycle: {
    startupCommand: string;
    shutdownCommand: string;
    restartCommand: string;
    readinessCheck: (metadata: AgentMetadata) => Promise<boolean>;
    healthCheck: (metadata: AgentMetadata) => Promise<AgentHealth>;
    onStartup?: () => Promise<void>;
    onShutdown?: () => Promise<void>;
    onError?: (error: Error) => Promise<void>;
  };
}

/**
 * Agent instance - agent with runtime context
 */
export interface Agent {
  metadata: AgentMetadata;
  status: AgentStatus;
  process: AgentProcessInfo;
  errorLog: Array<{
    timestamp: number;
    error: string;
    stack?: string;
    recovery?: string;
  }>;
  
  // Methods
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  healthCheck(): Promise<AgentHealth>;
  getCapability(capabilityId: string): AgentCapability | undefined;
  executeCapability(capabilityId: string, parameters: any): Promise<any>;
}

/**
 * Agent registry entry
 */
export interface AgentRegistryEntry {
  agent: Agent;
  dependencies: AgentRegistryEntry[];
  dependents: AgentRegistryEntry[];
  lastStatusUpdate: number;
  isStarting: boolean;
  isShutting: boolean;
}

/**
 * Well-known agent IDs
 */
export enum WellKnownAgents {
  DESKTOP = 'desktop-agent',
  BROWSER = 'browser-agent',
  VISION = 'vision-agent',
  VOICE = 'voice-agent',
  MEMORY = 'memory-agent',
  APPLICATION = 'application-agent',
  EMAIL = 'email-agent',
  WHATSAPP = 'whatsapp-agent',
  YOUTUBE = 'youtube-agent',
  FILE = 'file-agent',
  BRAIN = 'brain-agent',
}

/**
 * Agent supervisor configuration
 */
export interface AgentSupervisorConfig {
  autoStartEssentialAgents: boolean;
  autoRestartOnFailure: boolean;
  maxRestartAttempts: number;
  restartBackoffMs: number;
  healthCheckInterval: number;
  processTimeout: number;
  enableLogging: boolean;
  logPath?: string;
}
