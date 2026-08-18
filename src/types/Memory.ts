/**
 * Human-like Memory System for SARA
 * Episodic, Semantic, Procedural, Preference, Failure, Achievement, and Autobiographical
 */

import type { Skill } from './ClosedLoopTask';

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  timestamp: number;
  confidence: number;
  tags: string[];
  source: string;
  provenance: MemoryProvenance;
  ttl?: number; // time-to-live in milliseconds, undefined = permanent
  metadata: Record<string, any>;
}

export type MemoryType =
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'preference'
  | 'failure'
  | 'achievement'
  | 'autobiographical';

export interface MemoryProvenance {
  source: 'observation' | 'inference' | 'user_input' | 'learning' | 'recovery';
  actor: 'user' | 'sara' | 'system';
  taskId?: string;
  evidence: string[];
  verified: boolean;
}

// EPISODIC MEMORY: What happened
export interface EpisodicMemory extends MemoryRecord {
  type: 'episodic';
  event: {
    description: string;
    timestamp: number;
    duration?: number;
    participants: string[]; // user, applications, etc.
    context: Record<string, any>;
    outcome: 'success' | 'partial' | 'failure';
    details: string;
  };
}

// SEMANTIC MEMORY: Facts about the world
export interface SemanticMemory extends MemoryRecord {
  type: 'semantic';
  fact: {
    statement: string;
    category: string;
    assertions: Assertion[];
    supportingEvidence: string[];
    contradictingEvidence: string[];
  };
}

export interface Assertion {
  statement: string;
  confidence: number;
  supporting: string[];
  contradicting: string[];
}

// PROCEDURAL MEMORY: How to do things (skills)
export interface ProceduralMemory extends MemoryRecord {
  type: 'procedural';
  skill: Skill;
}

// PREFERENCE MEMORY: User preferences
export interface PreferenceMemory extends MemoryRecord {
  type: 'preference';
  preference: {
    key: string;
    value: any;
    category: string;
    appliesTo: string[]; // contexts where this applies
    overrides: string[];
    learnedFrom: string[]; // task IDs where this was learned
    exceptions: PreferenceException[];
  };
}

export interface PreferenceException {
  condition: string;
  alternateValue: any;
  confidence: number;
}

// FAILURE MEMORY: What went wrong
export interface FailureMemory extends MemoryRecord {
  type: 'failure';
  failure: {
    taskId: string;
    taskType: string;
    goal: string;
    failureType: string;
    strategy: string;
    outcome: string;
    rootCause: string;
    failureTime: number;
    consequences: string[];
    suggestedAlternative: string;
    alternativeSuccessRate?: number;
    repeated: boolean;
    repeatCount: number;
    lastOccurrence: number;
  };
}

// ACHIEVEMENT MEMORY: Successful workflows
export interface AchievementMemory extends MemoryRecord {
  type: 'achievement';
  achievement: {
    taskId: string;
    taskType: string;
    goal: string;
    successStrategy: string;
    executionTime: number;
    attempts: number;
    verificationQuality: number;
    reusable: boolean;
    learnedSkill?: string;
    conditions: Map<string, any>;
    evidence: string[];
  };
}

// AUTOBIOGRAPHICAL MEMORY: SARA's history and identity
export interface AutobiographicalMemory extends MemoryRecord {
  type: 'autobiographical';
  autobiography: {
    category: 'capability' | 'interaction' | 'learning' | 'limitation' | 'personality' | 'relationship';
    description: string;
    timeRange: {
      start: number;
      end?: number;
    };
    relatedMemories: string[];
    importanceScore: number;
    recurring: boolean;
  };
}

export interface MemoryStore {
  episodic: Map<string, EpisodicMemory>;
  semantic: Map<string, SemanticMemory>;
  procedural: Map<string, ProceduralMemory>;
  preference: Map<string, PreferenceMemory>;
  failure: Map<string, FailureMemory>;
  achievement: Map<string, AchievementMemory>;
  autobiographical: Map<string, AutobiographicalMemory>;
  createdAt: number;
  lastAccessed: number;
}

export interface MemoryQuery {
  type?: MemoryType;
  tags?: string[];
  keywords?: string[];
  confidence?: number; // minimum confidence
  recency?: number; // prefer memories from last N milliseconds
  limit?: number;
  category?: string;
  excludeTags?: string[];
}

export interface MemoryRetrievalResult {
  memories: MemoryRecord[];
  relevanceScores: Map<string, number>; // memoryId -> relevance (0-1)
  queryTime: number;
  totalMatches: number;
}

export interface MemoryOperationResult {
  success: boolean;
  memoryId?: string;
  error?: string;
  details?: Record<string, any>;
}

export function createEpisodicMemory(
  event: string,
  timestamp: number,
  outcome: 'success' | 'partial' | 'failure',
  details: string,
  confidence: number = 0.9,
  tags: string[] = [],
  context: Record<string, any> = {}
): EpisodicMemory {
  return {
    id: `mem-ep-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    type: 'episodic',
    timestamp,
    confidence,
    tags,
    source: 'observation',
    provenance: {
      source: 'observation',
      actor: 'sara',
      evidence: [details],
      verified: confidence > 0.8,
    },
    metadata: context,
    event: {
      description: event,
      timestamp,
      participants: ['sara'],
      context,
      outcome,
      details,
    },
  };
}

export function createSemanticMemory(
  statement: string,
  category: string,
  confidence: number = 0.9,
  tags: string[] = [],
  evidence: string[] = []
): SemanticMemory {
  return {
    id: `mem-sem-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    type: 'semantic',
    timestamp: Date.now(),
    confidence,
    tags,
    source: 'observation',
    provenance: {
      source: 'observation',
      actor: 'sara',
      evidence,
      verified: confidence > 0.8,
    },
    metadata: {},
    fact: {
      statement,
      category,
      assertions: [
        {
          statement,
          confidence,
          supporting: evidence,
          contradicting: [],
        },
      ],
      supportingEvidence: evidence,
      contradictingEvidence: [],
    },
  };
}

export function createPreferenceMemory(
  key: string,
  value: any,
  category: string,
  appliesTo: string[] = [],
  confidence: number = 0.8,
  tags: string[] = []
): PreferenceMemory {
  return {
    id: `mem-pref-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    type: 'preference',
    timestamp: Date.now(),
    confidence,
    tags,
    source: 'user_input',
    provenance: {
      source: 'user_input',
      actor: 'user',
      evidence: [`Preference set for ${key}`],
      verified: true,
    },
    metadata: {},
    preference: {
      key,
      value,
      category,
      appliesTo,
      overrides: [],
      learnedFrom: [],
      exceptions: [],
    },
  };
}

export function createFailureMemory(
  taskId: string,
  taskType: string,
  goal: string,
  failureType: string,
  strategy: string,
  rootCause: string,
  suggestedAlternative: string,
  tags: string[] = []
): FailureMemory {
  return {
    id: `mem-fail-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    type: 'failure',
    timestamp: Date.now(),
    confidence: 0.95,
    tags,
    source: 'observation',
    provenance: {
      source: 'observation',
      actor: 'sara',
      taskId,
      evidence: [`Failed task ${taskId}`],
      verified: true,
    },
    metadata: {},
    failure: {
      taskId,
      taskType,
      goal,
      failureType,
      strategy,
      outcome: 'failed',
      rootCause,
      failureTime: Date.now(),
      consequences: [],
      suggestedAlternative,
      repeated: false,
      repeatCount: 1,
      lastOccurrence: Date.now(),
    },
  };
}

export function createAchievementMemory(
  taskId: string,
  taskType: string,
  goal: string,
  successStrategy: string,
  executionTime: number,
  attempts: number,
  verificationQuality: number,
  evidence: string[],
  reusable: boolean = true,
  tags: string[] = []
): AchievementMemory {
  return {
    id: `mem-ach-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    type: 'achievement',
    timestamp: Date.now(),
    confidence: Math.min(1.0, 0.8 + 0.1 * verificationQuality),
    tags,
    source: 'observation',
    provenance: {
      source: 'observation',
      actor: 'sara',
      taskId,
      evidence,
      verified: true,
    },
    metadata: {},
    achievement: {
      taskId,
      taskType,
      goal,
      successStrategy,
      executionTime,
      attempts,
      verificationQuality,
      reusable,
      conditions: new Map(),
      evidence,
    },
  };
}

export function createAutobiographicalMemory(
  category: 'capability' | 'interaction' | 'learning' | 'limitation' | 'personality' | 'relationship',
  description: string,
  importance: number,
  tags: string[] = []
): AutobiographicalMemory {
  return {
    id: `mem-auto-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    type: 'autobiographical',
    timestamp: Date.now(),
    confidence: 0.95,
    tags,
    source: 'learning',
    provenance: {
      source: 'learning',
      actor: 'sara',
      evidence: [description],
      verified: true,
    },
    metadata: {},
    autobiography: {
      category,
      description,
      timeRange: {
        start: Date.now(),
      },
      relatedMemories: [],
      importanceScore: importance,
      recurring: false,
    },
  };
}

export function createMemoryStore(): MemoryStore {
  return {
    episodic: new Map(),
    semantic: new Map(),
    procedural: new Map(),
    preference: new Map(),
    failure: new Map(),
    achievement: new Map(),
    autobiographical: new Map(),
    createdAt: Date.now(),
    lastAccessed: Date.now(),
  };
}
