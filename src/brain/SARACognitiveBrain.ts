/**
 * SARA Cognitive Brain
 * 
 * Central reasoning and decision-making engine for SARA.
 * 
 * Responsible for:
 * - Intent understanding (from voice or text)
 * - Context building (from memory + current state)
 * - Task planning and decomposition
 * - Agent selection and orchestration
 * - Decision making
 * - Confidence scoring
 * - Risk assessment
 * - Confirmation logic
 * 
 * The Brain is NOT a chatbot - it's an action-oriented reasoning system.
 * Every decision should lead to real world execution.
 */

import type { Goal, Plan, Subgoal, Skill } from '../types/ClosedLoopTask';
import type { MemoryStore } from '../types/Memory';
import type { AuthoritativeTaskResult } from '../types/AuthoritativeTaskResult';
import { MemoryService } from '../services/MemoryService';
import { AgentRegistry, getAgentRegistry } from '../services/AgentRegistry';
import { SkillLibrary } from '../services/SkillLibraryAndStrategyManager';

export interface Intent {
  action: string;
  target?: string;
  parameters: Record<string, any>;
  confidence: number;
  context: Record<string, any>;
}

export interface BrainDecision {
  intent: Intent;
  plan: Plan | null;
  selectedAgents: string[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  requiresConfirmation: boolean;
  reason: string;
  evidence: string[];
}

export interface BrainConfig {
  confidenceThreshold: number;
  riskThreshold: number; // require confirmation above this
  enableMemoryRetrieval: boolean;
  enableContextBuilding: boolean;
  enableExplanation: boolean;
}

export class SARACognitiveBrain {
  private memoryService: MemoryService;
  private registry: AgentRegistry;
  private skillLibrary: SkillLibrary;
  private config: BrainConfig;

  constructor(
    memoryService: MemoryService,
    skillLibrary: SkillLibrary,
    config: Partial<BrainConfig> = {}
  ) {
    this.memoryService = memoryService;
    this.registry = getAgentRegistry();
    this.skillLibrary = skillLibrary;
    this.config = {
      confidenceThreshold: config.confidenceThreshold ?? 0.6,
      riskThreshold: config.riskThreshold ?? 0.7,
      enableMemoryRetrieval: config.enableMemoryRetrieval ?? true,
      enableContextBuilding: config.enableContextBuilding ?? true,
      enableExplanation: config.enableExplanation ?? true,
    };
  }

  /**
   * Parse user input into intent
   * 
   * In a real system, this would use NLU models.
   * For now, pattern matching with learning from memory.
   */
  async parseIntent(userInput: string, memoryStore: MemoryStore): Promise<Intent> {
    console.log(`[Brain] Parsing intent from: "${userInput}"`);

    // Simple pattern matching - would be replaced with real NLU
    const intent: Intent = {
      action: this.extractAction(userInput),
      target: this.extractTarget(userInput),
      parameters: this.extractParameters(userInput),
      confidence: 0.7, // Would be from NLU model
      context: {},
    };

    // Add context from memory
    if (this.config.enableContextBuilding) {
      intent.context = await this.buildContext(userInput, memoryStore);
    }

    return intent;
  }

  /**
   * Make a decision about how to handle an intent
   * 
   * Returns: Should we execute? Which agents? What's the risk?
   */
  async makeDecision(
    intent: Intent,
    memoryStore: MemoryStore
  ): Promise<BrainDecision> {
    console.log(`[Brain] Making decision for intent: ${intent.action}`);

    // Retrieve relevant memories and skills
    let plan: Plan | null = null;
    const selectedAgents: string[] = [];
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
    const evidence: string[] = [];

    // Check confidence threshold
    if (intent.confidence < this.config.confidenceThreshold) {
      return {
        intent,
        plan: null,
        selectedAgents: [],
        riskLevel: 'HIGH',
        requiresConfirmation: true,
        reason: `Low confidence in intent interpretation (${intent.confidence.toFixed(2)})`,
        evidence: ['Intent confidence below threshold'],
      };
    }

    // Assess risk based on action type
    riskLevel = this.assessRisk(intent.action);
    evidence.push(`Risk level: ${riskLevel}`);

    // Select agents based on capability
    const requiredCapabilities = this.getRequiredCapabilities(intent.action);
    for (const cap of requiredCapabilities) {
      const agent = this.registry.findAgentWithCapability(cap);
      if (agent) {
        selectedAgents.push(agent.metadata.registration.agentId);
        evidence.push(`Selected agent: ${agent.metadata.registration.name}`);
      }
    }

    // Build plan from intent
    if (selectedAgents.length > 0) {
      plan = this.createPlan(intent, selectedAgents, memoryStore);
      evidence.push(`Plan created with ${plan.subgoals.length} subgoals`);
    }

    return {
      intent,
      plan,
      selectedAgents,
      riskLevel,
      requiresConfirmation: riskLevel === 'HIGH',
      reason: `Ready to execute. Risk: ${riskLevel}. Agents: ${selectedAgents.length}`,
      evidence,
    };
  }

  /**
   * Verify a completed task result
   * 
   * Returns: Is this result actually successful?
   */
  async verifyResult(
    result: AuthoritativeTaskResult,
    expectedOutcome: string
  ): Promise<{
    verified: boolean;
    confidence: number;
    reasoning: string;
  }> {
    console.log(`[Brain] Verifying task result: ${result.taskId}`);

    // Check if the result matches expected outcome
    let verified = result.verified && result.success;
    let confidence = 0.5;
    const reasoning: string[] = [];

    if (result.state === 'SUCCEEDED') {
      verified = true;
      confidence = 0.95;
      reasoning.push('Task reached SUCCEEDED state');
    } else if (result.state === 'PARTIAL') {
      verified = true;
      confidence = 0.7;
      reasoning.push('Task partially completed');
    } else {
      verified = false;
      confidence = 0.1;
      reasoning.push('Task did not complete');
    }

    // Check verification
    if (result.verification && result.verification.passed) {
      confidence += 0.05;
      reasoning.push(`Verification passed with ${result.verification.checks.length} checks`);
    } else {
      confidence -= 0.2;
      reasoning.push('Result not independently verified');
    }

    // Check execution actions
    if (result.actions && result.actions.length > 0) {
      confidence += 0.1;
      reasoning.push(`Actions executed: ${result.actions.length} items`);
    }

    confidence = Math.max(0, Math.min(1, confidence));

    return {
      verified,
      confidence,
      reasoning: reasoning.join('; '),
    };
  }

  /**
   * Generate voice response for user
   * 
   * Response must accurately reflect the actual result,
   * not make guesses about what happened.
   */
  async generateVoiceResponse(result: AuthoritativeTaskResult): Promise<string> {
    console.log(`[Brain] Generating voice response for task: ${result.taskId}`);

    let response = '';

    switch (result.state) {
      case 'SUCCEEDED':
        response = `Done. ${result.summary}`;
        if (result.verification.checks.length > 0) {
          response += ` I verified the result with ${result.verification.checks.length} checks.`;
        }
        break;

      case 'PARTIAL':
        response = `Partially completed. ${result.summary} Some parts didn't complete as expected.`;
        if (result.error) {
          response += ` The issue was: ${result.error.message}`;
        }
        break;

      case 'FAILED':
      case 'CANCELLED':
        response = `I couldn't complete the task. ${result.summary}`;
        if (result.error) {
          response += ` ${result.error.message}`;
        }
        break;

      case 'PLANNING':
      case 'RUNNING':
      case 'VERIFYING':
      default:
        response = `Task is still processing. Current state: ${result.state}.`;
    }

    return response;
  }

  // ============ PRIVATE HELPERS ============

  private extractAction(input: string): string {
    // Simple pattern matching - would be from NLU
    const lower = input.toLowerCase();
    if (lower.includes('open')) return 'open';
    if (lower.includes('close')) return 'close';
    if (lower.includes('search')) return 'search';
    if (lower.includes('find')) return 'find';
    if (lower.includes('send')) return 'send';
    if (lower.includes('click')) return 'click';
    if (lower.includes('type')) return 'type';
    if (lower.includes('download')) return 'download';
    return 'unknown';
  }

  private extractTarget(input: string): string | undefined {
    // Extract what the user is targeting
    const lower = input.toLowerCase();
    if (lower.includes('firefox')) return 'firefox';
    if (lower.includes('chrome')) return 'chrome';
    if (lower.includes('edge')) return 'edge';
    if (lower.includes('gmail')) return 'gmail';
    if (lower.includes('youtube')) return 'youtube';
    if (lower.includes('whatsapp')) return 'whatsapp';
    return undefined;
  }

  private extractParameters(input: string): Record<string, any> {
    // Extract parameters from input
    return {
      query: input, // fallback
    };
  }

  private async buildContext(input: string, memoryStore: MemoryStore): Promise<Record<string, any>> {
    // Retrieve relevant context from memory
    const context: Record<string, any> = {
      timestamp: Date.now(),
      userQuery: input,
    };

    // Would retrieve similar past tasks, preferences, etc.
    return context;
  }

  private assessRisk(action: string): 'LOW' | 'MEDIUM' | 'HIGH' {
    // Assess risk of an action
    const highRiskActions = ['delete', 'send', 'download', 'install', 'uninstall'];
    const mediumRiskActions = ['move', 'rename', 'close'];

    if (highRiskActions.some(a => action.includes(a))) return 'HIGH';
    if (mediumRiskActions.some(a => action.includes(a))) return 'MEDIUM';
    return 'LOW';
  }

  private getRequiredCapabilities(action: string): string[] {
    // Map actions to required agent capabilities
    const capabilityMap: Record<string, string[]> = {
      'open': ['application_launch', 'window_management'],
      'close': ['window_management', 'process_kill'],
      'search': ['browser_search', 'text_input'],
      'send': ['text_input', 'click'],
      'download': ['browser_download', 'file_management'],
      'click': ['mouse_control'],
      'type': ['keyboard_input'],
    };

    return capabilityMap[action] || [];
  }

  private createPlan(
    intent: Intent,
    selectedAgents: string[],
    memoryStore: MemoryStore
  ): Plan {
    // Create an execution plan for the intent
    const taskId = `task-${Date.now()}`;
    const plan: Plan = {
      id: `plan-${Date.now()}`,
      taskId: taskId,
      goalId: intent.action,
      subgoals: [
        {
          id: `subgoal-${Date.now()}`,
          parentGoalId: intent.action,
          description: `Execute ${intent.action}`,
          preconditions: [],
          expectedEffect: `${intent.action} completes`,
          expectedEffectObservable: true,
          skills: [],
          recovery: [],
          status: 'PLANNING',
          order: 0,
        },
      ],
      version: 1,
      createdAt: Date.now(),
      estimatedDuration: 5000,
      confidence: 0.8,
      status: 'active',
    };

    return plan;
  }
}

/**
 * Get or create singleton brain
 */
let brainInstance: SARACognitiveBrain | null = null;

export function getSARACognitiveBrain(
  memoryService: MemoryService,
  skillLibrary: SkillLibrary,
  config?: Partial<BrainConfig>
): SARACognitiveBrain {
  if (!brainInstance) {
    brainInstance = new SARACognitiveBrain(memoryService, skillLibrary, config);
  }
  return brainInstance;
}

export function createSARACognitiveBrain(
  memoryService: MemoryService,
  skillLibrary: SkillLibrary,
  config?: Partial<BrainConfig>
): SARACognitiveBrain {
  return new SARACognitiveBrain(memoryService, skillLibrary, config);
}
