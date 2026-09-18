# SARA Architecture Audit (Current State)

Based on a thorough inspection of the SARA repository, here is the current architectural map and inventory of features, highlighting production pathways, duplicate implementations, and structural realities.

## 1. Current Architecture Map & Boundaries

- **Electron UI (`electron/main.cjs`)**: Acts as a thin wrapper. Loads the React/Vite UI via `http://localhost:3000`. Does not currently handle advanced IPC for core functions (Phase 1 implementation).
- **Node.js Core Backend (`server_full.ts` / `server.ts`)**: The main controller. Handles the Gemini Live WebSocket connection, serves HTTP/WS to the React UI, and orchestrates calls to the Python Desktop Agent.
- **Python Desktop Agent (`desktop_agent/main.py`)**: A FastAPI server running on `127.0.0.1:8765`. Contains tools for browser automation (Playwright), OS control, and computer vision.
- **AI Provider**: Hardcoded to `@google/genai` directly inside `server_full.ts`. The API key is managed server-side.

## 2. Agent Responsibility & Duplicate Systems Inventory

**WARNING: DUPLICATE ORCHESTRATION IDENTIFIED**
There are two competing "brains" trying to manage tasks:
1. **Node.js Orchestrator**: `src/core/automation/automationOrchestrator.ts` defines `TaskRecord`, `TaskContext`, `AutomationStatus`, and an event-driven automation loop.
2. **Python Orchestrator**: `desktop_agent/agents.py` is a massive multi-agent orchestration layer in Python trying to do the exact same thing (planning, agents, state management).

**Action Required**: The Python orchestrator must be demoted to just a `ToolExecutor` and `Observation` layer. The **SARA Core Brain** (Node.js) must be the single source of truth for planning and orchestration.

## 3. Database Ownership Map

The memory and data storage is highly fragmented.
- **`data/sara_memory.db`** (SQLite): Contains tables for `short_term_memory`, `long_term_memory`, `episodic_memory`, `task_memory`, etc.
- **`data/memories.json` / `memories_mobile.json`**: Duplicate/legacy JSON memory files.
- **`data/conversations.json`**: Stores chat history.
- **`data/sessions.json`**: Manages user sessions.
- **`data/tasks.json`**: Stores task orchestration state.
- **`data/tool_calls.json`**: Tool audit logs.
- **`data/settings.json`**: User preferences.
- **`data/decisions.json` / `questions.json`**: Auxiliary cognitive stores.

**Migration Plan**: These must be consolidated into a unified schema (e.g., migrating JSON files into `data.db` or `sara_memory.db` with clear ownership boundaries).

## 4. Working Feature Inventory

- **Basic Voice Interaction**: `LiveServerMessage` implementation streams audio to Gemini.
- **Desktop Tool Execution**: `ToolRouter` successfully routes commands (like taking screenshots or opening files) to the Python FastAPI server.
- **Basic Memory Saving**: `server_memory.ts` can insert facts into the database.
- **Browser Automation (Playwright)**: The Python agent can open Chromium and take basic actions.
- **Production Supervisor**: `startupManager.ts` can launch the backend and the Desktop Agent, verify health, and enforce an integrity baseline.

## 5. Partial & Broken Feature Inventory

- **User / Speaker Recognition (PARTIAL/MISSING)**: `server.ts` uses `"default-user"`. No actual voice embedding or enrollment flow exists.
- **Parallel Task Execution (BROKEN)**: While task orchestration code exists, running a complex automation (like web browsing) blocks the Gemini Live WebSocket loop, making SARA unresponsive to voice.
- **Continuous Task Verification (PARTIAL)**: `src/core/verification/verificationEngine.ts` exists, but many tools simply return `success: true` if the Python subprocess didn't crash, instead of verifying the actual screen/DOM state.
- **Screen Understanding (BROKEN)**: SARA relies on blind, repeated screenshots rather than an event-driven `ScreenPerceptionManager` prioritizing the Accessibility Tree/DOM.
- **Connection Recovery (MISSING)**: If Gemini Live disconnects, the current active task state is often lost or orphaned.
- **File Intelligence (MISSING)**: Basic file opening works, but semantic file search/indexing is absent.
- **Proactive Assistance (MISSING)**: Files like `proactive_interaction.json` exist as placeholders. No real scheduling engine evaluates deadlines.

## 6. Placeholder / Mock Code Identified

- Many Python tools in `desktop_agent/tools_*.py` return hardcoded success strings without rigorous verification.
- The Python multi-agent system (`desktop_agent/agents.py`) generates mock plans internally rather than integrating natively with the Node SARA Core.
- The `UserIdentityService` concept is entirely missing despite references to user profiles.

## 7. Active Execution Paths

**Production Pathway**:
`npm run start:prod` → `startupManager.ts` → Validates Integrity → Starts Node Server (`server_full.ts`) → Starts Desktop Agent (`desktop_agent/main.py`) → Starts Electron UI.

## 8. Risk Assessment & Safe Migration Points

- **High Risk**: Modifying `server_full.ts` WebSocket logic. It is tightly coupled to the Gemini Live API. Refactoring this into a clean `ConversationManager` will require extreme care to avoid breaking voice streaming.
- **High Risk**: Merging the duplicate Task Orchestrators. The Python `agents.py` must be disabled safely while upgrading `automationOrchestrator.ts`.
- **Safe Migration Point**: Database consolidation. We can create migration scripts to move `conversations.json` and `tasks.json` into SQLite without touching runtime execution logic.
- **Safe Migration Point**: Tool Verification. Upgrading tools to use the `VerificationEngine` (DOM/API checks instead of pure screenshots) can be done one tool at a time.

---

### Conclusion & Next Steps (Phase 1)
The audit confirms that SARA has strong foundational pieces (ToolRouter, Python agent, Gemini integration) but suffers from duplicate orchestration, fragmented databases, and blocking execution loops. 

Following the implementation strategy, we should begin **PHASE 1**: Unifying core contracts, task models, memory ownership, and the context builder, before moving to task orchestration (Phase 2).

## 9. Digital-World Context Slice (2026-09-17)

### Current architecture

- **Working**: durable task state, cognitive memory modules, `CognitiveOrchestrator`, `ToolRouter`, canonical tool results, EventBus, and the Python Desktop Agent boundary.
- **Partial**: task execution and verification are present, but the live computer state is not automatically represented in the cognitive context.
- **Broken or risky**: several existing tools still report process success without state verification; screen perception is available as tools but is not yet a continuously scheduled observer.
- **Duplicate systems**: Node and Python orchestration remain separate; task and memory persistence are split across JSON and SQLite stores.
- **Security/performance risks**: unrestricted observation could capture sensitive data, while high-frequency screenshots or full-window inventories could be expensive. Observation must be bounded, permission-aware, and source-labeled.

### Implemented migration step

`src/cognitive/digitalWorldContext.ts` is now the additive source of truth for a bounded snapshot of active application/window, project, browser tabs, unfinished work, attention items, and recent observations. It persists to `data/digital-world-context.json`, emits EventBus updates, and is exposed through:

- `GET /cognitive/world-context`
- `POST /cognitive/world-context`
- `POST /cognitive/world-context/observations`

`CognitiveOrchestrator.buildContext()` includes the latest snapshot, so existing planning receives world context without replacing memory or tool execution. The next safe step is a permission-aware observer adapter that publishes verified Desktop Agent results into this store at a modest interval and on relevant task/window events.

### Migration plan

1. Add the observer adapter and explicit privacy/retention policy.
2. Bind task lifecycle events to `unfinishedWork` and attention items.
3. Add state-diff verification after desktop/browser actions.
4. Replace duplicate orchestration incrementally behind existing adapters.
5. Migrate persistence stores only after runtime ownership is measured and tested.