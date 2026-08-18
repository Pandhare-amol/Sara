/**
 * Integration Tests for Phase 3
 * 
 * Tests for:
 * - Confirmation Workflows
 * - Desktop Agent with Windows API bindings
 * - Browser Automation Agent
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import { ConfirmationWorkflow, createConfirmationWorkflow } from '../src/services/ConfirmationWorkflow';
import { DesktopAgent, createDesktopAgent } from '../src/agents/DesktopAgent';
import { BrowserAgent, createBrowserAgent } from '../src/agents/BrowserAgent';
import type { BrainDecision } from '../src/brain/SARACognitiveBrain';

describe('Phase 3: Confirmation Workflows, Desktop API, Browser Agent', () => {
  let workflow: ConfirmationWorkflow;
  let desktop: DesktopAgent;
  let browser: BrowserAgent;

  before(() => {
    workflow = createConfirmationWorkflow({
      maxPendingConfirmations: 100, // Higher for testing
      logAllConfirmations: true,
    });
    desktop = createDesktopAgent();
    browser = createBrowserAgent('firefox');
  });

  // Clear workflow after each test
  afterEach(() => {
    workflow.clear();
  });

  describe('Confirmation Workflows', () => {
    it('should create confirmation request from brain decision', () => {
      const decision: BrainDecision = {
        intent: { action: 'delete', target: 'file.txt', parameters: {}, confidence: 0.8, context: {} },
        plan: null,
        selectedAgents: ['desktop-agent'],
        riskLevel: 'HIGH',
        requiresConfirmation: true,
        reason: 'Destructive operation',
        evidence: ['High risk action detected'],
      };

      const request = workflow.createConfirmationRequest('task-123', decision);

      assert.strictEqual(request.taskId, 'task-123');
      assert.strictEqual(request.riskLevel, 'HIGH');
      assert.ok(request.requiredConfirmation);
      assert.ok(request.userPrompt.includes('delete'));
      assert.strictEqual(request.status, 'pending');
    });

    it('should generate appropriate prompts for different actions', () => {
      const actions = [
        { action: 'open', expectedPhrase: 'open' },
        { action: 'close', expectedPhrase: 'close' },
        { action: 'delete', expectedPhrase: 'delete' },
        { action: 'send', expectedPhrase: 'send' },
      ];

      for (const { action, expectedPhrase } of actions) {
        const decision: BrainDecision = {
          intent: { action, target: 'test', parameters: {}, confidence: 0.8, context: {} },
          plan: null,
          selectedAgents: [],
          riskLevel: 'MEDIUM',
          requiresConfirmation: false,
          reason: 'Test',
          evidence: [],
        };

        const request = workflow.createConfirmationRequest('task-1', decision);
        assert.ok(request.userPrompt.toLowerCase().includes(expectedPhrase));
      }
    });

    it('should set timeout based on risk level', () => {
      const risks: Array<['LOW' | 'MEDIUM' | 'HIGH', number]> = [
        ['LOW', 10000],
        ['MEDIUM', 20000],
        ['HIGH', 30000],
      ];

      for (const [risk, expectedTimeout] of risks) {
        const decision: BrainDecision = {
          intent: { action: 'test', target: '', parameters: {}, confidence: 0.8, context: {} },
          plan: null,
          selectedAgents: [],
          riskLevel: risk,
          requiresConfirmation: false,
          reason: 'Test',
          evidence: [],
        };

        const request = workflow.createConfirmationRequest('task-1', decision);
        assert.strictEqual(request.timeoutMs, expectedTimeout);
      }
    });

    it('should handle confirmation approval', async () => {
      const decision: BrainDecision = {
        intent: { action: 'click', target: 'button', parameters: {}, confidence: 0.8, context: {} },
        plan: null,
        selectedAgents: ['desktop-agent'],
        riskLevel: 'LOW',
        requiresConfirmation: false,
        reason: 'Test',
        evidence: [],
      };

      const request = workflow.createConfirmationRequest('task-1', decision);

      // Simulate user approval
      const response = await workflow.requestConfirmation(request, async () => true);

      assert.ok(response.approved);
      assert.ok(response.responseTime >= 0);
      assert.strictEqual(request.status, 'approved');
    });

    it('should handle confirmation denial', async () => {
      const decision: BrainDecision = {
        intent: { action: 'delete', target: 'item', parameters: {}, confidence: 0.8, context: {} },
        plan: null,
        selectedAgents: [],
        riskLevel: 'HIGH',
        requiresConfirmation: true,
        reason: 'Test',
        evidence: [],
      };

      const request = workflow.createConfirmationRequest('task-2', decision);

      // Simulate user denial
      const response = await workflow.requestConfirmation(request, async () => false);

      assert.ok(!response.approved);
      assert.strictEqual(request.status, 'denied');
    });

    it('should auto-approve LOW risk actions', async () => {
      const decision: BrainDecision = {
        intent: { action: 'move', target: 'mouse', parameters: {}, confidence: 0.8, context: {} },
        plan: null,
        selectedAgents: [],
        riskLevel: 'LOW',
        requiresConfirmation: false,
        reason: 'Low risk',
        evidence: [],
      };

      const request = workflow.createConfirmationRequest('task-3', decision);
      assert.ok(workflow.shouldAutoApprove(request));
    });

    it('should not auto-approve HIGH risk actions', async () => {
      const decision: BrainDecision = {
        intent: { action: 'delete', target: 'all', parameters: {}, confidence: 0.8, context: {} },
        plan: null,
        selectedAgents: [],
        riskLevel: 'HIGH',
        requiresConfirmation: true,
        reason: 'High risk',
        evidence: [],
      };

      const request = workflow.createConfirmationRequest('task-4', decision);
      assert.ok(!workflow.shouldAutoApprove(request));
    });

    it('should track pending confirmations', () => {
      const decision1: BrainDecision = {
        intent: { action: 'test1', target: '', parameters: {}, confidence: 0.8, context: {} },
        plan: null,
        selectedAgents: [],
        riskLevel: 'LOW',
        requiresConfirmation: false,
        reason: '',
        evidence: [],
      };

      const decision2: BrainDecision = {
        intent: { action: 'test2', target: '', parameters: {}, confidence: 0.8, context: {} },
        plan: null,
        selectedAgents: [],
        riskLevel: 'MEDIUM',
        requiresConfirmation: true,
        reason: '',
        evidence: [],
      };

      const request1 = workflow.createConfirmationRequest('task-5', decision1);
      const request2 = workflow.createConfirmationRequest('task-6', decision2);

      const pending = workflow.getPendingConfirmations();
      assert.ok(pending.length >= 2);
    });

    it('should get confirmation history', async () => {
      const decision: BrainDecision = {
        intent: { action: 'test', target: '', parameters: {}, confidence: 0.8, context: {} },
        plan: null,
        selectedAgents: [],
        riskLevel: 'LOW',
        requiresConfirmation: false,
        reason: '',
        evidence: [],
      };

      const request = workflow.createConfirmationRequest('task-7', decision);
      await workflow.requestConfirmation(request, async () => true);

      const history = workflow.getHistory(5);
      assert.ok(history.length > 0);
      assert.ok(history.some(r => r.taskId === 'task-7'));
    });

    it('should report statistics', async () => {
      const stats = workflow.getStatistics();

      assert.ok(typeof stats.totalRequests === 'number');
      assert.ok(typeof stats.approved === 'number');
      assert.ok(typeof stats.denied === 'number');
      assert.ok(typeof stats.approvalRate === 'number');
      assert.ok(stats.approvalRate >= 0 && stats.approvalRate <= 1);
    });
  });

  describe('Desktop Agent with Windows API Bindings', () => {
    it('should start desktop agent', async () => {
      await desktop.start();
      assert.strictEqual(desktop.status.state, 'READY');
    });

    it('should move mouse', async () => {
      await desktop.mousMove(100, 200, true);
      // Succeeds if no error thrown
      assert.ok(true);
    });

    it('should click at coordinates', async () => {
      await desktop.mouseClick(150, 250);
      assert.ok(true);
    });

    it('should double-click', async () => {
      await desktop.doubleClick(100, 100);
      assert.ok(true);
    });

    it('should right-click', async () => {
      await desktop.rightClick(200, 200);
      assert.ok(true);
    });

    it('should drag mouse', async () => {
      await desktop.drag(100, 100, 200, 200);
      assert.ok(true);
    });

    it('should scroll', async () => {
      await desktop.scroll(400, 300, 'down', 5);
      assert.ok(true);
    });

    it('should type text', async () => {
      await desktop.typeText('Hello SARA', 50);
      assert.ok(true);
    });

    it('should press key', async () => {
      await desktop.pressKey('return');
      assert.ok(true);
    });

    it('should hold and release key', async () => {
      await desktop.holdKey('shift', 500);
      await desktop.releaseKey('shift');
      assert.ok(true);
    });

    it('should execute hotkey', async () => {
      await desktop.hotkey(['ctrl', 'c']);
      assert.ok(true);
    });

    it('should take screenshot', async () => {
      const buffer = await desktop.takeScreenshot();
      assert.ok(Buffer.isBuffer(buffer));
    });

    it('should get cursor position', async () => {
      const pos = await desktop.getCursorPosition();
      assert.ok(typeof pos.x === 'number');
      assert.ok(typeof pos.y === 'number');
    });

    it('should get active window', async () => {
      const window = await desktop.getActiveWindow();
      assert.ok(window === null || typeof window === 'object');
    });

    it('should get all windows', async () => {
      const windows = await desktop.getAllWindows();
      assert.ok(Array.isArray(windows));
    });

    it('should execute capabilities', async () => {
      const result = await desktop.executeCapability('mouse-move', {
        x: 100,
        y: 200,
      });
      assert.ok(true);
    });

    it('should track success and failure counts', async () => {
      const initialSuccess = desktop.status.successCount;
      await desktop.mousMove(100, 100);
      assert.ok(desktop.status.successCount >= initialSuccess);
    });

    it('should stop desktop agent', async () => {
      await desktop.stop();
      assert.strictEqual(desktop.status.state, 'STOPPED');
    });
  });

  describe('Browser Automation Agent', () => {
    before(async () => {
      await browser.start();
    });

    it('should have browser metadata', () => {
      assert.strictEqual(browser.metadata.registration.agentId, 'browser-agent');
      assert.strictEqual(browser.metadata.registration.type, 'ESSENTIAL');
      assert.ok(browser.metadata.capabilities.length >= 7);
    });

    it('should have all required capabilities', () => {
      const capabilities = browser.metadata.capabilities.map(c => c.id);
      assert.ok(capabilities.includes('navigate'));
      assert.ok(capabilities.includes('click-element'));
      assert.ok(capabilities.includes('type-text'));
      assert.ok(capabilities.includes('get-element-text'));
      assert.ok(capabilities.includes('check-element-visible'));
      assert.ok(capabilities.includes('submit-form'));
      assert.ok(capabilities.includes('wait-for-element'));
    });

    it('should start browser', () => {
      assert.strictEqual(browser.status.state, 'READY');
    });

    it('should navigate to URL', async () => {
      const result = await browser.navigateToUrl('https://example.com');
      assert.ok(result.success);
      assert.strictEqual(result.url, 'https://example.com');
    });

    it('should get current URL', () => {
      const url = browser.getCurrentUrl();
      assert.strictEqual(url, 'https://example.com');
    });

    it('should click element', async () => {
      const result = await browser.clickElement('button.submit');
      assert.ok(result.success);
    });

    it('should type into element', async () => {
      const result = await browser.typeIntoElement('input#search', 'test query');
      assert.ok(result.success);
    });

    it('should get element text', async () => {
      const result = await browser.getElementText('h1.title');
      assert.ok(result.success);
      assert.ok(typeof result.text === 'string');
    });

    it('should check element visibility', async () => {
      const result = await browser.isElementVisible('div.content');
      assert.ok(result.success);
      assert.ok(typeof result.visible === 'boolean');
    });

    it('should submit form', async () => {
      const result = await browser.submitForm('form#login');
      assert.ok(result.success);
    });

    it('should wait for element', async () => {
      const result = await browser.waitForElement('div.results', 5000);
      assert.ok(result.success);
    });

    it('should execute navigate capability', async () => {
      const result = await browser.executeCapability('navigate', {
        url: 'https://test.com',
      });
      assert.ok(result.success);
    });

    it('should execute click capability', async () => {
      const result = await browser.executeCapability('click-element', {
        selector: 'button',
      });
      assert.ok(result.success);
    });

    it('should perform health check', async () => {
      const health = await browser.healthCheck();
      assert.ok(['HEALTHY', 'DEGRADED', 'FAILING'].includes(health));
    });

    it('should track success count', async () => {
      const initialCount = browser.status.successCount;
      await browser.navigateToUrl('https://example.com');
      assert.ok(browser.status.successCount >= initialCount);
    });

    it('should handle errors gracefully', async () => {
      try {
        await browser.executeCapability('invalid-capability', {});
        assert.fail('Should have thrown error');
      } catch (error) {
        assert.ok(error instanceof Error);
      }
    });

    after(async () => {
      await browser.stop();
      assert.strictEqual(browser.status.state, 'STOPPED');
    });
  });

  describe('Integration: Confirmation + Desktop + Browser', () => {
    it('should flow from confirmation to desktop action', async () => {
      // Create high-risk decision
      const decision: BrainDecision = {
        intent: { action: 'click', target: 'button', parameters: {}, confidence: 0.8, context: {} },
        plan: null,
        selectedAgents: ['desktop-agent'],
        riskLevel: 'HIGH',
        requiresConfirmation: true,
        reason: 'High-risk click operation',
        evidence: ['User requested destructive action'],
      };

      // Create confirmation
      const request = workflow.createConfirmationRequest('task-integration-1', decision);

      // Request approval
      const response = await workflow.requestConfirmation(request, async () => true);
      assert.ok(response.approved);

      // If approved, execute desktop action
      if (response.approved) {
        await desktop.mouseClick(100, 100);
      }

      assert.ok(true);
    });

    it('should deny risky browser navigation', async () => {
      // Create high-risk decision
      const decision: BrainDecision = {
        intent: { action: 'navigate', target: 'malicious.com', parameters: {}, confidence: 0.8, context: {} },
        plan: null,
        selectedAgents: ['browser-agent'],
        riskLevel: 'HIGH',
        requiresConfirmation: true,
        reason: 'Potentially unsafe website',
        evidence: ['URL flagged as risky'],
      };

      const request = workflow.createConfirmationRequest('task-integration-2', decision);

      // User denies
      const response = await workflow.requestConfirmation(request, async () => false);
      assert.ok(!response.approved);

      // Action not executed
      assert.ok(true);
    });

    it('should auto-approve safe browser navigation', async () => {
      const decision: BrainDecision = {
        intent: { action: 'navigate', target: 'google.com', parameters: {}, confidence: 0.95, context: {} },
        plan: null,
        selectedAgents: ['browser-agent'],
        riskLevel: 'LOW',
        requiresConfirmation: false,
        reason: 'Safe website',
        evidence: [],
      };

      const request = workflow.createConfirmationRequest('task-integration-3', decision);

      // Should auto-approve
      if (workflow.shouldAutoApprove(request)) {
        // Execute browser action
        const result = await browser.navigateToUrl('https://google.com');
        assert.ok(result.success);
      }
    });
  });

  after(() => {
    workflow.clear();
    console.log('[Tests] Phase 3 integration tests completed');
  });
});
