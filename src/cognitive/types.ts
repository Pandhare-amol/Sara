/**
 * Cognitive Architecture Types
 *
 * Defines the core data structures for SARA's human-like memory,
 * planning, and reasoning systems.
 */

export interface WorkingMemoryItem {
  id: string;
  key: string; // What is this item about (e.g., "current_goal", "active_window")
  value: unknown; // The value
  source: string; // Where it came from (e.g., "user_input", "screen_capture")
  timestamp: number; // When it was added
  ttl?: number; // Time to live in ms (optional auto-cleanup)
  priority: number; // Higher priority kept longer
}

export interface WorkingMemoryState {
  items: Map<string, WorkingMemoryItem>;
  lastCleanup: number;
}

export interface EpisodicMemory {
  id: string;
  timestamp: number;
  taskId?: string;
  conversationId?: string;
  title: string;
  context: {
    goal: string;
    environment: string;
    initialState: unknown;
    applications?: string[];
    files?: string[];
  };
  plan: {
    steps: PlanStep[];
    estimatedDuration?: number;
  };
  execution: {
    actions: AgentAction[];
    observations: Observation[];
    errors?: ErrorRecord[];
    corrections?: Correction[];
  };
  outcome: {
    success: boolean;
    goalAchieved: boolean;
    completionTime: number;
    userIntervention: boolean;
    reward?: number;
  };
  lesson: {
    keyInsights?: string[];
    failureModes?: string[];
    successFactors?: string[];
    suggestedProcedure?: string;
  };
  metadata: {
    importance: number;
    confidence: number;
    tags?: string[];
    relatedMemories?: string[];
  };
}

export interface SemanticMemory {
  id: string;
  type: "preference" | "fact" | "concept" | "rule" | "relationship";
  category: string;
  content: string;
  confidence: number;
  source?: string; // Where learned
  timestamp: number;
  lastReferenced?: number;
  referenceCount: number;
  contradictions?: string[]; // IDs of contradicting memories
  metadata: Record<string, unknown>;
}

export interface ProceduralMemory {
  id: string;
  name: string;
  description: string;
  category: string; // e.g., "workflow", "skill", "automation"
  steps: ProcedureStep[];
  preconditions: string[];
  postconditions: string[];
  requiredTools: string[];
  requiredPermissions: string[];
  parameters: ProcedureParameter[];
  statistics: {
    timesExecuted: number;
    successCount: number;
    failureCount: number;
    averageDuration: number; // ms
    successRate: number; // 0-1
  };
  confidence: number; // 0-1
  lastExecuted?: number;
  knownFailureModes?: string[];
  version: string;
  metadata: Record<string, unknown>;
}

export interface ProcedureStep {
  id: string;
  index: number;
  description: string;
  action: string; // Tool name
  args: Record<string, unknown>;
  expectedOutcome?: string;
  failureRecovery?: string;
  verifiable: boolean;
}

export interface ProcedureParameter {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  description: string;
}

export interface AutobiographicalMemory {
  id: string;
  type: "milestone" | "project" | "instruction" | "relationship" | "goal" | "event";
  timestamp: number;
  content: string;
  significance: number; // 0-10
  relatedEpisodes?: string[]; // Episode IDs
  relatedSemantic?: string[]; // Semantic memory IDs
  project?: string;
  tags?: string[];
  metadata: Record<string, unknown>;
}

export interface PlanStep {
  id: string;
  index: number;
  goal: string;
  action: string;
  tool?: string;
  args?: Record<string, unknown>;
  expectedOutcome?: string;
  dependencies?: string[]; // IDs of other steps
  estimatedDuration?: number; // ms
  critical: boolean;
  alternatives?: PlanStep[];
  verifiable: boolean;
}

export interface AgentAction {
  id: string;
  timestamp: number;
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  duration: number; // ms
  success: boolean;
}

export interface Observation {
  id: string;
  timestamp: number;
  type: "screenshot" | "ocr" | "metric" | "state" | "event";
  content: unknown;
  relevantTools?: string[];
  metadata: Record<string, unknown>;
}

export interface Correction {
  id: string;
  timestamp: number;
  originalAction: string;
  correctionType: "user_feedback" | "auto_recovery" | "re_planning";
  reason: string;
  newAction: string;
  result?: unknown;
}

export interface ErrorRecord {
  id: string;
  timestamp: number;
  tool: string;
  errorType: string;
  message: string;
  recovered: boolean;
  recoveryMethod?: string;
  impact: "low" | "medium" | "high";
}

export interface TaskEvaluation {
  id: string;
  taskId: string;
  episodeId: string;
  evaluatedAt: number;
  metrics: {
    goalAchieved: boolean;
    planSuccessful: boolean;
    unnecessaryActions: number;
    userInterventions: number;
    totalErrors: number;
    recoveredErrors: number;
    executionTime: number; // ms
    estimatedTime?: number; // ms
    timeEfficiency?: number; // 0-1
  };
  reasoning: {
    bestStrategy?: string;
    lessons?: string[];
    failureCauses?: string[];
    improvements?: string[];
  };
  reward: number; // -2 to +2
  strategyQuality: number; // 0-1
  confidence: number; // 0-1
  metadata: Record<string, unknown>;
}

export interface MemoryRetrievalContext {
  query: string;
  intent?: string;
  taskType?: string;
  projectContext?: string;
  limit: number;
  scoreThreshold?: number;
}

export interface MemoryRetrievalResult {
  episodic: EpisodicMemory[];
  semantic: SemanticMemory[];
  procedural: ProceduralMemory[];
  autobiographical: AutobiographicalMemory[];
  ragChunks?: unknown[];
  confidence: number;
}

export interface CognitiveContext {
  workingMemory: Record<string, unknown>;
  relevantMemories: MemoryRetrievalResult;
  currentGoal?: string;
  currentPlan?: PlanStep[];
  recentActions: AgentAction[];
  conversationContext?: string;
  screenContext?: unknown;
  timeOfDay?: number; // epoch ms
  projectContext?: string;
}
