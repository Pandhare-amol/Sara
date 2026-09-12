# SARA_FINAL_SYSTEM_AUDIT.md

This document serves as the repository truth, classifying each capability according to its real runtime path and execution state.

## 1. Runtime Entry Points & Architecture
- **SARA UI / Frontend**: Electron + React (`App.tsx`, `index.html`) -> **VERIFIED_WORKING**
- **Node.js Core / Backend**: `server_full.ts` is the active production server. Handles state, routing, and tool logic -> **VERIFIED_WORKING**
- **Desktop Agent Runtime**: Python FastAPI backend (`desktop_agent/main.py`) spawned by `server_full.ts` -> **VERIFIED_WORKING**
- **Gemini Intelligence Layer**: Integrated via `@google/genai` in `server_full.ts` -> **VERIFIED_WORKING**
- **Tool Registry**: `src/core/tools/toolRegistry.ts` (Node) and `desktop_agent/registry.py` (Python) -> **DUPLICATE_OR_LEGACY** (Needs consolidation around a unified Node.js router contract).

## 2. Capabilities & Subsystems

### Browser Automation
- **Playwright integration**: Code exists in `playwright.config.js` and desktop agent suites.
- **Background Agent Browser**: `desktopBrowserOpen`, `desktopBrowserSearch` -> **PARTIALLY_WORKING**
- **Visible User Browser**: The transfer between background and visible state is currently ad-hoc -> **MISSING / WIRED_BUT_UNVERIFIED**
- **Media Playback Verification**: `youtube_play`, `youtube_search` mapped to screen verifier -> **WIRED_BUT_UNVERIFIED** (Requires strict outcome verification, not just clicking).

### OS & Application Control
- **Application Resolver**: Heuristics to find apps in `desktop_agent` -> **PARTIALLY_WORKING** (Needs robust multi-strategy resolution: active window -> installed app -> start menu).
- **Window Manager**: `minimizeWindow`, `switchApplication` via Python -> **VERIFIED_WORKING**
- **Hardware Interaction (Mouse/Keyboard)**: `mouse` and `keyboard` suites exist -> **PARTIALLY_WORKING** (Needs intelligent element detection, relying strictly on coordinates is a fallback).

### File Operations
- **File System Control**: Tools like `createFile`, `readFile`, `moveFile` exist and are routed through Python/Node. -> **VERIFIED_WORKING**
- **Verification**: `FilesystemVerifier` checks exist in Node.js -> **VERIFIED_WORKING**
- **Safety / Traversal Blocking**: Basic constraints exist but need hardening -> **PARTIALLY_WORKING**

### Messaging & External Actions
- **WhatsApp Integration**: Dedicated shortcuts inside `server_full.ts` bypassing desktop agent -> **DUPLICATE_OR_LEGACY**
- **Email / Discord**: -> **PLACEHOLDER / MISSING**
- **Approval Checkpoints**: -> **PARTIALLY_WORKING** (Requires unified policy layer).

### Memory & Persistence
- **Working / Episodic Memory**: Handled by `server_memory.ts`, `data.db`, JSON files. -> **DUPLICATE_OR_LEGACY**
- **Procedural / Learning**: Restart recovery was added to tasks, but deep strategy memory is weak -> **MISSING**
- **Truth / Confidence Tracking**: Confidence scores and truth context built in `server_full.ts` -> **WIRED_BUT_UNVERIFIED**

### Task Orchestrator
- **Multi-step tasks**: `TaskRunner` with `generateDeepPlan` in `server_task_manager.ts`. -> **WIRED_BUT_UNVERIFIED**
- **Verification**: Dedicated `VerificationResult` schemas exist -> **VERIFIED_WORKING**
- **Retry / Recovery**: Implemented via checkpointing, but needs safety bounds on destructive actions -> **PARTIALLY_WORKING**

### UI Components
- **Task & Progress Indicators**: Rendered via `TaskManagerPanel.tsx` -> **VERIFIED_WORKING**
- **Duplicate Elements**: Needs visual audit to remove disconnected legacy buttons -> **PARTIALLY_WORKING**

### APIs & Web Ecosystem
- **API Catalog / Gateway**: Recently added (Phase B-D) in `src/core/api/` -> **VERIFIED_WORKING**
- **Generic Connectors**: Extended via `ApiToolAdapter` -> **VERIFIED_WORKING**
