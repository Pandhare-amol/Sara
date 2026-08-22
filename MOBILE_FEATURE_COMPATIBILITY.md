# SARA Mobile Feature Compatibility

Date: 2026-08-22
Status: audit baseline, not an implementation or acceptance report.

Legend: **AS-IS** = reusable without platform behavior change; **API-SHARED** = stays in SARA backend; **MOBILE ADAPTER** = native/mobile implementation required; **DESKTOP ONLY** = route to Windows device; **PERMISSION** = runtime permission/consent required; **PARTIAL** = existing code exists but contract is incomplete.

| SARA Feature | Desktop | Mobile | Architecture |
|---|---|---|---|
| AI chat | Yes | Yes | API-SHARED through existing backend; no API key in APK |
| Gemini | Yes | Yes | API-SHARED; Gemini remains server-owned |
| Gemini Live | Yes | Target yes | Authenticated WebSocket adapter; preserve `/live` semantics where possible |
| Conversation | Yes | Yes | API-SHARED Node session/conversation authority |
| Memory | Yes | Yes | API-SHARED; mobile cache only, no second authority |
| RAG | Yes | Yes via API | Backend retrieval; mobile submits/querys, does not own index |
| Custom datasets | Partial | Via API | Backend storage/indexing with upload permission |
| User profile | Yes | Yes | Shared profile contract; local secure token storage |
| Multi-user identity | Partial | Partial | Shared identity service; device registration and authorization required |
| Voice recognition | Partial | Yes | Native microphone/STT adapter; identity is context, not authentication |
| Voice input | Yes | Yes | Mobile audio adapter to backend Live/session transport |
| Voice output | Yes | Yes | Mobile audio playback adapter; interrupt/resume required |
| Wake word | Browser-dependent | Restricted/background-dependent | Native strategy later; do not claim always-on support initially |
| Camera | Yes | Yes | Mobile camera permission and frame-sampling adapter |
| See me/vision | Yes | Yes | Shared vision API; mobile sends selected frames only |
| Screen sharing | Desktop screen | Mobile screen with permission | Platform capture adapters; route PC screen requests to Desktop Agent |
| Screen understanding | Yes | Yes via API | Backend vision/context contract; privacy and retention policy |
| Desktop screenshot | Yes | View only | Desktop Agent capture, redacted transport to mobile |
| Browser automation | Yes | Limited | Mobile requests use backend/PC capability; mobile browser adapter only for mobile WebView |
| YouTube automation | Partial | Via PC or mobile browser | Device-aware routing; no assumption Android can control Windows browser locally |
| WhatsApp automation | Partial | Via PC/API | Explicit provider/device route; verified Web automation remains desktop capability |
| File explorer | Yes | Yes | Windows adapter versus Android Storage Access Framework |
| File management | Yes | Yes* | Device-specific FileSystemAdapter; user-selected Android files only |
| Notifications | Yes | Yes | Backend event plus desktop node-notifier and mobile push/local adapter |
| System commands | Yes | Limited | Device capability routing and policy |
| Shutdown | Yes, gated | No | Windows Desktop Agent only; confirmation must be user-originated |
| Restart | Yes, gated | No | Windows Desktop Agent only |
| Volume | Windows system | Android device | Platform adapters, distinct target device |
| Brightness | Windows system | Android device | Platform adapters, distinct target device |
| Windows automation | Yes | No | Desktop-only capability |
| Application launching | Yes | Android apps | Platform adapter and explicit device target |
| Task manager | Yes | Yes | Shared task API and events; execution remains device-specific |
| Background tasks | Yes | Yes | Backend task lifecycle; mobile receives events and notifications |
| Task recovery | Partial | Yes via API | Persist outside Gemini; reconnect/resume contract |
| Connection recovery | Partial | Yes | REST/WS lifecycle with auth refresh and context restoration |
| Tool router | Yes | Yes | Backend ToolRouter remains authoritative; add device-aware route metadata |
| Tool registry | Yes | Yes discovery | Backend registry/capability discovery; mobile displays allowed capabilities |
| Security | Yes | Yes | Shared policy plus Android Keystore/secure storage |
| Authentication | Admin/companion token | Required | Add access/refresh/device registration flow; replace raw companion token exposure |
| Settings | Yes | Yes | Shared settings API; mobile stores only device-local preferences securely |
| Logs | Yes | Redacted view | API endpoint with authorization and privacy filtering |
| Database | Backend-owned | API only/cache | No mobile copy of authoritative DB |
| Sync | Partial | Yes | Conversation, memory, task, device events through REST/WS |

## Routing Rules

- “Open YouTube on my PC” routes to the registered Windows device with `browser.control`.
- “Take a photo” routes to the requesting Android device with `camera`.
- “Show my PC screen” streams a permission-approved Desktop Agent capture to the phone.
- “Send this file from my PC” routes source file access and messaging to the Windows device; Android is only the requesting client.
- Unknown or unavailable capabilities return a truthful `UNAVAILABLE`/`REQUIRES_PERMISSION` result.

## Existing Gaps

The current `mobile_server.ts` uses a separate mobile memory namespace and directly creates Gemini clients. It should not become the final mobile backend. The existing `android_companion.py` registers and queues devices, but it is not an authenticated mobile client transport and its returned device record includes a raw token. These are migration inputs, not completed mobile support.
