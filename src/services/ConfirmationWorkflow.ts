/**
 * Confirmation Workflows
 * 
 * Manages user confirmation requests for high-risk operations.
 * 
 * Features:
 * - Risk-based confirmation thresholds
 * - User prompting and response collection
 * - Timeout handling
 * - Fallback strategies
 * - Audit logging of confirmations
 */

import type { BrainDecision } from '../brain/SARACognitiveBrain';

export type ConfirmationStatus = 'pending' | 'approved' | 'denied' | 'timeout' | 'cancelled';

export interface ConfirmationRequest {
  id: string;
  taskId: string;
  action: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  requiredConfirmation: boolean;
  userPrompt: string;
  urgency: 'low' | 'normal' | 'high';
  timeoutMs: number;
  createdAt: number;
  respondedAt?: number;
  response?: boolean;
  status: ConfirmationStatus;
  reason?: string;
}

export interface ConfirmationResponse {
  confirmationId: string;
  approved: boolean;
  respondedAt: number;
  responseTime: number;
  userInput?: string;
}

export class ConfirmationWorkflow {
  private pendingConfirmations: Map<string, ConfirmationRequest> = new Map();
  private confirmationHistory: ConfirmationRequest[] = [];
  private defaultTimeoutMs = 30000; // 30 seconds
  private config = {
    requireConfirmationForRisk: 'HIGH' as const,
    autoApproveAfterTimeout: false,
    logAllConfirmations: true,
    maxPendingConfirmations: 10,
  };

  constructor(config?: Partial<typeof ConfirmationWorkflow.prototype.config>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * Create a confirmation request from a brain decision
   */
  createConfirmationRequest(
    taskId: string,
    decision: BrainDecision,
    customPrompt?: string
  ): ConfirmationRequest {
    const confirmationId = `confirm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const userPrompt =
      customPrompt ||
      this.generatePrompt(decision.intent.action, decision.riskLevel, decision.reason);

    const request: ConfirmationRequest = {
      id: confirmationId,
      taskId,
      action: decision.intent.action,
      riskLevel: decision.riskLevel,
      requiredConfirmation: decision.requiresConfirmation,
      userPrompt,
      urgency: decision.riskLevel === 'HIGH' ? 'high' : 'normal',
      timeoutMs: this.getTimeoutForRisk(decision.riskLevel),
      createdAt: Date.now(),
      status: 'pending',
    };

    // Add to pending
    if (this.pendingConfirmations.size >= this.config.maxPendingConfirmations) {
      throw new Error(`Maximum pending confirmations (${this.config.maxPendingConfirmations}) reached`);
    }

    this.pendingConfirmations.set(confirmationId, request);

    console.log(`[ConfirmationWorkflow] Created confirmation request: ${confirmationId}`);
    console.log(`  Action: ${request.action}`);
    console.log(`  Risk: ${request.riskLevel}`);
    console.log(`  Prompt: ${request.userPrompt}`);
    console.log(`  Timeout: ${request.timeoutMs}ms`);

    return request;
  }

  /**
   * Request user confirmation and wait for response
   * 
   * In production, this would integrate with:
   * - Voice UI ("Should I proceed?")
   * - Screen display
   * - Keyboard/gesture input
   * - Mobile app notification
   */
  async requestConfirmation(
    request: ConfirmationRequest,
    responseProvider?: (prompt: string) => Promise<boolean>
  ): Promise<ConfirmationResponse> {
    const startTime = Date.now();
    
    console.log(`\n[ConfirmationWorkflow] Requesting confirmation`);
    console.log(`  ${request.userPrompt}`);
    console.log(`  (Timeout: ${request.timeoutMs}ms)`);

    let approved = false;
    let timedOut = false;

    // Use provided response provider (for testing/custom logic)
    if (responseProvider) {
      try {
        approved = await Promise.race([
          responseProvider(request.userPrompt),
          new Promise<boolean>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), request.timeoutMs)
          ),
        ]);
      } catch (error) {
        if ((error as Error).message === 'Timeout') {
          timedOut = true;
          console.log(`[ConfirmationWorkflow] ⏱️  Request timed out`);
        } else {
          throw error;
        }
      }
    } else {
      // Default: Auto-deny after timeout (no actual user)
      timedOut = true;
      approved = this.config.autoApproveAfterTimeout;
      console.log(`[ConfirmationWorkflow] ⏱️  Request timed out (auto: ${approved ? 'approved' : 'denied'})`);
    }

    const respondedAt = Date.now();
    const responseTime = respondedAt - startTime;

    // Update request
    request.respondedAt = respondedAt;
    request.response = approved;
    request.status = timedOut ? 'timeout' : approved ? 'approved' : 'denied';

    const response: ConfirmationResponse = {
      confirmationId: request.id,
      approved,
      respondedAt,
      responseTime,
    };

    // Log result
    if (this.config.logAllConfirmations) {
      this.confirmationHistory.push(request);
      console.log(`[ConfirmationWorkflow] ${approved ? '✅ APPROVED' : '❌ DENIED'} (${responseTime}ms)`);
    }

    // Remove from pending
    this.pendingConfirmations.delete(request.id);

    return response;
  }

  /**
   * Request confirmation interactively from terminal
   * (For testing/CLI scenarios)
   */
  async requestConfirmationInteractive(request: ConfirmationRequest): Promise<ConfirmationResponse> {
    // In real implementation, would use:
    // - Voice: Ask user verbally, listen for response
    // - Screen: Display prompt, wait for button click
    // - Terminal: Read stdin
    
    console.log(`\n[ConfirmationWorkflow] Interactive confirmation needed`);
    console.log(`  ${request.userPrompt}`);
    console.log(`  Type "yes" to approve or "no" to deny:`);

    // For now, simulate with timeout
    const approved = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        console.log('[ConfirmationWorkflow] No response (timeout) - denied');
        resolve(false);
      }, Math.min(request.timeoutMs, 5000)); // Cap at 5s for testing

      // In real implementation, would read from stdin here
      // And resolve based on user input
    });

    const respondedAt = Date.now();
    const responseTime = respondedAt - request.createdAt;

    request.respondedAt = respondedAt;
    request.response = approved;
    request.status = approved ? 'approved' : 'denied';

    if (this.config.logAllConfirmations) {
      this.confirmationHistory.push(request);
    }

    this.pendingConfirmations.delete(request.id);

    return {
      confirmationId: request.id,
      approved,
      respondedAt,
      responseTime,
    };
  }

  /**
   * Auto-approve based on conditions
   * (E.g., if within safe thresholds or task is recurring)
   */
  shouldAutoApprove(request: ConfirmationRequest): boolean {
    // Auto-approve LOW risk actions
    if (request.riskLevel === 'LOW') {
      console.log(`[ConfirmationWorkflow] Auto-approving LOW risk action`);
      return true;
    }

    // Could add more logic:
    // - If user has approved this action before
    // - If action is in recurring task schedule
    // - If confidence is very high
    // - If requested via trusted API

    return false;
  }

  /**
   * Generate user-friendly confirmation prompt
   */
  private generatePrompt(action: string, risk: string, reason: string): string {
    const actionPhrase = this.formatAction(action);
    const riskPhrase = risk === 'HIGH' ? 'This is a HIGH-risk action. ' : '';

    return `Should I ${actionPhrase}? ${riskPhrase}${reason}`;
  }

  /**
   * Format action into readable English
   */
  private formatAction(action: string): string {
    const phraseMap: Record<string, string> = {
      'open': 'open the application',
      'close': 'close the window',
      'click': 'click on that location',
      'type': 'type that text',
      'delete': 'delete that item',
      'send': 'send that message',
      'download': 'download that file',
      'install': 'install that program',
      'uninstall': 'uninstall that program',
      'move': 'move that file',
      'copy': 'copy that file',
      'search': 'search for that',
    };

    return phraseMap[action] || `${action} that action`;
  }

  /**
   * Get timeout based on risk level
   */
  private getTimeoutForRisk(risk: 'LOW' | 'MEDIUM' | 'HIGH'): number {
    switch (risk) {
      case 'LOW':
        return 10000; // 10 seconds for low risk
      case 'MEDIUM':
        return 20000; // 20 seconds for medium risk
      case 'HIGH':
        return 30000; // 30 seconds for high risk
    }
  }

  /**
   * Get pending confirmations
   */
  getPendingConfirmations(): ConfirmationRequest[] {
    return Array.from(this.pendingConfirmations.values());
  }

  /**
   * Get confirmation by ID
   */
  getConfirmation(id: string): ConfirmationRequest | undefined {
    return this.pendingConfirmations.get(id) || this.confirmationHistory.find(c => c.id === id);
  }

  /**
   * Get confirmation history
   */
  getHistory(limit?: number): ConfirmationRequest[] {
    if (limit) {
      return this.confirmationHistory.slice(-limit);
    }
    return [...this.confirmationHistory];
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    totalRequests: number;
    approved: number;
    denied: number;
    timedOut: number;
    pending: number;
    approvalRate: number;
    averageResponseTime: number;
    byRiskLevel: Record<string, number>;
  } {
    const all = [...this.confirmationHistory];
    const approved = all.filter(r => r.status === 'approved').length;
    const denied = all.filter(r => r.status === 'denied').length;
    const timedOut = all.filter(r => r.status === 'timeout').length;
    const pending = this.pendingConfirmations.size;

    const responseTimes = all
      .filter(r => r.respondedAt && r.createdAt)
      .map(r => (r.respondedAt || 0) - r.createdAt);

    const avgResponseTime =
      responseTimes.length > 0
        ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
        : 0;

    const byRiskLevel = {
      'LOW': all.filter(r => r.riskLevel === 'LOW').length,
      'MEDIUM': all.filter(r => r.riskLevel === 'MEDIUM').length,
      'HIGH': all.filter(r => r.riskLevel === 'HIGH').length,
    };

    return {
      totalRequests: all.length,
      approved,
      denied,
      timedOut,
      pending,
      approvalRate: all.length > 0 ? approved / all.length : 0,
      averageResponseTime: avgResponseTime,
      byRiskLevel,
    };
  }

  /**
   * Clear all confirmations
   */
  clear(): void {
    this.pendingConfirmations.clear();
    this.confirmationHistory = [];
    console.log('[ConfirmationWorkflow] Cleared all confirmations');
  }
}

/**
 * Get or create singleton confirmation workflow
 */
let workflowInstance: ConfirmationWorkflow | null = null;

export function getConfirmationWorkflow(): ConfirmationWorkflow {
  if (!workflowInstance) {
    workflowInstance = new ConfirmationWorkflow();
  }
  return workflowInstance;
}

export function createConfirmationWorkflow(
  config?: Partial<ConfirmationWorkflow['config']>
): ConfirmationWorkflow {
  return new ConfirmationWorkflow(config);
}
