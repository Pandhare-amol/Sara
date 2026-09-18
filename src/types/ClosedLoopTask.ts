/**
 * Task Planning and Execution Model
 * Supports hierarchical planning, replanning, recovery, and closed-loop execution
 */

import type { WorldState, Observation } from './WorldState';
import type { AuthoritativeTaskResult } from './AuthoritativeTaskResult';

export type TaskExecutionState =
  | 'CREATED'
  | 'PLANNING'
  | 'EXECUTING'
  | 'WAITING'
  | 'OBSERVING'
  | 'VERIFYING'
  | 'RECOVERING'
  | 'REPLANNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED'
  | 'CANCELLED';

export const TASK_TERMINAL_STATES: Set<TaskExecutionState> = new Set([
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
]);

export interface Goal {
  id: string;
  description: string;
  priority: 'critical' | 'high' | 'normal' | 'low';
  context: Record<string, any>;
  authorityLevel: AuthorityLevel;
}

export interface Subgoal {
  id: string;
  parentGoalId: string;
  description: string;
  preconditions: Condition[];
  expectedEffect: string;
  expectedEffectObservable: boolean;
  skills: Skill[];
  recovery: RecoveryStrategy[];
  status: TaskExecutionState;
  order: number;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  preconditions: Condition[];
  actions: Action[];
  expectedEffect: string;
  verification: VerificationStep[];
  failureModes: FailureMode[];
  recovery: RecoveryStrategy[];
  successHistory: {
    count: number;
    averageDuration: number;
    lastUsed: number;
  };
  failureHistory: {
    count: number;
    lastFailed: number;
  };
  confidence: number; // 0.0 to 1.0
  estimatedDuration: number; // milliseconds
  authorityLevel: AuthorityLevel;
}

export interface Action {
  id: string;
  type: ActionType;
  target?: string;
  parameters: Record<string, any>;
  expectedEffect?: string;
  verification?: VerificationStep;
  timeoutMs: number;
  retryable: boolean;
  maxRetries: number;
  authorityLevel: AuthorityLevel;
}

export type ActionType =
  | 'mouse_move'
  | 'mouse_click'
  | 'mouse_double_click'
  | 'mouse_right_click'
  | 'mouse_drag'
  | 'mouse_scroll'
  | 'keyboard_type'
  | 'keyboard_press'
  | 'keyboard_hotkey'
  | 'keyboard_hold'
  | 'keyboard_release'
  | 'focus_window'
  | 'open_application'
  | 'close_application'
  | 'switch_application'
  | 'select_text'
  | 'copy'
  | 'paste'
  | 'screenshot'
  | 'ocr'
  | 'wait'
  | 'condition_check'
  | 'custom';

export interface Condition {
  id: string;
  description: string;
  check: (worldState: WorldState) => boolean;
  confidence: number;
  timeout?: number;
}

export interface VerificationStep {
  id: string;
  description: string;
  check: (worldState: WorldState, previousWorldState?: WorldState) => VerificationResult;
  timeout: number;
  confidence: number;
  required: boolean;
}

export interface VerificationResult {
  passed: boolean;
  confidence: number;
  evidence: Observation[];
  duration: number;
  details?: string;
}

export interface FailureMode {
  type: string;
  description: string;
  pattern: (error: Error | string) => boolean;
  severity: 'critical' | 'high' | 'medium' | 'low';
  recoveryable: boolean;
}

export interface RecoveryStrategy {
  id: string;
  failureMode: string;
  description: string;
  preconditions: Condition[];
  actions: Action[];
  expectedEffect: string;
  verification: VerificationStep[];
  priority: number;
  successRate: number;
  estimatedDuration: number;
}

export interface Plan {
  id: string;
  taskId: string;
  goalId: string;
  version: number;
  createdAt: number;
  subgoals: Subgoal[];
  estimatedDuration: number;
  confidence: number;
  status: 'active' | 'paused' | 'replaced' | 'archived';
}

export interface ExecutionLog {
  taskId: string;
  timestamp: number;
  eventType: ExecutionEventType;
  action?: Action;
  observation?: Observation;
  worldState?: WorldState;
  error?: string;
  recovery?: RecoveryStrategy;
  details?: Record<string, any>;
}

export type ExecutionEventType =
  | 'TASK_CREATED'
  | 'PLAN_CREATED'
  | 'CRITIC_REJECTED'
  | 'ACTION_STARTED'
  | 'ACTION_COMPLETED'
  | 'ACTION_FAILED'
  | 'OBSERVATION_CAPTURED'
  | 'VERIFICATION_STARTED'
  | 'VERIFICATION_PASSED'
  | 'VERIFICATION_FAILED'
  | 'RECOVERY_STARTED'
  | 'RECOVERY_COMPLETED'
  | 'RECOVERY_FAILED'
  | 'REPLAN_STARTED'
  | 'REPLAN_COMPLETED'
  | 'MEMORY_RETRIEVED'
  | 'SKILL_SELECTED'
  | 'STRATEGY_SELECTED'
  | 'TASK_COMPLETED'
  | 'TASK_FAILED'
  | 'TASK_PAUSED'
  | 'TASK_RESUMED'
  | 'TASK_CANCELLED';

export interface ClosedLoopTask {
  id: string;
  goal: Goal;
  plan?: Plan;
  currentState: TaskExecutionState;
  startTime: number;
  endTime?: number;
  currentSubgoalIndex: number;
  currentPlanVersion: number;
  executionLog: ExecutionLog[];
  currentWorldState?: WorldState;
  previousWorldState?: WorldState;
  totalAttempts: number;
  totalRecoveries: number;
  totalReplans: number;
  checkpoints: TaskCheckpoint[];
  authoritative?: AuthoritativeTaskResult;
  metadata: Record<string, any>;
}

export interface TaskCheckpoint {
  id: string;
  timestamp: number;
  state: TaskExecutionState;
  subgoalIndex: number;
  worldState: WorldState;
  canResume: boolean;
  reason: string;
}

export type AuthorityLevel = 'OBSERVE' | 'LOW_RISK' | 'NORMAL' | 'SENSITIVE' | 'HIGH_RISK' | 'DESTRUCTIVE';

export interface AuthorityRequest {
  taskId: string;
  action: Action;
  reason: string;
  confidence: number;
  riskLevel: AuthorityLevel;
  requiresUserConfirmation: boolean;
}

export interface ReplanTrigger {
  reason: string;
  expectedState: Record<string, any>;
  observedState: Record<string, any>;
  confidence: number;
  suggestedRecoveries: RecoveryStrategy[];
}

export function createClosedLoopTask(goal: Goal): ClosedLoopTask {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    goal,
    currentState: 'CREATED',
    startTime: Date.now(),
    currentSubgoalIndex: 0,
    currentPlanVersion: 0,
    executionLog: [],
    totalAttempts: 0,
    totalRecoveries: 0,
    totalReplans: 0,
    checkpoints: [],
    metadata: {},
  };
}

export function isTerminalState(state: TaskExecutionState): boolean {
  return TASK_TERMINAL_STATES.has(state);
}

export function canTransitionTo(from: TaskExecutionState, to: TaskExecutionState): boolean {
  // Terminal states cannot transition to any non-terminal state
  if (TASK_TERMINAL_STATES.has(from) && !TASK_TERMINAL_STATES.has(to)) {
    return false;
  }

  // Define valid state transitions
  const validTransitions: Record<TaskExecutionState, Set<TaskExecutionState>> = {
    CREATED: new Set(['PLANNING', 'CANCELLED']),
    PLANNING: new Set(['EXECUTING', 'WAITING', 'REPLANNING', 'FAILED', 'CANCELLED']),
    EXECUTING: new Set(['OBSERVING', 'WAITING', 'VERIFYING', 'RECOVERING', 'REPLANNING', 'PAUSED', 'FAILED', 'CANCELLED']),
    WAITING: new Set(['OBSERVING', 'EXECUTING', 'CANCELLED', 'FAILED']),
    OBSERVING: new Set(['VERIFYING', 'EXECUTING', 'REPLANNING', 'FAILED', 'CANCELLED']),
    VERIFYING: new Set(['COMPLETED', 'PARTIAL', 'FAILED', 'RECOVERING', 'REPLANNING']),
    RECOVERING: new Set(['REPLANNING', 'EXECUTING', 'FAILED', 'CANCELLED']),
    REPLANNING: new Set(['EXECUTING', 'FAILED', 'CANCELLED']),
    PAUSED: new Set(['EXECUTING', 'CANCELLED']),
    COMPLETED: new Set([]),
    PARTIAL: new Set([]),
    FAILED: new Set([]),
    CANCELLED: new Set([]),
  };

  const allowed = validTransitions[from] || new Set();
  return allowed.has(to);
}
