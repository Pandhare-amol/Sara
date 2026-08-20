# SARA Vision Feature Status

## Current Status

| Feature | Status | Implementation | Test | Latency | Known Issues |
| --- | --- | --- | --- | --- | --- |
| Explicit camera start/stop | WORKING | `CameraManager`, `CameraPanel`, deterministic voice intents, and live `camera_vision` tool actions | Build and TypeScript validation passed | Not measured on hardware | Requires browser/Windows camera permission |
| Live camera preview | WORKING | `CameraManager` owns `getUserMedia`; `CameraPanel` renders its stream only after explicit activation | Production bundle includes the active path | Not measured on hardware | Physical camera test still required |
| One-shot vision analysis | PARTIAL | `VisionSession` captures one sampled JPEG and `/api/vision/analyze` uses the existing Gemini client | Build and TypeScript validation passed | Not measured with a live API key | Requires a configured Gemini API key and physical camera test |
| `camera_vision` AI tool | WORKING | Live Gemini function declaration plus WebSocket `vision_action` bridge | Build and TypeScript validation passed | Not measured on hardware | Tool analysis depends on the active camera UI frame |
| Screen sharing permission check | WORKING | Electron IPC `checkScreenPermission` uses `desktopCapturer` | Electron syntax and production build passed | Not measured | This is screen sharing, separate from camera vision |
| Sensitive-inference guardrails | WORKING | Server prompt limits analysis to visible, non-sensitive observations | Reviewed in route implementation | N/A | Model output remains externally generated |
| Continuous adaptive vision | NOT IMPLEMENTED | `FrameRateController` is available, but camera-to-Gemini continuous analysis is intentionally disabled | Not applicable | N/A | Continuous analysis requires an explicit product decision and quota policy |
| Camera disconnect handling | WORKING | `CameraManager` maps track `onended` to `CAMERA_DISCONNECTED` and updates the panel | TypeScript validation passed | N/A | Hardware disconnect test still required |

## Privacy

- Camera access is not requested during startup or normal conversation.
- Frames are captured in memory for a one-shot analysis and are not saved by the analysis route.
- The existing explicit photo and video save controls remain separate.
- Camera status is shown as `CAMERA: ON/OFF` and `VISION: ACTIVE/INACTIVE` in the camera panel.
- The modular subsystem is under `src/vision/`: `CameraManager`, camera states, `VisionSession`, `FrameRateController`, and the public index.

## Validation

- `npm run build` passed.
- `npm run lint` passed.
- Electron main and preload syntax checks passed.
- `camera_vision` is registered in the live Gemini function declarations and bridged through the existing audio WebSocket transport.
- Actual camera, permission denial, Gemini response, and disconnect behavior require a Windows hardware run.