# SARA Real-World Product Architecture Audit

Date: 2026-09-17

## Current Architecture

SARA currently follows the intended Electron/React/Vite frontend plus Node/Express backend plus Python Desktop Agent shape. The backend entry point is primarily `server_full.ts`, with older or specialized server files still present. Tool execution flows through `ToolRouter`, `ToolRegistry`, `ToolPolicyEngine`, `ExecutionOrchestrator`, and verification modules under `src/core/tools`. Python desktop capabilities are exposed by `desktop_agent/main.py` through `/execute`, `/health`, `/capabilities`, and related endpoints.

The Python Desktop Agent owns the most real Windows integration: native input in `desktop_agent/native_input.py`, higher-level input in `desktop_agent/desktop_input_controller.py`, window management in `desktop_agent/window_manager.py`, screen capture/OCR in `desktop_agent/tools_screenshot.py`, UI Automation helpers in `desktop_agent/tools_ui_automation.py`, browser automation in `desktop_agent/tools_browser.py`, and background/orchestrator modules.

## Working Features

- Desktop Agent health and capability endpoints exist.
- Real native Windows mouse and keyboard control exists through `native_input.py` and `desktop_input_controller.py`.
- Tool registration exists for mouse move/click/drag/scroll/button down/up, keyboard type/press/hold/release, screenshots, windows, browser tools, and emergency release.
- Node-side `ToolRouter` and `ExecutionOrchestrator` produce structured execution and verification results.
- Task persistence/checkpoint code exists in `src/core/tasks`, `server_state`, and related data files.
- Browser automation exists as a Desktop-Agent-owned Playwright path, separate from normal chat lifecycle.
- Public API catalog/discovery and controlled GET-only API execution now exist.

## Partial Features

- Result contracts exist in several forms, but Python canonical results, Node unified results, and frontend task display still need one final product-level schema mapped end to end.
- Window tools can operate on HWND/title and verify some state, but minimize/maximize/close legacy responses are not as rich as list/focus responses.
- UI Automation support exists, but target selection still falls back to title/window heuristics in many workflows.
- Real-desktop test coverage existed, but the previous runner bypassed SARA’s Desktop Agent with raw `pyautogui`. It did not prove backend/frontend result agreement.
- Task management exists, but long-running multi-step tasks still need stronger resume semantics and duplicate-action protection.
- User takeover and emergency stop foundations exist, but need evidence-based E2E acceptance tests.

## Broken Features

- The previous real-desktop test runner violated the new stress-test principle by calling direct `pyautogui` scripts instead of going through Desktop Agent tools.
- The live ChatGPT browser workflow cannot be honestly marked pass unless a real browser session is available, ChatGPT is logged in, the input is focusable, the response is generated, code is detected, and clipboard contents are verified.
- Some high-risk tools, such as recycle-bin emptying, exist and need stronger policy gating before product release.

## Duplicate Systems

- Multiple backend entry points exist: `server.ts`, `server_full.ts`, mobile server files, and startup paths.
- Multiple desktop abstractions exist: TypeScript service wrappers, Python Desktop Agent tools, older `src/agents/DesktopAgent.ts`, and test-specific scripts.
- Memory exists in several layers: `MemoryService`, cognitive memory modules, JSON data files, SQLite files, and conversation stores.
- Browser interaction exists through React UI components, Desktop Agent Playwright tools, and service wrappers.

## Critical Bugs

- Any runner or workflow that bypasses SARA’s ToolRouter/Desktop Agent pipeline can report false confidence.
- Some tools still return legacy shapes that can become `UNCERTAIN` even when execution worked, unless explicit `verified` evidence is included.
- Full repo is very dirty with generated browser/cache/runtime data tracked or modified, making release validation noisy and risky.

## Security Risks

- Dangerous desktop/system tools must be explicitly policy-gated and require confirmation.
- API keys must remain backend-only and never enter frontend bundles.
- Generated code and self-improvement patches must not receive unrestricted execution rights.
- Browser automation must preserve user session privacy and never scrape/send sensitive content without explicit intent.

## Performance Risks

- Screenshot/OCR-heavy observation can become slow if used as the primary loop.
- Multiple state stores and duplicate background loops can create drift and unnecessary resource use.
- Large tracked runtime/browser-profile data increases repository and build overhead.

## Migration Plan

1. Make the real-desktop stress runner use only SARA Desktop Agent and backend result paths.
2. Normalize all Desktop Agent tool responses into the same execution/verification/reporting schema.
3. Promote verified window/screen/UI Automation observation above coordinate fallback.
4. Add task lifecycle UI: active, paused, cancelled, failed, completed, and history details.
5. Harden resumable task checkpoints and duplicate-action detection.
6. Add policy confirmation for high-risk tools and remove unsafe defaults.
7. Add E2E tests for result agreement across OS state, Python result, Node result, and frontend state.
8. Package only clean runtime assets and exclude generated cache/session data.
