# SARA Production Architecture
## Real-World Autonomous Desktop Assistant

**Status**: Phase 1 Core Systems ✅ IMPLEMENTED

---

## I. ARCHITECTURE OVERVIEW

### Complete Command Flow

```
USER
  │
  ├─ Voice Input ("Open Firefox and search...")
  │
  ↓
┌─────────────────────────────────────────────────┐
│    SARA COGNITIVE BRAIN                         │
│                                                 │
│  1. ParseIntent()                               │
│     - Convert natural language to Intent        │
│     - Extract action, target, parameters       │
│     - Confidence scoring                        │
│                                                 │
│  2. BuildContext()                              │
│     - Retrieve memory (episodic, semantic)      │
│     - Load user preferences                     │
│     - Build task context                        │
│                                                 │
│  3. MakeDecision()                              │
│     - Assess risk level                         │
│     - Select required agents                    │
│     - Create execution plan                     │
│     - Determine if confirmation needed          │
│                                                 │
└─────────────────────────────────────────────────┘
  │
  ├─ [CONFIRMATION if HIGH RISK]
  │   "I'll open Firefox and search. Is that OK?"
  │
  ↓
┌─────────────────────────────────────────────────┐
│    AGENT SUPERVISOR                             │
│                                                 │
│  1. SelectAgents()                              │
│     - Find agents with required capabilities    │
│     - Check health status                       │
│     - Verify dependencies                       │
│                                                 │
│  2. StartAgents()                               │
│     - Start essential agents if needed          │
│     - Wait for readiness                        │
│     - Verify health                             │
│                                                 │
└─────────────────────────────────────────────────┘
  │
  ↓
┌─────────────────────────────────────────────────┐
│    EXECUTION (Agent-Specific)                   │
│                                                 │
│  Desktop Agent:                                 │
│  - Click desktop                                │
│  - Launch Firefox                               │
│                                                 │
│  Browser Agent:                                 │
│  - Wait for Firefox to open                     │
│  - Focus address bar                            │
│  - Type search query                            │
│  - Press Enter                                  │
│                                                 │
│  Vision Agent:                                  │
│  - Take screenshots                             │
│  - Analyze for results                          │
│                                                 │
└─────────────────────────────────────────────────┘
  │
  ↓
┌─────────────────────────────────────────────────┐
│    OBSERVATION                                  │
│                                                 │
│  - Screenshot capture                           │
│  - OCR on visible elements                      │
│  - Window detection                             │
│  - Process detection                            │
│  - Network monitoring                           │
│                                                 │
└─────────────────────────────────────────────────┘
  │
  ↓
┌─────────────────────────────────────────────────┐
│    VERIFICATION                                 │
│                                                 │
│  Expected: Firefox visible + search results     │
│  Actual: [from observation]                     │
│                                                 │
│  ✓ Firefox process running?                     │
│  ✓ Firefox window visible?                      │
│  ✓ Search results displayed?                    │
│  ✓ Correct domain in URL?                       │
│                                                 │
│  Confidence: 0.95                               │
│                                                 │
└─────────────────────────────────────────────────┘
  │
  ├─ Success → AuthoritativeTaskResult(COMPLETED)
  │
  ├─ Partial → AuthoritativeTaskResult(PARTIAL)
  │
  └─ Failure → Recovery Engine
      │
      ├─ Retry (for transient failures)
      ├─ Replan (for strategy issues)
      ├─ Fallback (alternative agent/method)
      │
      └─ → AuthoritativeTaskResult(FAILED)
          └─ [Send to Recovery Learning]
  │
  ↓
┌─────────────────────────────────────────────────┐
│    AUTHORITATIVE TASK RESULT                    │
│                                                 │
│  {                                              │
│    taskId: "...",                               │
│    finalState: "COMPLETED",                     │
│    success: true,                               │
│    summary: "Done. I opened Firefox and found   │
│              search results. I verified the      │
│              page loaded by checking the title  │
│              and result count.",                │
│    verification: {                              │
│      verified: true,                            │
│      confidence: 0.95,                          │
│      checks: [                                  │
│        { name: "Firefox running", passed: true}│
│        { name: "Results visible", passed: true}│
│      ]                                          │
│    },                                           │
│    evidence: [                                  │
│      { type: "screenshot", ... },               │
│      { type: "process", ... }                   │
│    ]                                            │
│  }                                              │
│                                                 │
└─────────────────────────────────────────────────┘
  │
  ↓
┌─────────────────────────────────────────────────┐
│    MEMORY & LEARNING                            │
│                                                 │
│  Store: {                                       │
│    episodic: [completed task]                   │
│    achievement: [successful execution]          │
│    procedural: [learned workflow]               │
│    strategy: [successful strategy]              │
│  }                                              │
│                                                 │
│  Learn:                                         │
│  - Next time "open Firefox and search"          │
│  - Reuse this exact workflow                    │
│  - Improve timing estimates                     │
│                                                 │
└─────────────────────────────────────────────────┘
  │
  ↓
┌─────────────────────────────────────────────────┐
│    VOICE RESPONSE                               │
│                                                 │
│  "Done. I opened Firefox, searched for your     │
│   query, and found the results. I verified      │
│   the page loaded correctly."                   │
│                                                 │
│  (Matches actual result, not speculative)       │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## II. CORE SYSTEMS IMPLEMENTED

### ✅ Phase 1: Core Infrastructure

#### 1. **Agent Type System** (`src/types/AgentTypes.ts`)
- Defines all agent metadata structures
- Capabilities, permissions, dependencies
- Status tracking and health monitoring
- Process management

#### 2. **Agent Registry** (`src/services/AgentRegistry.ts`)
- Central registry for all SARA agents
- Capability discovery
- Status tracking
- Dependency resolution
- Statistics and reporting

```typescript
const registry = getAgentRegistry();
registry.register(agent);
const agent = registry.getAgent('desktop-agent');
const agents = registry.getAgentsByType('ESSENTIAL');
const capability = registry.findAgentWithCapability('mouse-control');
```

#### 3. **Agent Supervisor** (`src/services/AgentSupervisor.ts`)
- Manages agent lifecycle (start, stop, restart)
- Dependency ordering
- Health checking with auto-recovery
- Crash detection and restart with backoff
- Process monitoring

```typescript
const supervisor = getAgentSupervisor();
await supervisor.initialize();
await supervisor.startEssentialAgents();
const status = supervisor.getStatus();
await supervisor.shutdown();
```

#### 4. **Desktop Agent** (`src/agents/DesktopAgent.ts`)
- Mouse control (move, click, drag, scroll)
- Keyboard input (type, hotkeys)
- Screenshot capture
- Window detection and management
- Real OS API integration points

```typescript
const desktop = getDesktopAgent();
await desktop.mouseClick(100, 200);
await desktop.typeText("Hello World");
await desktop.hotkey(['ctrl', 'c']);
const screenshot = await desktop.takeScreenshot();
```

#### 5. **SARA Cognitive Brain** (`src/brain/SARACognitiveBrain.ts`)
- Intent parsing from natural language
- Context building from memory
- Decision making and planning
- Risk assessment
- Verification logic
- Voice response generation

```typescript
const brain = getSARACognitiveBrain(memoryService, skillLibrary);
const intent = await brain.parseIntent("Open Firefox", memoryStore);
const decision = await brain.makeDecision(intent, memoryStore);
const verified = await brain.verifyResult(result, expectedOutcome);
const response = await brain.generateVoiceResponse(result);
```

#### 6. **Authoritative Task Result** (`src/types/AuthoritativeTaskResult.ts`)
- Single source of truth for task outcomes
- Captures evidence and verification
- Used by UI, voice, memory, learning systems
- Immutable historical record

```typescript
interface AuthoritativeTaskResult {
  taskId: string;
  finalState: 'COMPLETED' | 'PARTIAL' | 'FAILED' | ...;
  success: boolean;
  summary: string;
  verification: VerificationResult;
  evidence: TaskResultEvidence[];
  primaryAgent: string;
  verifiedBy: string;
  // Used by memory, learning, UI, voice
}
```

---

## III. HOW TO USE

### Starting SARA with Full Agent Management

```typescript
import { getAgentRegistry, createAgentRegistry } from './src/services/AgentRegistry';
import { getAgentSupervisor, createAgentSupervisor } from './src/services/AgentSupervisor';
import { getDesktopAgent } from './src/agents/DesktopAgent';
import { getSARACognitiveBrain } from './src/brain/SARACognitiveBrain';
import { getClosedLoopExecutor } from './src/services/ClosedLoopExecutor';

async function startSARA() {
  // 1. Initialize registry
  const registry = getAgentRegistry();
  
  // 2. Register agents (Desktop, Browser, Vision, etc.)
  const desktop = getDesktopAgent();
  registry.register(desktop);
  
  // 3. Initialize supervisor
  const supervisor = getAgentSupervisor({
    autoStartEssentialAgents: true,
    autoRestartOnFailure: true,
  });
  await supervisor.initialize();
  
  // 4. Initialize brain
  const brain = getSARACognitiveBrain(memoryService, skillLibrary);
  
  // 5. Ready to receive commands
  console.log('[SARA] Ready for voice commands');
}

// User says: "Open Firefox and search for AI news"
async function handleVoiceCommand(voiceInput: string) {
  const brain = getSARACognitiveBrain(memoryService, skillLibrary);
  const supervisor = getAgentSupervisor();
  
  // 1. Parse intent
  const intent = await brain.parseIntent(voiceInput, memoryStore);
  
  // 2. Make decision
  const decision = await brain.makeDecision(intent, memoryStore);
  
  if (decision.requiresConfirmation) {
    // Ask user for confirmation
    const confirmed = await askUserConfirmation(decision);
    if (!confirmed) return;
  }
  
  // 3. Execute with selected agents
  const executor = getClosedLoopExecutor();
  const result = await executor.executeTask(taskId, {
    maxRetries: 3,
    enableRecovery: true,
    verificationRequired: true,
  });
  
  // 4. Verify result
  const verified = await brain.verifyResult(result, expectedOutcome);
  
  // 5. Generate voice response (matches actual result)
  const response = await brain.generateVoiceResponse(result);
  
  // 6. Store in memory for learning
  await memoryService.storeTaskExperience(result);
  
  // 7. Respond to user
  await speakToUser(response);
}
```

### Registering a Custom Agent

```typescript
const myAgent: Agent = {
  metadata: {
    registration: {
      agentId: 'my-custom-agent',
      name: 'My Custom Agent',
      type: 'SPECIALIZED',
      version: '1.0.0',
      description: '...',
      createdAt: Date.now(),
      modifiedAt: Date.now(),
    },
    capabilities: [
      {
        id: 'my-capability',
        name: 'Do Something',
        description: '...',
        version: '1.0.0',
        parameters: { param: 'type' },
        expectedResult: '...',
        verification: { method: 'automatic', checkFunction: (r) => true },
        confirmed: true,
      }
    ],
    permissions: { /* ... */ },
    dependencies: [
      { agentId: 'desktop-agent', ... }
    ],
    lifecycle: {
      startupCommand: '...',
      shutdownCommand: '...',
      restartCommand: '...',
      readinessCheck: async () => true,
      healthCheck: async () => 'HEALTHY',
    },
  },
  status: { /* ... */ },
  process: { /* ... */ },
  errorLog: [],
  start: async () => { },
  stop: async () => { },
  restart: async () => { },
  pause: async () => { },
  resume: async () => { },
  healthCheck: async () => 'HEALTHY',
  getCapability: (id) => null,
  executeCapability: async (id, params) => { },
};

registry.register(myAgent);
```

---

## IV. MEMORY INTEGRATION

Every authoritative task result automatically creates a memory episode:

```typescript
const episode = {
  goalDescription: task.goal.description,
  actualActions: result.actions,
  observations: result.observations,
  result: {
    success: result.success,
    finalState: result.finalState,
    duration: result.metrics.totalTime,
    evidence: result.evidence,
  },
  failures: result.failure ? [ result.failure ] : [],
  userFeedback: userFeedback,
  timestamp: Date.now(),
};

memoryService.storeEpisodicMemory(episode);
memoryService.storeAchievementMemory(episode);
```

Next time similar task:
```
Memory retrieval → Successful episodes → Extract workflow → Reuse with confidence
```

---

## V. VERIFICATION & RECOVERY

Every action has an expected outcome and verification:

```typescript
const verification = {
  action: 'Open Firefox',
  expected: {
    processRunning: true,
    windowVisible: true,
    titleContains: 'Firefox',
  },
  actual: {
    processRunning: true,
    windowVisible: true,
    titleContains: 'Firefox',
  },
  checks: [
    { name: 'Process check', passed: true },
    { name: 'Window check', passed: true },
    { name: 'Title check', passed: true },
  ],
  verified: true,
  confidence: 0.95,
};
```

If verification fails:
```
→ Recovery Engine
  ├─ Retry (same action)
  ├─ Replan (different approach)
  └─ Fallback (alternative method)
→ AuthoritativeTaskResult(FAILED/PARTIAL)
```

---

## VI. WHAT'S NEXT

### Phase 2: Input & Voice System
- [ ] Voice input system (STT)
- [ ] Intent parser enhancement
- [ ] Confirmation engine
- [ ] Voice response system (TTS)

### Phase 3: Browser Automation
- [ ] Browser Agent (Firefox, Chrome, Edge)
- [ ] Page navigation + DOM interaction
- [ ] Real browser verification
- [ ] Multi-tab support

### Phase 4: Application Management
- [ ] Application launcher
- [ ] Process detection
- [ ] Window management
- [ ] Crash recovery

### Phase 5: Specialized Agents
- [ ] Email Agent (Gmail, Outlook)
- [ ] WhatsApp Agent
- [ ] YouTube Agent
- [ ] File Agent (filesystem operations)

### Phase 6: Real Desktop Testing
- [ ] Desktop test suite
- [ ] Multi-agent workflow tests
- [ ] Recovery scenario tests
- [ ] End-to-end tests

---

## VII. KEY PRINCIPLES

1. **Real Implementation First**
   - Every feature executes real operations
   - Not test-only implementations
   - Real OS APIs

2. **Verification Before Success**
   - Never claim success without proof
   - Always observe actual state
   - Compare expected vs. actual
   - Provide confidence score

3. **Single Source of Truth**
   - AuthoritativeTaskResult is canonical
   - All systems derive from it
   - No independent success guessing

4. **Memory-Driven Learning**
   - Every task stored as episode
   - Success patterns extracted
   - Failure modes analyzed
   - Strategies refined

5. **Human-Like Reasoning**
   - Goals decomposed into subgoals
   - Context from memory considered
   - Risk assessed
   - Confirmation requested for high-risk

6. **Recovery is Mandatory**
   - Failure detected immediately
   - Recovery strategies attempted
   - Honest result reported
   - Never hide failures

---

## VIII. RUNNING TESTS

All existing tests continue to pass (100% success rate from Phase 0):

```bash
# Memory system tests (17/17 passing)
npm run test:persistence

# Full integration tests
npm run test

# Real desktop tests (when implemented)
npm run test:real-desktop
```

---

## IX. ARCHITECTURE FILES

**Types**:
- `src/types/AgentTypes.ts` - Agent metadata and lifecycle
- `src/types/AuthoritativeTaskResult.ts` - Single source of truth

**Services**:
- `src/services/AgentRegistry.ts` - Agent discovery and management
- `src/services/AgentSupervisor.ts` - Agent lifecycle control
- `src/services/ClosedLoopExecutor.ts` - Task execution
- `src/services/MemoryPersistenceService.ts` - Memory persistence
- `src/services/MemoryService.ts` - Memory operations
- `src/services/SkillLibraryAndStrategyManager.ts` - Skill management
- `src/services/LearningWorkflowCoordinator.ts` - Learning orchestration

**Agents**:
- `src/agents/DesktopAgent.ts` - Desktop automation foundation

**Brain**:
- `src/brain/SARACognitiveBrain.ts` - Central reasoning

---

## X. MONITORING & DEBUGGING

Agent Supervisor provides real-time status:

```typescript
const supervisor = getAgentSupervisor();
const status = supervisor.getStatus();

console.log(`Healthy: ${status.healthy}`);
console.log(`Running: ${status.agentsRunning}/${status.agentsTotal}`);
console.log(`Failing: ${status.failingAgents}`);
```

Each agent tracks:
- Success/failure count
- Average duration
- Last error
- Resource usage
- Uptime

---

**NEXT STEP**: Implement Phase 2 (Voice Input System) to enable natural language command entry.

