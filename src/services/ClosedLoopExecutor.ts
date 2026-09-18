/**
 * Closed-Loop Autonomous Execution Engine
 * Implements: OBSERVE → UNDERSTAND → PLAN → ACT → OBSERVE → VERIFY → SUCCESS/RECOVER/REPLAN
 */

import type {
  ClosedLoopTask,
  TaskExecutionState,
  Goal,
  Plan,
  Subgoal,
  Skill,
  Action,
  ExecutionLog,
  ExecutionEventType,
  RecoveryStrategy,
  ReplanTrigger,
} from '../types/ClosedLoopTask';
import { isTerminalState, canTransitionTo, createClosedLoopTask } from '../types/ClosedLoopTask';
import type { WorldState, Observation } from '../types/WorldState';
import { createEmptyWorldState, createObservation } from '../types/WorldState';
import { screenPerception } from './ScreenPerceptionEngine';
import type { LearningWorkflowCoordinator } from './LearningWorkflowCoordinator';
import type { MemoryStore } from '../types/Memory';
import { callDesktopAgent } from '../../desktop_agent_bridge';
import { getMultiAgentCoordinator } from '../cognitive/multiAgentCoordinator';
import type { PlanStep } from '../cognitive/types';
import { getTaskEvaluator } from '../cognitive/evaluator';

export interface ExecutionOptions {
  maxRetries?: number;
  maxRecoveries?: number;
  maxReplans?: number;
  enableRecovery?: boolean;
  enableReplanning?: boolean;
  verificationRequired?: boolean;
  pauseOnFailure?: boolean;
  timeoutMs?: number;
}

export interface ExecutionResult {
  taskId: string;
  finalState: TaskExecutionState;
  success: boolean;
  duration: number;
  totalActions: number;
  totalObservations: number;
  totalRecoveries: number;
  totalReplans: number;
  evidence: Observation[];
  error?: string;
  executionLog: ExecutionLog[];
}

export class ClosedLoopExecutor {
  private tasks: Map<string, ClosedLoopTask> = new Map();
  private executionLogs: Map<string, ExecutionLog[]> = new Map();
  private worldStates: Map<string, WorldState[]> = new Map();
  private learningWorkflow?: LearningWorkflowCoordinator;
  private memoryStore?: MemoryStore;
  private defaultOptions: ExecutionOptions = {
    maxRetries: 3,
    maxRecoveries: 5,
    maxReplans: 3,
    enableRecovery: true,
    enableReplanning: true,
    verificationRequired: true,
    pauseOnFailure: false,
    timeoutMs: 120000, // 2 minutes default
  };

  /**
   * Create a new closed-loop task from a goal
   */
  createTask(goal: Goal): ClosedLoopTask {
    const task = createClosedLoopTask(goal);
    this.tasks.set(task.id, task);
    this.executionLogs.set(task.id, []);
    this.worldStates.set(task.id, []);
    
    this.log(task.id, 'TASK_CREATED', {
      goalId: goal.id,
      goalDescription: goal.description,
    });

    return task;
  }

  /**
   * Wire in learning workflow coordinator
   */
  setLearningWorkflow(
    workflow: LearningWorkflowCoordinator,
    memoryStore: MemoryStore
  ): void {
    this.learningWorkflow = workflow;
    this.memoryStore = memoryStore;
  }

  /**
   * Execute a closed-loop task
   */
  async executeTask(
    taskId: string,
    options?: ExecutionOptions
  ): Promise<ExecutionResult> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return {
        taskId,
        finalState: 'FAILED',
        success: false,
        duration: 0,
        totalActions: 0,
        totalObservations: 0,
        totalRecoveries: 0,
        totalReplans: 0,
        evidence: [],
        error: 'Task not found',
        executionLog: [],
      };
    }

    const opts = { ...this.defaultOptions, ...options };
    const startTime = Date.now();

    try {
      // Main execution loop
      await this.transitionState(task, 'PLANNING');
      
      // Generate or retrieve plan
      if (!task.plan) {
        task.plan = await this.planTask(task);
        this.log(task.id, 'PLAN_CREATED', {
          planId: task.plan.id,
          subgoals: task.plan.subgoals.length,
        });
      }

      const criticApproved = await this.reviewPlanBeforeExecution(task);
      if (!criticApproved) {
        getTaskEvaluator().recordCriticOutcome(true, false);
        await this.transitionState(task, 'FAILED');
        task.endTime = Date.now();
        return {
          taskId,
          finalState: task.currentState,
          success: false,
          duration: task.endTime - startTime,
          totalActions: 0,
          totalObservations: 0,
          totalRecoveries: task.totalRecoveries,
          totalReplans: task.totalReplans,
          evidence: [],
          error: String(task.metadata.criticFailure || 'Critic rejected the plan after two re-plan attempts'),
          executionLog: this.executionLogs.get(task.id) || [],
        };
      }

      // Execute subgoals
      while (task.currentSubgoalIndex < task.plan.subgoals.length) {
        const subgoal = task.plan.subgoals[task.currentSubgoalIndex];
        
        const result = await this.executeSubgoal(
          task,
          subgoal,
          opts
        );

        if (!result.success) {
          if (opts.enableRecovery && task.totalRecoveries < (opts.maxRecoveries || 5)) {
            const recovered = await this.attemptRecovery(task, subgoal, opts);
            if (recovered) {
              task.totalRecoveries++;
              continue;
            }
          }

          if (opts.enableReplanning && task.totalReplans < (opts.maxReplans || 3)) {
            const replanned = await this.attemptReplan(task, subgoal, opts);
            if (replanned) {
              task.totalReplans++;
              continue;
            }
          }

          // Unrecoverable failure
          await this.transitionState(task, 'FAILED');
          break;
        }

        task.currentSubgoalIndex++;
      }

      // Verify final state
      if (task.currentState !== 'FAILED') {
        await this.transitionState(task, 'VERIFYING');
        const verified = await this.verifyTaskCompletion(task);
        
        if (verified) {
          await this.transitionState(task, 'COMPLETED');
        } else if (opts.enableRecovery) {
          await this.transitionState(task, 'RECOVERING');
          const recovered = await this.attemptFinalRecovery(task, opts);
          if (recovered) {
            await this.transitionState(task, 'COMPLETED');
          } else {
            await this.transitionState(task, 'PARTIAL');
          }
        } else {
          await this.transitionState(task, 'PARTIAL');
        }
      }

      task.endTime = Date.now();
      const duration = task.endTime - task.startTime;

      // Trigger learning after task completion
      if (this.learningWorkflow && this.memoryStore && task.currentState) {
        try {
          await this.learningWorkflow.processTaskCompletion(task, duration, this.memoryStore);
        } catch (learningError) {
          console.error('[ClosedLoopExecutor] Error in learning workflow:', learningError);
        }
      }

      return {
        taskId,
        finalState: task.currentState,
        success: task.currentState === 'COMPLETED',
        duration,
        totalActions: this.countActionsInLog(task.id),
        totalObservations: this.countObservationsInLog(task.id),
        totalRecoveries: task.totalRecoveries,
        totalReplans: task.totalReplans,
        evidence: task.currentWorldState?.observations || [],
        executionLog: this.executionLogs.get(task.id) || [],
      };
    } catch (error) {
      await this.transitionState(task, 'FAILED');
      task.endTime = Date.now();

      return {
        taskId,
        finalState: 'FAILED',
        success: false,
        duration: Date.now() - startTime,
        totalActions: this.countActionsInLog(task.id),
        totalObservations: this.countObservationsInLog(task.id),
        totalRecoveries: task.totalRecoveries,
        totalReplans: task.totalReplans,
        evidence: task.currentWorldState?.observations || [],
        error: String(error),
        executionLog: this.executionLogs.get(task.id) || [],
      };
    }
  }

  /**
   * Execute a single subgoal
   */
  private async executeSubgoal(
    task: ClosedLoopTask,
    subgoal: Subgoal,
    options: ExecutionOptions
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.transitionState(task, 'EXECUTING');

      // Check preconditions
      for (const condition of subgoal.preconditions) {
        const worldState = task.currentWorldState || (await this.observeWorld(task));
        if (!condition.check(worldState)) {
          return {
            success: false,
            error: `Precondition not met: ${condition.description}`,
          };
        }
      }

      // Execute skills
      for (const skill of subgoal.skills) {
        const result = await this.executeSkill(task, skill, options);
        if (!result.success) {
          return result;
        }
      }

      // Verify effect
      await this.transitionState(task, 'OBSERVING');
      const worldState = await this.observeWorld(task);

      await this.transitionState(task, 'VERIFYING');
      const verified = await this.verifyExpectedEffect(subgoal.expectedEffect, worldState);

      if (!verified && options.verificationRequired) {
        return {
          success: false,
          error: `Verification failed for subgoal: ${subgoal.description}`,
        };
      }

      this.log(task.id, 'VERIFICATION_PASSED', {
        subgoalId: subgoal.id,
        expectedEffect: subgoal.expectedEffect,
      });

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Execute a skill
   */
  private async executeSkill(
    task: ClosedLoopTask,
    skill: Skill,
    options: ExecutionOptions
  ): Promise<{ success: boolean; error?: string }> {
    this.log(task.id, 'SKILL_SELECTED', {
      skillId: skill.id,
      skillName: skill.name,
    });

    try {
      for (const action of skill.actions) {
        const result = await this.executeAction(task, action, options);
        if (!result.success) {
          return result;
        }
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Execute a single action
   */
  private async executeAction(
    task: ClosedLoopTask,
    action: Action,
    options: ExecutionOptions
  ): Promise<{ success: boolean; error?: string }> {
    this.log(task.id, 'ACTION_STARTED', {
      actionId: action.id,
      actionType: action.type,
      target: action.target,
    });

    const startTime = Date.now();
    let lastError: string | undefined;
    let attemptCount = 0;
    const maxAttempts = action.retryable ? (action.maxRetries || 1) : 1;

    while (attemptCount < maxAttempts) {
      try {
        // Execute the action via the desktop agent bridge
        const result = await this.executeActionViaDesktopAgent(action);

        if (result.success) {
          this.log(task.id, 'ACTION_COMPLETED', {
            actionId: action.id,
            duration: Date.now() - startTime,
          });
          return { success: true };
        }

        lastError = result.error;
        attemptCount++;
      } catch (error) {
        lastError = String(error);
        attemptCount++;
      }

      if (attemptCount < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 500)); // backoff
      }
    }

    this.log(task.id, 'ACTION_FAILED', {
      actionId: action.id,
      error: lastError,
      attempts: attemptCount,
    });

    return {
      success: false,
      error: lastError || 'Action execution failed',
    };
  }

  /**
   * Execute action via desktop agent bridge
   */
  private async executeActionViaDesktopAgent(action: Action): Promise<{
    success: boolean;
    result?: any;
    error?: string;
  }> {
    try {
      const toolByAction: Partial<Record<Action['type'], string>> = {
        mouse_move: 'mouseMove',
        mouse_click: 'mouseClick',
        mouse_double_click: 'mouseDoubleClick',
        mouse_right_click: 'mouseRightClick',
        mouse_drag: 'hardwareMouseDrag',
        mouse_scroll: 'mouseScroll',
        keyboard_type: 'keyboardType',
        keyboard_press: 'keyPress',
        keyboard_hotkey: 'keyPress',
        keyboard_hold: 'keyDown',
        keyboard_release: 'keyUp',
        focus_window: 'focusWindow',
        open_application: 'openApplication',
        close_application: 'closeApplication',
        switch_application: 'switchApplication',
        select_text: 'copySelected',
        copy: 'copySelected',
        paste: 'pasteClipboard',
        screenshot: 'takeScreenshot',
      };
      const tool = toolByAction[action.type];
      if (!tool) {
        return { success: false, error: `Action type not supported: ${action.type}` };
      }

      const result = await callDesktopAgent(tool, action.parameters || {});
      return {
        success: result.ok,
        result: result.result,
        error: result.error,
      };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  }

  private async reviewPlanBeforeExecution(task: ClosedLoopTask): Promise<boolean> {
    const critic = getMultiAgentCoordinator();
    const maxCriticReplans = 2;

    for (let attempt = 0; attempt <= maxCriticReplans; attempt++) {
      const review = critic.reviewPlan(this.toCriticPlan(task));
      if (review.approved) {
        return true;
      }

      const rejection = [review.reason, ...(review.requiredChanges || [])].filter(Boolean).join(' ');
      task.metadata.criticRejectionCount = (task.metadata.criticRejectionCount || 0) + 1;
      task.metadata.criticFailure = rejection;
      this.log(task.id, 'CRITIC_REJECTED', {
        reason: review.reason,
        requiredChanges: review.requiredChanges || [],
        attempt,
      });

      if (attempt === maxCriticReplans) {
        return false;
      }

      task.metadata.criticRejectionContext = rejection;
      const replanned = await this.attemptCriticReplan(task, rejection);
      if (!replanned) {
        return false;
      }
    }

    return false;
  }

  private toCriticPlan(task: ClosedLoopTask): PlanStep[] {
    const steps: PlanStep[] = [];
    for (const subgoal of task.plan?.subgoals || []) {
      for (const skill of subgoal.skills) {
        for (const action of skill.actions) {
          steps.push({
            id: action.id,
            index: steps.length,
            goal: skill.description,
            action: action.type,
            tool: action.type,
            args: action.parameters,
            expectedEffect: action.expectedEffect || skill.expectedEffect || subgoal.expectedEffect,
            critical: true,
            verifiable: Boolean(action.expectedEffect || skill.expectedEffect || subgoal.expectedEffect),
          });
        }
      }
      if (subgoal.skills.length === 0) {
        steps.push({
          id: subgoal.id,
          index: steps.length,
          goal: subgoal.description,
          action: 'subgoal',
          expectedEffect: subgoal.expectedEffect,
          critical: true,
          verifiable: subgoal.expectedEffectObservable,
        });
      }
    }

    const metadata = task.plan as typeof task.plan & {
      reasoning?: { risks?: string[]; fallbacks?: string[] };
    };
    const criticPlan = steps as PlanStep[] & {
      confidence?: number;
      reasoning?: { risks?: string[]; fallbacks?: string[] };
    };
    criticPlan.confidence = task.plan?.confidence;
    criticPlan.reasoning = metadata?.reasoning || task.metadata.planReasoning || { risks: [], fallbacks: [] };
    return criticPlan;
  }

  private async attemptCriticReplan(task: ClosedLoopTask, rejectionReason: string): Promise<boolean> {
    await this.transitionState(task, 'REPLANNING');
    try {
      this.log(task.id, 'REPLAN_STARTED', {
        planVersion: task.currentPlanVersion + 1,
        context: rejectionReason,
        trigger: 'critic_rejection',
      });
      const newPlan = await this.planTask(task, {
        version: task.currentPlanVersion + 1,
        context: rejectionReason,
      });
      task.plan = newPlan;
      task.currentPlanVersion++;
      this.log(task.id, 'REPLAN_COMPLETED', {
        newPlanId: newPlan.id,
        trigger: 'critic_rejection',
      });
      return true;
    } catch (error) {
      this.log(task.id, 'ACTION_FAILED', { error: String(error), context: 'critic-replan' });
      return false;
    }
  }

  /**
   * Observe current world state
   */
  private async observeWorld(task: ClosedLoopTask): Promise<WorldState> {
    try {
      const result = await screenPerception.observeWorld();
      const worldState = task.currentWorldState || createEmptyWorldState();
      
      if (result.observations) {
        worldState.observations.push(...result.observations);
      }

      task.previousWorldState = task.currentWorldState;
      task.currentWorldState = worldState;

      const states = this.worldStates.get(task.id) || [];
      states.push(worldState);
      this.worldStates.set(task.id, states);

      this.log(task.id, 'OBSERVATION_CAPTURED', {
        observationCount: result.observations?.length || 0,
      });

      return worldState;
    } catch (error) {
      return task.currentWorldState || createEmptyWorldState();
    }
  }

  /**
   * Verify expected effect occurred
   */
  private async verifyExpectedEffect(expectedEffect: string, worldState: WorldState): Promise<boolean> {
    // In production, parse expectedEffect and check worldState
    // This is a placeholder
    return worldState.observations.length > 0;
  }

  /**
   * Verify task completion
   */
  private async verifyTaskCompletion(task: ClosedLoopTask): Promise<boolean> {
    // In production, verify the complete goal was achieved
    const worldState = task.currentWorldState || (await this.observeWorld(task));
    const verified = worldState.observations.length > 0;
    if (task.metadata.criticRejectionCount > 0) {
      task.metadata.criticRejectionJustified = verified;
      getTaskEvaluator().recordCriticOutcome(true, verified);
    }
    return verified;
  }

  /**
   * Attempt recovery for a failed subgoal
   */
  private async attemptRecovery(
    task: ClosedLoopTask,
    subgoal: Subgoal,
    options: ExecutionOptions
  ): Promise<boolean> {
    await this.transitionState(task, 'RECOVERING');

    try {
      // Select recovery strategy
      const worldState = task.currentWorldState || (await this.observeWorld(task));
      const strategy = this.selectRecoveryStrategy(subgoal.recovery, worldState);

      if (!strategy) {
        return false;
      }

      this.log(task.id, 'RECOVERY_STARTED', {
        subgoalId: subgoal.id,
        strategyId: strategy.id,
      });

      // Execute recovery
      for (const action of strategy.actions) {
        const result = await this.executeAction(task, action, options);
        if (!result.success) {
          return false;
        }
      }

      this.log(task.id, 'RECOVERY_COMPLETED', {
        strategyId: strategy.id,
      });

      return true;
    } catch (error) {
      this.log(task.id, 'RECOVERY_FAILED', {
        error: String(error),
      });
      return false;
    }
  }

  /**
   * Attempt replanning
   */
  private async attemptReplan(
    task: ClosedLoopTask,
    subgoal: Subgoal,
    options: ExecutionOptions
  ): Promise<boolean> {
    await this.transitionState(task, 'REPLANNING');

    try {
      this.log(task.id, 'REPLAN_STARTED', {
        subgoalId: subgoal.id,
        planVersion: task.currentPlanVersion + 1,
      });

      // Generate alternative plan
      const newPlan = await this.planTask(task, { version: task.currentPlanVersion + 1 });
      if (!newPlan) {
        return false;
      }

      task.plan = newPlan;
      task.currentPlanVersion++;
      task.currentSubgoalIndex = 0; // reset to restart

      this.log(task.id, 'REPLAN_COMPLETED', {
        newPlanId: newPlan.id,
        newSubgoals: newPlan.subgoals.length,
      });

      return true;
    } catch (error) {
      this.log(task.id, 'ACTION_FAILED', {
        error: String(error),
        context: 'replan',
      });
      return false;
    }
  }

  /**
   * Attempt final recovery if verification failed
   */
  private async attemptFinalRecovery(
    task: ClosedLoopTask,
    options: ExecutionOptions
  ): Promise<boolean> {
    // Try to salvage the task with a recovery plan
    return true; // placeholder
  }

  /**
   * Generate a plan for a task
   */
  private async planTask(task: ClosedLoopTask, options?: { version?: number; context?: string }): Promise<Plan> {
    // In production, use an LLM or planning algorithm to break down goal into subgoals and skills
    const plan: Plan = {
      id: `plan-${Date.now()}`,
      taskId: task.id,
      goalId: task.goal.id,
      version: options?.version || 1,
      createdAt: Date.now(),
      subgoals: [],
      estimatedDuration: 0,
      confidence: 0.8,
      status: 'active',
    };

    if (options?.context) {
      task.metadata.lastReplanContext = options.context;
    }

    return plan;
  }

  /**
   * Select recovery strategy based on world state
   */
  private selectRecoveryStrategy(
    strategies: RecoveryStrategy[],
    worldState: WorldState
  ): RecoveryStrategy | null {
    // Sort by priority and check preconditions
    const viable = strategies
      .filter((s) => s.preconditions.every((c) => c.check(worldState)))
      .sort((a, b) => b.priority - a.priority);

    return viable[0] || null;
  }

  /**
   * Transition task to new state
   */
  private async transitionState(
    task: ClosedLoopTask,
    newState: TaskExecutionState
  ): Promise<boolean> {
    if (!canTransitionTo(task.currentState, newState)) {
      return false;
    }

    task.currentState = newState;
    
    // Map state transitions to proper event types
    const eventType: ExecutionEventType = 
      newState === 'COMPLETED' ? 'TASK_COMPLETED' :
      newState === 'FAILED' ? 'TASK_FAILED' :
      newState === 'PAUSED' ? 'TASK_PAUSED' :
      newState === 'EXECUTING' ? 'ACTION_STARTED' :
      'ACTION_COMPLETED';
    
    this.log(task.id, eventType, {
      from: task.currentState,
      to: newState,
    });

    return true;
  }

  /**
   * Log execution event
   */
  private log(taskId: string, eventType: ExecutionEventType, details?: any): void {
    const logs = this.executionLogs.get(taskId) || [];
    logs.push({
      taskId,
      timestamp: Date.now(),
      eventType,
      details,
    });
    this.executionLogs.set(taskId, logs);
  }

  /**
   * Count actions in execution log
   */
  private countActionsInLog(taskId: string): number {
    const logs = this.executionLogs.get(taskId) || [];
    return logs.filter((l) => l.eventType === 'ACTION_STARTED').length;
  }

  /**
   * Count observations in execution log
   */
  private countObservationsInLog(taskId: string): number {
    const logs = this.executionLogs.get(taskId) || [];
    return logs.filter((l) => l.eventType === 'OBSERVATION_CAPTURED').length;
  }

  /**
   * Get task
   */
  getTask(taskId: string): ClosedLoopTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get execution log
   */
  getExecutionLog(taskId: string): ExecutionLog[] {
    return this.executionLogs.get(taskId) || [];
  }

  /**
   * Get world state history
   */
  getWorldStateHistory(taskId: string): WorldState[] {
    return this.worldStates.get(taskId) || [];
  }

  /**
   * Pause task
   */
  async pauseTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    return this.transitionState(task, 'PAUSED');
  }

  /**
   * Resume task
   */
  async resumeTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.currentState !== 'PAUSED') return false;
    return this.transitionState(task, 'EXECUTING');
  }

  /**
   * Cancel task
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    return this.transitionState(task, 'CANCELLED');
  }
}

export const closedLoopExecutor = new ClosedLoopExecutor();
