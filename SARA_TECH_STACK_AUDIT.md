# SARA Technology Stack Audit

Date: 2026-08-22
Scope: repository audit only. No runtime code was modified and no mobile project was created.

## Executive Decision

**Recommended mobile technology: Capacitor with the existing React/Vite renderer reused as the first mobile client.** The current UI is React DOM with CSS/Tailwind and browser APIs, so Capacitor preserves the most visual and interaction code. Native Capacitor plugins should provide camera, microphone, notifications, secure storage, files, and network status. A later native module can be added only where browser APIs are insufficient.

React Native/Expo is viable but would require replacing DOM elements, CSS, iframe/browser assumptions, and many current components. Flutter and Kotlin maximize native control but minimize reuse. A PWA can share the renderer but cannot reliably provide secure storage, background execution, notifications, and device integration at the required level. Capacitor is therefore the compatibility-first choice, not a claim that all desktop features become mobile features.

## Inventory

| Component | Current Technology | Version | Purpose | Desktop Only | Mobile Compatible | Replacement Needed |
|---|---|---:|---|---|---|---|
| Primary language | TypeScript/JavaScript | TS 5.8.3 installed | Backend, renderer, Electron | No | Yes | No |
| Desktop agent language | Python | 3.11.9 installed | Windows execution authority | Yes | No | Mobile adapter |
| Frontend | React | 19.2.7 installed | Existing SARA renderer | No | Yes via Capacitor | No |
| DOM runtime | Browser/Electron Chromium | Electron 43.1.0 | Desktop UI shell | Electron part only | WebView on mobile | Capacitor shell |
| CSS | Tailwind CSS + custom CSS | 4.3.0 installed | Styling and layout | No | Yes with responsive audit | No |
| Vite | Vite | 6.4.3 installed | Renderer build/dev server | No | Yes | No |
| UI icons | lucide-react | 0.546.0 | Existing icons | No | Yes | No |
| Motion | motion | 12.40.0 installed | UI animation | No | Mostly | Test mobile performance |
| Node runtime | Node-compatible Electron/Node | package does not pin Node | Backend and tooling | No | Backend only | No |
| Package manager | npm | package-lock v3 | Dependency management | No | Build tooling | No |
| Backend | Express | 4.22.2 installed | REST API and static delivery | No | Shared remotely | No |
| Realtime transport | ws | 8.21.0 installed | `/live` WebSocket | No | Yes | Add authenticated mobile protocol |
| HTTP client | native `fetch`, node-fetch in WhatsApp client | project uses both | API calls | No | Yes client-side | Consolidate later |
| AI SDK | `@google/genai` | 2.8.0 installed | Gemini REST/Live integration | No | Backend only | No |
| Active model references | Gemini model strings | source currently references `gemini-3.5-flash` | Chat generation | No | Shared backend | Keep server-side |
| Desktop database | sql.js/SQLite file | 1.14.1 installed | Node conversations/tasks/sessions/tool calls | Backend-owned | API-shared | No |
| Python database | SQLite stdlib/platform stores | Python stdlib | Desktop memory/platform state | Desktop-owned | No | Adapter/API |
| JSON persistence | JSON files | N/A | Compatibility, settings, memories, logs | No | Via API/cache | No |
| RAG | Python platform RAG | source implementation | Chunk/index/retrieval | Desktop/backend | Via API | No |
| Embeddings | Python deterministic/local embedding code | source implementation | RAG similarity | Backend-owned | Via API | No |
| Vector database | JSON index, no external vector DB found | N/A | Local vector-like storage | Desktop/backend | No direct | No immediate replacement |
| Authentication | Companion token and admin token checks | source implementation | Device/admin authorization | No | Needs mobile auth | Add access/refresh flow |
| Encryption | Fernet in Android companion; HMAC-SHA256 integrity | cryptography installed 49.0.0; source HMAC | Secrets and integrity | No | Keystore required on device | Add mobile secure storage |
| Session state | Node session records + browser/local storage | source implementation | Live/conversation sessions | No | API-shared | Add mobile session protocol |
| Task management | Node task records, AutomationOrchestrator, Python agents | source implementation | Background tasks/recovery | No | API-shared | Consolidate authority later |
| Tool routing | Node ToolRouter + Python registry | source implementation | Tool ownership and dispatch | Desktop tools are | Mobile calls API | Add device-aware routing |
| Tool execution | ExecutionOrchestrator + Python `/execute` | source implementation | Execution and verification | Desktop path | Mobile command client | No replacement |
| Electron build | electron-builder | 26.15.3 installed | Windows installers | Yes | No | Keep desktop |
| Electron bundler | Electron | 43.1.0 installed | Desktop shell | Yes | No | Keep desktop |
| Python web server | FastAPI | requirements pins 0.115.6; installed 0.141.1 | Desktop Agent HTTP server | Yes | No | Keep desktop |
| Python ASGI server | uvicorn | requirements pins 0.34.0; installed 0.52.3 | Desktop Agent process | Yes | No | Keep desktop |
| Browser automation | Playwright Python | requirements pins 1.49.1; installed 1.61.0 | Desktop browser control | Yes | No direct | Route mobile requests to PC |
| Windows automation | pyautogui, pywin32, pywinauto, pygetwindow | installed 0.9.54, 312, 0.6.9, 0.0.9 | Input/window control | Yes | No | Keep Desktop Agent |
| Screen capture | Electron desktopCapturer; PIL/ImageGrab; MSS | source; Pillow installed 10.4.0; mss 10.2.0 | Desktop screen/vision | Yes | Mobile has separate capture | Add source adapter |
| OCR | pytesseract | 0.3.13 installed | Screen text extraction | Desktop path | No direct | Server/API or mobile OCR |
| Camera | Browser MediaDevices; TypeScript CameraManager; Python camera tools | source | Camera/vision | No | Yes with plugin/native API | Add mobile permission adapter |
| Microphone | Web Audio + MediaDevices | browser API | Gemini Live audio | No | Yes through Capacitor/native bridge | Add mobile audio transport |
| STT | Gemini Live/audio path; Python voice tools; Web Speech wake path | source | Speech input | No | Yes via backend/native | Clarify authoritative mobile path |
| TTS | Gemini audio playback/Web Audio; Python TTS dependencies present | source; pyttsx3 installed 2.99 | Spoken responses | No | Yes through mobile audio | Add platform output adapter |
| Wake word | browser SpeechRecognition; Porcupine/null interfaces | source | Wake detection | Browser-dependent | Not reliable in background WebView | Native/background strategy |
| Notifications | node-notifier, SMTP, webhooks | 10.0.1 installed | Desktop/admin alerts | Desktop delivery | Mobile push/local adapter | Add push provider and device token |
| Files | Node/Python filesystem tools | source | Windows file operations | Windows-specific | Android SAF/API | FileSystemAdapter |
| Windows APIs | Win32 via pywin32, PowerShell/process APIs | source | OS control/startup | Yes | No | Keep desktop |
| Startup/supervisor | TypeScript startup manager/process guard | source | Process lifecycle | Yes | No | Keep desktop |
| Logging | Node files/audit logger; Python logging/JSON | source | Diagnostics/audit | No | API-visible redacted events | No |
| Security | integrity manifest, policy engine, confirmation workflow | source | Safety and tamper checks | No | Shared policy, native storage | Add mobile auth/policy boundary |
| Tests | Node test, Playwright, Python unittest/pytest-style | source | Regression/integration | No | Add mobile/API tests | Extend |
| Build | Vite + esbuild + electron-builder | source | Desktop distribution | Desktop build | Add Capacitor build | Add mobile scripts later |
| Deployment | Windows bat/startup/Electron packaging; EAS metadata only | source | Desktop deployment | Desktop | No working mobile deployment found | Add Capacitor Android pipeline |
| Existing mobile project | None found | N/A | `app.json` and `eas.json` are metadata only | N/A | Not yet | Create only after approval |

## Important Version Findings

- `package.json` declares ranges; installed versions come from the current `npm list` inspection above.
- `desktop_agent/requirements.txt` pins older versions than the active Python environment for several packages. This drift must be resolved before reproducing the Desktop Agent in deployment; it does not justify embedding Python in the phone.
- No `android_app`, `mobile_app`, Gradle project, React Native project, Flutter project, Capacitor config, or mobile source tree exists in the workspace.

## Core Sources

- Renderer: `src/App.tsx`, `src/components/*`, `src/index.css`, `src/lib/audio.ts`.
- Backend: `server_full.ts` production build source, `server.ts` parallel source, `server_state.ts`, `server_memory.ts`.
- Desktop Agent: `desktop_agent/main.py`, `desktop_agent/registry.py`, tool modules.
- Electron: `electron/main.cjs`, `electron/preload.cjs`.
- Mobile precursor: `mobile_server.ts` and `desktop_agent/android_companion.py`; these are not a finished mobile client architecture.

## Do Not Modify During Mobile Client Work

Preserve `electron/main.cjs`, `server_full.ts`, `server.ts`, `desktop_agent/main.py`, `desktop_agent/registry.py`, Gemini integration, existing memory stores, existing ToolRouter, and existing desktop UI behavior. New mobile contracts should be additive and tested against the current APIs.
