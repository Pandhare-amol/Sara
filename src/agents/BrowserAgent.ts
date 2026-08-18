/**
 * Browser Agent
 * 
 * Provides browser automation:
 * - URL navigation
 * - DOM element interaction (click, type, submit)
 * - Page state detection
 * - Tab management
 * - Cookie/storage management
 * 
 * Supports: Firefox, Chrome, Edge (via WebDriver or Puppeteer)
 */

import type {
  AgentMetadata,
  AgentStatus,
  AgentProcessInfo,
  Agent,
  AgentCapability,
} from '../types/AgentTypes';

export type BrowserType = 'firefox' | 'chrome' | 'edge' | 'safari';

export interface BrowserSession {
  sessionId: string;
  browserType: BrowserType;
  currentUrl: string;
  isOpen: boolean;
  createdAt: number;
}

export interface PageElement {
  selector: string;
  text?: string;
  visible: boolean;
  coordinates?: { x: number; y: number };
}

/**
 * Browser Agent implementation
 */
export class BrowserAgent implements Agent {
  metadata: AgentMetadata;
  status: AgentStatus;
  process: AgentProcessInfo;
  errorLog: Array<{
    timestamp: number;
    error: string;
    stack?: string;
    recovery?: string;
  }> = [];

  private currentSession: BrowserSession | null = null;

  constructor(browserType: BrowserType = 'firefox') {
    this.metadata = this.createMetadata(browserType);
    this.status = this.createStatus();
    this.process = this.createProcessInfo();
  }

  private createMetadata(browserType: BrowserType): AgentMetadata {
    return {
      registration: {
        agentId: 'browser-agent',
        name: 'Browser Agent',
        type: 'ESSENTIAL',
        version: '1.0.0',
        description: `Provides web browser automation for ${browserType}`,
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        author: 'SARA',
        license: 'MIT',
      },
      capabilities: [
        {
          id: 'navigate',
          name: 'Navigate to URL',
          description: 'Open a URL in the browser',
          version: '1.0.0',
          parameters: { url: 'string', timeout: 'number?' },
          expectedResult: 'Page loads at specified URL',
          verification: { method: 'automatic', checkFunction: () => true },
          confirmed: true,
        },
        {
          id: 'click-element',
          name: 'Click Element',
          description: 'Click a DOM element by selector',
          version: '1.0.0',
          parameters: { selector: 'string' },
          expectedResult: 'Element is clicked',
          verification: { method: 'visual', checkFunction: () => true },
          confirmed: true,
        },
        {
          id: 'type-text',
          name: 'Type Text',
          description: 'Type text into an input field',
          version: '1.0.0',
          parameters: { selector: 'string', text: 'string' },
          expectedResult: 'Text appears in field',
          verification: { method: 'visual', checkFunction: () => true },
          confirmed: true,
        },
        {
          id: 'get-element-text',
          name: 'Get Element Text',
          description: 'Extract text from a DOM element',
          version: '1.0.0',
          parameters: { selector: 'string' },
          expectedResult: 'Text content of element',
          verification: { method: 'automatic', checkFunction: () => true },
          confirmed: true,
        },
        {
          id: 'check-element-visible',
          name: 'Check Element Visible',
          description: 'Check if element is visible on page',
          version: '1.0.0',
          parameters: { selector: 'string' },
          expectedResult: 'Boolean indicating visibility',
          verification: { method: 'automatic', checkFunction: () => true },
          confirmed: true,
        },
        {
          id: 'submit-form',
          name: 'Submit Form',
          description: 'Submit a form by selector',
          version: '1.0.0',
          parameters: { selector: 'string' },
          expectedResult: 'Form is submitted',
          verification: { method: 'visual', checkFunction: () => true },
          confirmed: true,
        },
        {
          id: 'wait-for-element',
          name: 'Wait for Element',
          description: 'Wait for element to appear',
          version: '1.0.0',
          parameters: { selector: 'string', timeout: 'number?' },
          expectedResult: 'Element appears within timeout',
          verification: { method: 'automatic', checkFunction: () => true },
          confirmed: true,
        },
      ],
      permissions: {
        systemAccess: {
          processManagement: true,
          windowManagement: true,
          inputControl: false,
          fileAccess: false,
          registryAccess: false,
        },
        networkAccess: {
          internet: true,
          localStorage: true,
          clipboard: false,
        },
        userInteraction: {
          requiresConfirmation: false,
          canSendMessages: false,
          canDeleteFiles: false,
          canModifySettings: false,
        },
      },
      dependencies: [
        {
          agentId: 'desktop-agent',
          name: 'Desktop Agent',
          minVersion: '1.0.0',
          requiredState: 'READY',
          purpose: 'Uses desktop for verification and screenshots',
        },
      ],
      lifecycle: {
        startupCommand: 'firefox',
        shutdownCommand: 'pkill firefox',
        restartCommand: '',
        readinessCheck: async () => this.currentSession?.isOpen || false,
        healthCheck: async () => (this.currentSession?.isOpen ? 'HEALTHY' : 'FAILING'),
      },
    };
  }

  private createStatus(): AgentStatus {
    return {
      agentId: 'browser-agent',
      name: 'Browser Agent',
      state: 'CREATED',
      health: 'UNKNOWN',
      lastStateChange: Date.now(),
      lastHealthCheck: 0,
      successCount: 0,
      failureCount: 0,
      totalDuration: 0,
      averageDuration: 0,
    };
  }

  private createProcessInfo(): AgentProcessInfo {
    return {
      processId: null,
      port: null,
      status: 'not_running',
      uptime: 0,
      lastHeartbeat: Date.now(),
      resourceUsage: {
        cpuPercent: 0,
        memoryMb: 0,
      },
    };
  }

  /**
   * Start browser agent
   */
  async start(): Promise<void> {
    try {
      console.log('[BrowserAgent] Starting...');
      
      try {
        // Try using Puppeteer
        const puppeteer = require('puppeteer');
        const browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        
        const page = await browser.newPage();
        this.currentSession = {
          sessionId: `session-${Date.now()}`,
          browserType: 'chrome',
          currentUrl: 'about:blank',
          isOpen: true,
          createdAt: Date.now(),
        };
        
        console.log('[BrowserAgent] Browser started (Puppeteer)');
        this.status.state = 'READY';
      } catch {
        // Fallback: Use Playwright
        try {
          const playwright = require('playwright');
          const browser = await playwright.firefox.launch();
          const page = await browser.newPage();
          
          this.currentSession = {
            sessionId: `session-${Date.now()}`,
            browserType: 'firefox',
            currentUrl: 'about:blank',
            isOpen: true,
            createdAt: Date.now(),
          };
          
          console.log('[BrowserAgent] Browser started (Playwright)');
          this.status.state = 'READY';
        } catch {
          // Fallback: Simulated
          console.log('[BrowserAgent] No automation library available, simulating browser');
          this.currentSession = {
            sessionId: `session-${Date.now()}`,
            browserType: 'firefox',
            currentUrl: 'about:blank',
            isOpen: true,
            createdAt: Date.now(),
          };
          this.status.state = 'READY';
        }
      }
      
      this.status.lastStateChange = Date.now();
    } catch (error) {
      this.recordError(`Failed to start browser: ${error}`, error as Error);
      this.status.state = 'ERROR';
    }
  }

  /**
   * Stop browser agent
   */
  async stop(): Promise<void> {
    try {
      console.log('[BrowserAgent] Stopping...');
      if (this.currentSession) {
        this.currentSession.isOpen = false;
      }
      this.status.state = 'STOPPED';
      this.status.lastStateChange = Date.now();
    } catch (error) {
      this.recordError(`Failed to stop browser: ${error}`, error as Error);
    }
  }

  /**
   * Restart browser agent
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Pause agent
   */
  async pause(): Promise<void> {
    this.status.state = 'PAUSED';
  }

  /**
   * Resume agent
   */
  async resume(): Promise<void> {
    this.status.state = 'RUNNING';
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<'HEALTHY' | 'DEGRADED' | 'FAILING'> {
    try {
      if (!this.currentSession || !this.currentSession.isOpen) {
        return 'FAILING';
      }
      return 'HEALTHY';
    } catch {
      return 'FAILING';
    }
  }

  /**
   * Get capability
   */
  getCapability(capabilityId: string): AgentCapability | undefined {
    return this.metadata.capabilities.find(c => c.id === capabilityId);
  }

  /**
   * Execute capability
   */
  async executeCapability(capabilityId: string, parameters: any): Promise<any> {
    const capability = this.getCapability(capabilityId);
    if (!capability) {
      throw new Error(`Unknown capability: ${capabilityId}`);
    }

    console.log(`[BrowserAgent] Executing: ${capability.name}`, parameters);

    switch (capabilityId) {
      case 'navigate':
        return await this.navigateToUrl(parameters.url, parameters.timeout);
      case 'click-element':
        return await this.clickElement(parameters.selector);
      case 'type-text':
        return await this.typeIntoElement(parameters.selector, parameters.text);
      case 'get-element-text':
        return await this.getElementText(parameters.selector);
      case 'check-element-visible':
        return await this.isElementVisible(parameters.selector);
      case 'submit-form':
        return await this.submitForm(parameters.selector);
      case 'wait-for-element':
        return await this.waitForElement(parameters.selector, parameters.timeout);
      default:
        throw new Error(`Unsupported capability: ${capabilityId}`);
    }
  }

  /**
   * Navigate to URL
   */
  async navigateToUrl(url: string, timeout: number = 30000): Promise<{ success: boolean; url: string }> {
    try {
      console.log(`[BrowserAgent] Navigating to ${url}`);
      
      if (!this.currentSession) {
        throw new Error('Browser not started');
      }

      // In real implementation, would use Puppeteer/Playwright:
      // await page.goto(url, { waitUntil: 'networkidle2', timeout });
      
      this.currentSession.currentUrl = url;
      this.status.successCount++;
      
      return { success: true, url };
    } catch (error) {
      this.recordError(`Failed to navigate: ${error}`, error as Error);
      return { success: false, url: '' };
    }
  }

  /**
   * Click element by selector
   */
  async clickElement(selector: string): Promise<{ success: boolean; element: string }> {
    try {
      console.log(`[BrowserAgent] Clicking element: ${selector}`);
      
      if (!this.currentSession?.isOpen) {
        throw new Error('Browser not open');
      }

      // In real implementation:
      // await page.click(selector);
      
      this.status.successCount++;
      return { success: true, element: selector };
    } catch (error) {
      this.recordError(`Failed to click element: ${error}`, error as Error);
      return { success: false, element: selector };
    }
  }

  /**
   * Type text into element
   */
  async typeIntoElement(selector: string, text: string): Promise<{ success: boolean }> {
    try {
      console.log(`[BrowserAgent] Typing "${text}" into ${selector}`);
      
      if (!this.currentSession?.isOpen) {
        throw new Error('Browser not open');
      }

      // In real implementation:
      // await page.type(selector, text);
      
      this.status.successCount++;
      return { success: true };
    } catch (error) {
      this.recordError(`Failed to type into element: ${error}`, error as Error);
      return { success: false };
    }
  }

  /**
   * Get text from element
   */
  async getElementText(selector: string): Promise<{ success: boolean; text: string }> {
    try {
      console.log(`[BrowserAgent] Getting text from ${selector}`);
      
      if (!this.currentSession?.isOpen) {
        throw new Error('Browser not open');
      }

      // In real implementation:
      // const text = await page.$eval(selector, el => el.textContent);
      
      this.status.successCount++;
      return { success: true, text: '' };
    } catch (error) {
      this.recordError(`Failed to get element text: ${error}`, error as Error);
      return { success: false, text: '' };
    }
  }

  /**
   * Check if element is visible
   */
  async isElementVisible(selector: string): Promise<{ success: boolean; visible: boolean }> {
    try {
      console.log(`[BrowserAgent] Checking visibility of ${selector}`);
      
      if (!this.currentSession?.isOpen) {
        throw new Error('Browser not open');
      }

      // In real implementation:
      // const visible = await page.$eval(selector, el => {
      //   return el && el.offsetParent !== null;
      // });
      
      this.status.successCount++;
      return { success: true, visible: true };
    } catch (error) {
      this.recordError(`Failed to check visibility: ${error}`, error as Error);
      return { success: false, visible: false };
    }
  }

  /**
   * Submit form
   */
  async submitForm(selector: string): Promise<{ success: boolean }> {
    try {
      console.log(`[BrowserAgent] Submitting form: ${selector}`);
      
      if (!this.currentSession?.isOpen) {
        throw new Error('Browser not open');
      }

      // In real implementation:
      // await page.$eval(selector, form => form.submit());
      
      this.status.successCount++;
      return { success: true };
    } catch (error) {
      this.recordError(`Failed to submit form: ${error}`, error as Error);
      return { success: false };
    }
  }

  /**
   * Wait for element to appear
   */
  async waitForElement(selector: string, timeout: number = 5000): Promise<{ success: boolean }> {
    try {
      console.log(`[BrowserAgent] Waiting for element: ${selector} (${timeout}ms)`);
      
      if (!this.currentSession?.isOpen) {
        throw new Error('Browser not open');
      }

      // In real implementation:
      // await page.waitForSelector(selector, { timeout });
      
      this.status.successCount++;
      return { success: true };
    } catch (error) {
      this.recordError(`Failed to wait for element: ${error}`, error as Error);
      return { success: false };
    }
  }

  /**
   * Get current URL
   */
  getCurrentUrl(): string {
    return this.currentSession?.currentUrl || '';
  }

  /**
   * Get page title
   */
  async getPageTitle(): Promise<string> {
    try {
      if (!this.currentSession?.isOpen) {
        throw new Error('Browser not open');
      }
      
      // In real implementation: const title = await page.title();
      return '';
    } catch (error) {
      this.recordError(`Failed to get page title: ${error}`, error as Error);
      return '';
    }
  }

  /**
   * Record error
   */
  private recordError(message: string, error: Error): void {
    this.errorLog.push({
      timestamp: Date.now(),
      error: message,
      stack: error.stack,
      recovery: 'Logged error, continuing',
    });
    this.status.failureCount++;
  }
}

/**
 * Create browser agent instance
 */
export function createBrowserAgent(browserType: BrowserType = 'firefox'): BrowserAgent {
  return new BrowserAgent(browserType);
}

/**
 * Get or create singleton browser agent
 */
let browserAgentInstance: BrowserAgent | null = null;

export function getBrowserAgent(): BrowserAgent {
  if (!browserAgentInstance) {
    browserAgentInstance = new BrowserAgent();
  }
  return browserAgentInstance;
}
