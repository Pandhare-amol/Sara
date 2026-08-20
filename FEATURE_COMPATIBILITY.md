# SARA Feature Compatibility Matrix

Audit date: 2026-08-19
Purpose: Preserve existing functionality while adding adapters/contracts incrementally.

| Feature | Current implementation | Working status | Proposed adapter/migration point | Validation | Status |
|---|---|---:|---|---|---|
| Electron desktop shell | `electron/main.cjs` | Working | Keep entry point; wrap lifecycle health only | Electron startup/manual | Preserve |
| Existing React UI | `src/App.tsx`, `App.tsx`, `src/components/*`, `src/index.css` | Working | No redesign; use existing toast/event path | Build + UI smoke test | Preserve |
| Electron native screen capture | `electron/main.cjs` desktopCapturer IPC | Working | Keep as explicit UI capture adapter | Electron IPC tests/manual | Preserve |
| Browser screen sharing | `src/App.tsx`, `src/lib/audio.ts` | Working/legacy | Keep for explicit user sharing; do not replace with live monitor | Existing UI flow | Preserve |
| Node backend development | `server.ts` | Working | Share contracts with production backend | `npm run dev`, API tests | Preserve, reduce drift |
| Node backend production build | `server_full.ts` -> `dist/server.cjs` | Working | Establish single shared modules before consolidation | `npm run build` | Preserve |
| Node REST API | `server.ts`, `server_full.ts` | Working | Add versioned contracts without breaking routes | Health/API tests | Preserve |
| `/live` WebSocket | Node backend + `src/lib/audio.ts` | Working | Add event types compatibly | Voice/live integration | Preserve |
| Gemini Live | `@google/genai`, Node backend | Working with API key | Wrap behind `ModelProvider`; Gemini remains primary | Live/manual/API tests | Adapter later |
| Other model providers | No complete active provider router found | Partial/not wired | Add provider interface around Gemini first | Provider contract tests | Future |
| Python Desktop Agent | `desktop_agent/main.py` | Working | Treat as authoritative desktop adapter | Python startup/HTTP tests | Preserve |
| Python tool registry | `desktop_agent/registry.py`, `load_all()` | Working | Publish structured metadata as canonical registry | Registry discovery | Preserve |
| Node-to-Python bridge | `callDesktopAgent()` in `server.ts`/`server_full.ts` | Working with legacy compatibility set | Add shared `DesktopAgentAdapter` and contract validation | HTTP integration | Migrate incrementally |
| Tool result normalization | `desktop_agent/tool_result.py` + legacy handlers | Partial | Normalize at bridge boundary; preserve legacy raw data | Result contract tests | Improve |
| Python verification | `desktop_agent/verification.py` | Working/partial by tool | Make it canonical for desktop operations | Real desktop verification | Improve |
| Node task verification | `server_task_manager.ts` | Partial/duplicated | Delegate to canonical result/verification contract | Task integration | Consolidate later |
| TypeScript brain verification | `src/brain/SARACognitiveBrain.ts` | Partial/abstract | Consume authoritative task result only | Brain tests | Adapter |
| Application launching | `desktop_agent/tools_applications.py` | Real, verified process/window path | Add structured application event | Real Notepad/VS Code test | Preserve |
| Window management | `desktop_agent/tools_windows.py`, `tools_window_extra.py` | Real Win32 path | Add shared window-state DTO and event adapter | Real desktop tests | Preserve |
| File operations | `desktop_agent/tools_files.py` | Real, safe-root constrained | Keep Python implementation; route all callers through adapter | File integration tests | Preserve |
| Protected file safety | `platform_core.MemoryManager` + `tools_files.py` | Working after current upgrade | Add explicit policy contract and tests | Protected delete test | Improve |
| Browser automation | `desktop_agent/tools_browser.py`, browser session | Real Playwright path | Add browser adapter and stronger independent verification | Browser suite | Preserve |
| Default OS browser open | `tools_os_open.py`, `tools_websites.py` | Real but launch verification varies | Verify URL/window when possible | Harmless URL test | Improve |
| YouTube tools | `desktop_agent/tools_youtube.py`, browser tools, Node route | Existing | Wrap tool definitions; no rewrite | Existing YouTube tests/manual | Preserve |
| Hardware mouse/keyboard | `desktop_agent/tools_hardware.py` | Real pyautogui path | Add action postcondition adapters | Real desktop suite | Preserve |
| Volume/brightness/power | `tools_pc.py`, related tools | Real; power gated | Keep confirmation manager and non-retry policy | Safety/manual tests | Preserve |
| Camera | `tools_camera.py`, camera suite, Electron IPC | Real optional dependencies | Add capability health; preserve fallback | Camera tests/manual | Preserve |
| Gesture/vision | `vision_engine.py`, gesture modules | Optional/partial by hardware/dependencies | Keep optional and report availability accurately | Gesture tests | Preserve/degrade |
| Live screen monitor | `desktop_agent/screen_monitor.py` | Real MSS/PIL persistent capture | Make other consumers delegate here | Monitor lifecycle/real capture | Authoritative |
| Screen state/perception | `situational_awareness.py`, `perception.py` | Real window/UIA/OCR integration | Shared desktop-state adapter | Real state tests | Authoritative |
| TypeScript screen perception | `src/services/ScreenPerceptionEngine.ts` | Placeholder/partial | Replace internals with adapter to Python/Electron state; keep API | Adapter tests | Safe future change |
| OCR | Python `tools_screenshot.py`, monitor OCR hook | Optional real Tesseract | Expose capability/availability | OCR/manual tests | Preserve |
| Memory JSON API | `server_memory.ts`, `memories.json` | Working legacy | Facade/import path; preserve data | Memory API tests | Preserve |
| Node SQL state | `server_state.ts`, `data.db` | Working | Keep conversations/tasks/sessions/tool calls authoritative for Node | Persistence tests | Preserve |
| Python durable memory | `sqlite_memory.py`, `platform_core.py`, `sara_memory.db` | Working and restart-tested | Keep authoritative for Desktop Agent memory; add migrations/backups | Restart persistence | Preserve |
| TypeScript cognitive memories | `src/cognitive/*`, JSON files | Working/partial | Facade over existing stores; do not duplicate writes | Cognitive tests | Migrate incrementally |
| TypeScript MemoryService | `src/services/MemoryService.ts` | In-memory unless persistence wired | Adapter to durable stores | Persistence integration | Partial |
| TypeScript MemoryPersistenceService | `src/services/MemoryPersistenceService.ts` | Snapshot persistence | Use as controlled export/compatibility path | Snapshot tests | Preserve |
| RAG | Python `platform_core.RAG`, `tools_rag.py`; Node cognitive routes | Working/partial | Define RAG adapter and source ownership | RAG tests | Preserve |
| Learning/skills/workflows | Python platform services + TS learning services | Working/duplicated | Normalize outcome events and strategy updates | Learning/persistence tests | Consolidate later |
| Reinforcement/reward | `desktop_agent/reward_engine.py`, platform services | Working | Publish reward event from canonical result | Reward tests | Preserve |
| Conversation state | `server_state.ts`, Python `conversation_manager.py`, TS services | Working/duplicated | Keep Node `/live` conversation authority; use Python APIs for local autonomy | Conversation tests | Consolidate carefully |
| Personality/emotion | Python `personality_manager.py` | Persistent/working | Expose through context contract | Emotion persistence tests | Preserve |
| Quiet/interruption policy | Python managers | Working | Gate proactive event adapter | Quiet/proactive tests | Preserve |
| Proactive assistant | Python proactive modules | Partial but connected to live state | Event-driven adapter; no second loop | Proactive tests | Improve |
| Autonomous decision engine | Python engine + orchestrator | Partial/working loop | Consume one awareness context and emit events | Decision tests | Improve |
| Task queue/background tasks | Node `server_task_manager.ts`, Python background tools | Working/duplicated | Define one task event/status contract | Task integration | Consolidate later |
| Task cancellation/recovery | Node task states + Python recovery/checkpoints | Partial | Preserve both until adapter tests pass | Recovery tests | Improve |
| Startup supervisor | `startup/startupManager.ts` | Working | Add shared health/capability contract | Startup tests/manual | Preserve |
| Desktop Agent controller | `startup/desktopAgentController.ts` | Working/partial | Use `/health` + `/capabilities/diagnostics` | Controller tests | Improve |
| Health/diagnostics | Node startup checks + Python health APIs | Working/partial | Aggregate structured subsystem health | Health tests | Improve |
| Logging | Node text logs, Python loggers, audit logger | Working/best-effort | Add structured correlation fields/redaction | Log tests/manual | Improve |
| Security/integrity | `src/security/*`, startup integrity | Working | Preserve signed manifest and audit boundaries | Security tests | Preserve |
| Dangerous-action confirmation | Python registry/tools confirmation + Node policies | Working/critical | Centralize policy interface without weakening rules | Safety tests | Preserve |
| Secret handling | `server_paths.ts`, `.env`, secrets file | Working/partial | Centralized redaction/config facade | Secret/log tests | Improve |
| Mobile companion | `mobile_app`, `android_app`, companion routes | Existing | Keep API compatibility; no desktop-core migration required yet | Mobile tests | Preserve |
| Plugin architecture | Python plugin/service registries and tool metadata | Partial | Add manifest/health contract around current registry | Plugin tests | Extend |
| Documentation/deployment | README, phase reports, deployment guides | Extensive but fragmented | Add architecture docs and migration records | Docs review | Improve |

## Compatibility Rules

1. Existing public tool names and arguments remain valid.
2. Existing UI routes and WebSocket message types remain valid.
3. New adapters must preserve raw legacy result data while adding normalized fields.
4. Python real-desktop implementations remain authoritative until an equivalent adapter is verified.
5. No database or JSON store is deleted during migration.
6. Every migration phase requires build, targeted tests, startup health, and UI smoke validation.
