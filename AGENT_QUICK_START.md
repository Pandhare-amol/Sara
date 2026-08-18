# SARA Agent Infrastructure - Quick Start Guide

## Getting Started with the Production Agent System

This guide shows how to use SARA's agent infrastructure to build autonomous desktop tasks.

---

## 1. Initialize SARA

```typescript
import { getAgentRegistry, createAgentRegistry } from './src/services/AgentRegistry';
import { getAgentSupervisor, createAgentSupervisor } from './src/services/AgentSupervisor';
import { getDesktopAgent } from './src/agents/DesktopAgent';
import { getSARACognitiveBrain } from './src/brain/SARACognitiveBrain';
import { MemoryService } from './src/services/MemoryService';
import { SkillLibrary } from './src/services/SkillLibraryAndStrategyManager';

async function initializeSARA() {
  // Create core services
  const registry = getAgentRegistry();
  const supervisor = getAgentSupervisor();
  
  // Get desktop agent and register it
  const desktop = getDesktopAgent();
  registry.register(desktop);
  
  // Initialize supervisor (starts health checks)
  await supervisor.initialize();
  
  // Initialize brain with memory and skills
  const memoryService = new MemoryService();
  const skillLibrary = new SkillLibrary();
  const brain = getSARACognitiveBrain(memoryService, skillLibrary);
  
  return { registry, supervisor, desktop, brain, memoryService, skillLibrary };
}
```

---

## 2. Start Essential Agents

```typescript
async function startAgents(supervisor) {
  // This will:
  // 1. Get all ESSENTIAL agents
  // 2. Sort by dependencies
  // 3. Start each one with timeout
  // 4. Verify readiness
  
  await supervisor.startEssentialAgents();
  
  const status = supervisor.getStatus();
  console.log(`✅ Started ${status.agentsRunning} agents`);
}
```

---

## 3. Process a Voice Command

```typescript
async function handleVoiceCommand(
  command: string,
  brain: SARACognitiveBrain,
  memoryStore: MemoryStore
) {
  // STEP 1: Parse natural language input
  console.log(`\n📢 You said: "${command}"`);
  const intent = await brain.parseIntent(command, memoryStore);
  
  console.log(`✓ Parsed as: ${intent.action}`);
  console.log(`  Target: ${intent.target || 'none'}`);
  console.log(`  Confidence: ${(intent.confidence * 100).toFixed(0)}%`);
  
  // STEP 2: Make decision with risk assessment
  const decision = await brain.makeDecision(intent, memoryStore);
  
  console.log(`✓ Decision made`);
  console.log(`  Risk level: ${decision.riskLevel}`);
  console.log(`  Agents: ${decision.selectedAgents.join(', ')}`);
  console.log(`  Confirm required: ${decision.requiresConfirmation}`);
  
  // STEP 3: Request confirmation if high risk
  if (decision.requiresConfirmation) {
    const confirmed = await askUserConfirmation(
      `Should I ${intent.action}? This has ${decision.riskLevel} risk.`
    );
    
    if (!confirmed) {
      console.log('❌ Cancelled by user');
      return;
    }
  }
  
  // STEP 4: Execute with selected agents
  console.log('\n⚙️  Executing...');
  const executor = getClosedLoopExecutor();
  const result = await executor.executeTask(generateTaskId(), {
    maxRetries: 3,
    enableRecovery: true,
    verificationRequired: true,
  });
  
  // STEP 5: Verify result
  console.log('🔍 Verifying result...');
  const verified = await brain.verifyResult(result, 'Task completed');
  
  console.log(`✓ Verified: ${verified.verified}`);
  console.log(`  Confidence: ${(verified.confidence * 100).toFixed(0)}%`);
  
  // STEP 6: Generate human-readable response
  const response = await brain.generateVoiceResponse(result);
  console.log(`\n🎤 SARA: "${response}"`);
  
  // STEP 7: Store in memory for learning
  await memoryService.storeEpisodicMemory({
    goalDescription: intent.action,
    actualActions: result.actions,
    observations: result.verification.checks,
    result: {
      success: result.success,
      finalState: result.state,
      duration: result.durationMs || 0,
      evidence: result.actions.length,
    },
    timestamp: Date.now(),
  });
  
  console.log('✓ Stored in memory for learning');
  
  return result;
}
```

---

## 4. Execute Desktop Actions

```typescript
async function demonstrateDesktopControl(desktop: DesktopAgent) {
  console.log('\n🖱️  Desktop Agent Demo\n');
  
  // Move mouse
  console.log('1. Moving mouse...');
  await desktop.mouseClick(100, 200);
  
  // Take screenshot
  console.log('2. Taking screenshot...');
  const screenshot = await desktop.takeScreenshot();
  console.log(`   Screenshot size: ${screenshot.length} bytes`);
  
  // Type text
  console.log('3. Typing text...');
  await desktop.typeText('Hello from SARA');
  
  // Hotkey
  console.log('4. Pressing Ctrl+A (select all)...');
  await desktop.hotkey(['ctrl', 'a']);
  
  // Get window info
  console.log('5. Getting active window...');
  const activeWindow = await desktop.getActiveWindow();
  if (activeWindow) {
    console.log(`   Active: ${activeWindow.title}`);
    console.log(`   Process: ${activeWindow.processName}`);
  }
}
```

---

## 5. Query Agent Registry

```typescript
async function inspectAgentRegistry(registry: AgentRegistry) {
  console.log('\n📋 Agent Registry\n');
  
  // Get statistics
  const stats = registry.getStats();
  console.log(`Total Agents: ${stats.totalAgents}`);
  console.log(`  Essential: ${stats.byType.ESSENTIAL || 0}`);
  console.log(`  Optional: ${stats.byType.OPTIONAL || 0}`);
  console.log(`  Specialized: ${stats.byType.SPECIALIZED || 0}`);
  
  console.log(`\nBy Health:`);
  for (const [health, count] of Object.entries(stats.byHealth || {})) {
    console.log(`  ${health}: ${count}`);
  }
  
  // List all agents
  const allAgents = registry.getAllAgents();
  console.log(`\nRegistered Agents:`);
  for (const agent of allAgents) {
    console.log(`  • ${agent.metadata.registration.name} (${agent.metadata.registration.agentId})`);
    console.log(`    Type: ${agent.metadata.registration.type}`);
    console.log(`    State: ${agent.status.state}`);
    console.log(`    Capabilities: ${agent.metadata.capabilities.length}`);
  }
}
```

---

## 6. Monitor Agent Health

```typescript
async function monitorAgentHealth(supervisor: AgentSupervisor) {
  console.log('\n❤️  Agent Health Monitoring\n');
  
  // Get current status
  const status = supervisor.getStatus();
  
  console.log(`System Healthy: ${status.healthy ? '✅' : '❌'}`);
  console.log(`Agents Running: ${status.agentsRunning}/${status.agentsTotal}`);
  
  if (status.failingAgents.length > 0) {
    console.log(`\n⚠️  Failing Agents:`);
    for (const agentId of status.failingAgents) {
      console.log(`  • ${agentId}`);
    }
  }
  
  // Perform health checks
  console.log('\nRunning health checks...');
  await supervisor.performHealthChecks();
  
  // Get updated status
  const updatedStatus = supervisor.getStatus();
  console.log(`Health check complete`);
  console.log(`System now: ${updatedStatus.healthy ? '✅ Healthy' : '❌ Unhealthy'}`);
}
```

---

## 7. Full Workflow Example

```typescript
async function runFullWorkflow() {
  console.log('='.repeat(60));
  console.log('SARA Agent Infrastructure - Full Workflow');
  console.log('='.repeat(60));
  
  // 1. Initialize
  console.log('\n1️⃣  Initializing SARA...');
  const { registry, supervisor, desktop, brain, memoryService, skillLibrary } 
    = await initializeSARA();
  console.log('   ✅ Initialized');
  
  // 2. Start agents
  console.log('\n2️⃣  Starting agents...');
  await startAgents(supervisor);
  
  // 3. Monitor health
  console.log('\n3️⃣  Checking agent health...');
  await monitorAgentHealth(supervisor);
  
  // 4. Inspect registry
  console.log('\n4️⃣  Inspecting agent registry...');
  await inspectAgentRegistry(registry);
  
  // 5. Demo desktop control
  console.log('\n5️⃣  Desktop control demo...');
  await demonstrateDesktopControl(desktop);
  
  // 6. Process voice commands
  console.log('\n6️⃣  Processing voice commands...');
  const memoryStore = {
    episodic: [],
    semantic: [],
    procedural: [],
    preference: [],
    failure: [],
    achievement: [],
    autobiographical: [],
  };
  
  const commands = [
    'Move the mouse',
    'Click somewhere',
    'Take a screenshot',
  ];
  
  for (const command of commands) {
    try {
      await handleVoiceCommand(command, brain, memoryStore);
    } catch (error) {
      console.error(`Error processing "${command}":`, error);
    }
  }
  
  // 7. Shutdown
  console.log('\n7️⃣  Shutting down...');
  await supervisor.stopAgent(desktop);
  console.log('   ✅ Shutdown complete');
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ Workflow complete');
  console.log('='.repeat(60));
}

// Run the workflow
runFullWorkflow().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
```

---

## 8. Adding a New Agent

To add a new agent (e.g., Browser Agent):

```typescript
import type { Agent } from './src/types/AgentTypes';

class BrowserAgent implements Agent {
  metadata: AgentMetadata = {
    registration: {
      agentId: 'browser-agent',
      name: 'Browser Agent',
      type: 'ESSENTIAL', // or OPTIONAL/SPECIALIZED
      version: '1.0.0',
      description: 'Controls web browsers',
      createdAt: Date.now(),
      modifiedAt: Date.now(),
    },
    capabilities: [
      {
        id: 'navigate',
        name: 'Navigate to URL',
        description: 'Open a URL in the browser',
        version: '1.0.0',
        parameters: { url: 'string' },
        expectedResult: 'Page loads',
        verification: { method: 'automatic', checkFunction: () => true },
        confirmed: true,
      },
      // ... more capabilities
    ],
    permissions: {
      systemAccess: { processManagement: true, windowManagement: true, ... },
      networkAccess: { internet: true, ... },
      userInteraction: { requiresConfirmation: false, ... },
    },
    dependencies: [
      { agentId: 'desktop-agent', required: true, why: 'Uses desktop for verification' }
    ],
    lifecycle: {
      startupCommand: 'firefox',
      shutdownCommand: 'pkill firefox',
      readinessCheck: async () => isFirefoxRunning(),
      healthCheck: async () => 'HEALTHY',
    },
  };
  
  status = { /* ... */ };
  process = { /* ... */ };
  errorLog = [];
  
  async start() { /* ... */ }
  async stop() { /* ... */ }
  async restart() { /* ... */ }
  async pause() { /* ... */ }
  async resume() { /* ... */ }
  async healthCheck() { /* ... */ }
  getCapability(id: string) { /* ... */ }
  async executeCapability(id: string, params: any) { /* ... */ }
}

// Register it
const registry = getAgentRegistry();
const browser = new BrowserAgent();
registry.register(browser);
```

---

## 9. Testing Your Agent

```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('My New Agent', () => {
  it('should initialize with metadata', () => {
    const agent = new MyNewAgent();
    assert.ok(agent.metadata.registration.agentId);
    assert.ok(agent.metadata.capabilities.length > 0);
  });
  
  it('should start and change state', async () => {
    const agent = new MyNewAgent();
    await agent.start();
    assert.strictEqual(agent.status.state, 'READY');
  });
  
  it('should execute capabilities', async () => {
    const agent = new MyNewAgent();
    const result = await agent.executeCapability('my-capability', {});
    assert.ok(true); // capability executed
  });
});
```

---

## 10. Common Patterns

### Pattern 1: Sequential Actions
```typescript
// Click button, wait, then check result
await desktop.mouseClick(btnX, btnY);
await new Promise(r => setTimeout(r, 1000)); // wait
const screenshot = await desktop.takeScreenshot();
// Analyze screenshot
```

### Pattern 2: Conditional Logic
```typescript
const intent = await brain.parseIntent(userInput, memoryStore);
if (intent.confidence < 0.6) {
  // Ask for clarification
} else {
  // Execute
}
```

### Pattern 3: Error Recovery
```typescript
try {
  await action();
} catch (error) {
  if (isRecoverable(error)) {
    // Retry or use alternative method
  } else {
    // Report failure
  }
}
```

### Pattern 4: Memory-Driven Execution
```typescript
// Retrieve similar past successes
const pastEpisodes = memoryStore.episodic.filter(
  e => e.goalDescription.includes(intent.action)
);

if (pastEpisodes.length > 0) {
  // Reuse successful strategy
  const successful = pastEpisodes.filter(e => e.result.success)[0];
  const actions = successful.actualActions;
  // Execute same actions
}
```

---

## Running Tests

```bash
# All tests
npx tsx --test tests/persistence-learning.test.ts tests/agent-infrastructure.test.ts

# Specific test
npx tsx --test tests/agent-infrastructure.test.ts --grep "Desktop Agent"

# Watch mode
npx tsx --test --watch tests/agent-infrastructure.test.ts
```

---

## Debugging

```typescript
// Enable detailed logging
console.log('[DEBUG]', {
  agentId: desktop.metadata.registration.agentId,
  state: desktop.status.state,
  health: desktop.status.health,
  failures: desktop.errorLog.slice(-5),
});

// Inspect registry
const registry = getAgentRegistry();
const stats = registry.getStats();
console.log('Registry:', stats);

// Trace decision
const decision = await brain.makeDecision(intent, memoryStore);
console.log('Decision:', {
  action: decision.intent.action,
  risk: decision.riskLevel,
  agents: decision.selectedAgents,
  evidence: decision.evidence,
});
```

---

## Next Steps

1. **Add Voice Input** - Connect speech-to-text to parseIntent()
2. **Implement Real Desktop APIs** - Replace DesktopAgent placeholders with actual Windows API calls
3. **Create Browser Agent** - Add web automation capabilities
4. **Add Vision/OCR** - Implement screenshot analysis
5. **Enable Voice Output** - Add text-to-speech responses

---

**Reference**: See `SARA_PRODUCTION_ARCHITECTURE.md` for complete system design
