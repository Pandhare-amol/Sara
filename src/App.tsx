import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { SaraAudioSession, LiveState } from "./lib/audio";
import { isScreenCaptureUnsupported } from "./lib/screenSharePermissions";
import { hasVisualToken, visualHeaders } from "./lib/visualClient";
import { SaraCoreVisualizer, SaraEmotion } from "./components/SaraCoreVisualizer";
import { BrowserAgent } from "./components/BrowserAgent";
import { DesktopChatPanel } from "./components/DesktopChatPanel";
import { VisualAccessIndicator } from "./components/VisualAccessIndicator";
import { DesktopConversationsPanel } from "./components/DesktopConversationsPanel";
import { 
  Power, 
  Volume2, 
  Info, 
  Sparkles, 
  Globe, 
  Maximize2, 
  MessageSquareOff, 
  Compass, 
  CircleAlert,
  MicOff,
  Mic,
  X,
  Brain,
  BookOpen,
  ListTodo,
  Monitor,
  Play,
  Pause,
  Square,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldCheck,
  CalendarDays,
  Activity,
  FolderKanban
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Memory, MemoryCategory } from "./lib/memoryTypes";
import { MemoryDashboard } from "./components/MemoryDashboard";
import { TaskManagerPanel } from "../TaskManagerPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { GestureControlPanel } from "./components/GestureControlPanel";
import { CameraPanel } from "./components/CameraPanel";
import { GestureMappingEditor } from "./components/GestureMappingEditor";
import { ConfirmationPanel } from "./components/ConfirmationPanel";
import { AdminSecurityDashboard } from "./components/AdminSecurityDashboard";
import { CalendarPanel } from "./components/CalendarPanel";
import { SystemMonitorPanel } from "./components/SystemMonitorPanel";
import { ProjectManagerPanel } from "./components/ProjectManagerPanel";
import { SaraSettings, DEFAULT_SETTINGS, loadSettings, saveSettings } from "./lib/settingsStore";
import { SaraWakeWordDetector } from "./lib/wakeWord";
import { SecurityAlertPollingCursor } from "./services/securityAlertPolling";
import { apiFetch } from "./lib/userSession";
import { UserAccess } from "./components/UserAccess";
import { ApiKeyGate } from "./components/ApiKeyGate";

const ResearchLearningPanel = lazy(() => import("./components/ResearchLearningPanel").then((module) => ({ default: module.ResearchLearningPanel })));
const StudioWorkspace = lazy(() => import("./components/StudioWorkspace").then((module) => ({ default: module.StudioWorkspace })));

export default function App() {
  return <UserAccess legacyWorkspace={<ApiKeyGate><SaraWorkspace /></ApiKeyGate>} />;
}

function SaraWorkspace() {
  const [state, setState] = useState<LiveState>("disconnected");

  // Real-time Screen Sharing states
  const [isScreenSharing, setIsScreenSharing] = useState<boolean>(false);
  const [isScreenSharingPaused, setIsScreenSharingPaused] = useState<boolean>(false);
  const [screenVisionMode, setScreenVisionMode] = useState<boolean>(true);
  const [screenPreviewUrl, setScreenPreviewUrl] = useState<string | null>(null);
  const [muted, setMuted] = useState<boolean>(() => {
    try { return window.localStorage.getItem("sara.muted") === "1"; } catch { return false; }
  });
  const [toast, setToast] = useState<string | null>(null);
  const [securityAlert, setSecurityAlert] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const securityAlertCursorRef = useRef(new SecurityAlertPollingCursor());

  useEffect(() => {
    let active = true;
    const handleSecurityAlert = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: unknown }>).detail;
      setSecurityAlert(typeof detail?.message === "string" ? detail.message : "Repeated invalid admin authentication attempts detected.");
    };
    const pollSecurityAlerts = async () => {
      try {
        const response = await fetch(`/api/security/alerts?since=${securityAlertCursorRef.current.since()}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json();
        if (!active) return;
        const newest = securityAlertCursorRef.current.consume(payload.alerts);
        if (typeof newest?.message === "string") setSecurityAlert(newest.message);
      } catch { /* security alerts also arrive over the live channel when connected */ }
    };
    window.addEventListener("sara.securityAlert", handleSecurityAlert);
    void pollSecurityAlerts();
    const timer = window.setInterval(() => { void pollSecurityAlerts(); }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("sara.securityAlert", handleSecurityAlert);
    };
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    try {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    } catch {}
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2200) as unknown as number;
  };

  // References to preserve state across intervals
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenIntervalRef = useRef<any>(null);
  const screenCaptureModeRef = useRef<"stream" | "desktop">("stream");
  const desktopCaptureInFlightRef = useRef(false);
  const screenAttemptRef = useRef(0);

  const isPausedRef = useRef<boolean>(false);
  const screenVisionRef = useRef<boolean>(true);
  const stateRef = useRef<LiveState>("disconnected");

  // Sync state changes with refs to totally prevent stale closures in callbacks
  useEffect(() => {
    isPausedRef.current = isScreenSharingPaused;
  }, [isScreenSharingPaused]);

  useEffect(() => {
    screenVisionRef.current = screenVisionMode;
  }, [screenVisionMode]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // A switch into protected mode unmounts this workspace. Stop browser media
  // tracks as well as timers so an approved Live stream cannot linger.
  useEffect(() => {
    return () => {
      screenAttemptRef.current++;
      isPausedRef.current = true;
      if (screenIntervalRef.current) clearInterval(screenIntervalRef.current);
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
      sessionRef.current?.screenShareStopped();
    };
  }, []);

  const captureFrameAndSend = () => {
    const video = screenVideoRef.current;
    if (!video || isPausedRef.current || !screenVisionRef.current) {
      return;
    }

    if (stateRef.current === "disconnected") {
      return;
    }

    try {
      if (video.videoWidth === 0 || video.videoHeight === 0) return;

      if (!screenCanvasRef.current) {
        screenCanvasRef.current = document.createElement("canvas");
      }
      const canvas = screenCanvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Restrict maximum resolution size to keep payload light for Gemini Live
      const maxDim = 960;
      let width = video.videoWidth;
      let height = video.videoHeight;

      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      canvas.width = width;
      canvas.height = height;

      ctx.drawImage(video, 0, 0, width, height);

      // Highly compressed JPEG standard is optimized and preserves details perfectly
      const dataUrl = canvas.toDataURL("image/jpeg", 0.55);
      const base64 = dataUrl.split(",")[1];

      if (sessionRef.current && stateRef.current !== "disconnected") {
        sessionRef.current.sendVideoFrame(base64);
      }
    } catch (err) {
      console.error("[Screen Capture] Failed drawing frame to canvas:", err);
    }
  };

  const captureDesktopFrameAndSend = async (attempt = screenAttemptRef.current): Promise<boolean> => {
    if (attempt !== screenAttemptRef.current || isPausedRef.current || !screenVisionRef.current || desktopCaptureInFlightRef.current || !hasVisualToken()) return false;
    desktopCaptureInFlightRef.current = true;
    try {
      const response = await fetch("/api/vision/screen-capture", { method: "POST", headers: visualHeaders() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !data.imageBase64 || !data.imageMime) {
        throw new Error(data.error || "Desktop screen capture failed.");
      }
      if (attempt !== screenAttemptRef.current || isPausedRef.current || !hasVisualToken()) return false;
      setScreenPreviewUrl(`data:${data.imageMime};base64,${data.imageBase64}`);
      if (!isPausedRef.current && screenVisionRef.current && sessionRef.current && stateRef.current !== "disconnected") {
        sessionRef.current.sendVideoFrame(data.imageBase64);
      }
      return true;
    } catch (error) {
      console.error("[Screen Capture] Desktop frame failed:", error);
      return false;
    } finally {
      desktopCaptureInFlightRef.current = false;
    }
  };

  const startScreenSharing = async () => {
    const attempt = ++screenAttemptRef.current;
    isPausedRef.current = false;
    setErrorText(null);
    try {
      // First try the standard browser API
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 5 }
          },
          audio: false
        });
        if (attempt !== screenAttemptRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
      } catch (sdErr) {
        if (attempt !== screenAttemptRef.current) return;
        // A user/OS denial is final. Another backend must NOT capture a screen
        // after getDisplayMedia refused permission; fallback is unsupported-API only.
        if (!isScreenCaptureUnsupported(sdErr, typeof navigator.mediaDevices?.getDisplayMedia === "function")) throw sdErr;
        // A missing browser API may use the separately approved desktop-agent
        // scope. Never use implicit Electron sources or switch on user denial.
        if (!stream && isScreenCaptureUnsupported(sdErr, typeof navigator.mediaDevices?.getDisplayMedia === "function")) {
          const captured = await captureDesktopFrameAndSend(attempt);
          if (captured && attempt === screenAttemptRef.current) {
            screenCaptureModeRef.current = "desktop";
            setIsScreenSharing(true);
            setIsScreenSharingPaused(false);
            if (screenIntervalRef.current) clearInterval(screenIntervalRef.current);
            screenIntervalRef.current = setInterval(() => {
              void captureDesktopFrameAndSend();
            }, 2000);
            return;
          }
        }
        if (!stream) throw sdErr;
      }

      if (attempt !== screenAttemptRef.current) {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      screenStreamRef.current = stream as MediaStream;
      screenCaptureModeRef.current = "stream";
      setScreenPreviewUrl(null);

      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      video.play().catch(e => console.error("Video play warning:", e));
      screenVideoRef.current = video;

      setIsScreenSharing(true);
      setIsScreenSharingPaused(false);

      // Stop handling when native stop sharing bar button ends
      stream.getVideoTracks()[0].onended = () => {
        stopScreenSharing();
      };

      // Set up frame capture interval (one frame every 2 seconds is highly robust, preventing overload)
      if (screenIntervalRef.current) {
        clearInterval(screenIntervalRef.current);
      }
      screenIntervalRef.current = setInterval(() => {
        captureFrameAndSend();
      }, 2000);

      // Promptly capture first frame immediately
      setTimeout(() => {
        captureFrameAndSend();
      }, 500);

    } catch (e: any) {
      if (attempt !== screenAttemptRef.current) return;
      console.error("Screen sharing could not start:", e);
      if (!isScreenCaptureUnsupported(e, typeof navigator.mediaDevices?.getDisplayMedia === "function")) {
        setErrorText("Screen sharing was not authorized or the requested source was unavailable. Please use the Share Screen button if you want to try again.");
        return;
      }
      // Electron has its own explicit picker in the main process. No retry via
      // alternate sources after a denied request; no clipboard/IPC workaround.
      console.warn("[Screen Capture] No authorized stream was obtained.");
      setErrorText(!hasVisualToken()
        ? "Browser screen sharing is unsupported here. Open Tasks and explicitly approve short-lived visual access to observe a scoped window or display instead."
        : `Could not capture the approved screen scope: ${e?.message || e}`);
    }
  };

  const stopScreenSharing = () => {
    screenAttemptRef.current++;
    isPausedRef.current = true;
    sessionRef.current?.screenShareStopped();
    if (screenIntervalRef.current) {
      clearInterval(screenIntervalRef.current);
      screenIntervalRef.current = null;
    }

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
      screenStreamRef.current = null;
    }

    if (screenVideoRef.current) {
      screenVideoRef.current.pause();
      screenVideoRef.current = null;
    }

    setIsScreenSharing(false);
    setIsScreenSharingPaused(false);
    screenCaptureModeRef.current = "stream";
    setScreenPreviewUrl(null);
  };

  const pauseScreenSharing = () => {
    isPausedRef.current = true;
    sessionRef.current?.screenShareStopped();
    setIsScreenSharingPaused(true);
  };

  const resumeScreenSharing = () => {
    isPausedRef.current = false;
    setIsScreenSharingPaused(false);
    // Refresh first frame immediately
    setTimeout(() => {
      captureFrameAndSend();
    }, 100);
  };

  const switchScreenShare = async () => {
    stopScreenSharing();
    await startScreenSharing();
  };

  const [activeEmotion, setActiveEmotion] = useState<SaraEmotion>("idle");
  const [themeColor, setThemeColor] = useState<string>("charcoal");
  const [userCaption, setUserCaption] = useState<string>("");
  const [characterState, setCharacterState] = useState<"idle" | "thinking" | "talking">("idle");

  const detectEmotionFromText = (text: string): SaraEmotion => {
    const lower = text.toLowerCase();
    if (lower.includes("haha") || lower.includes("lol") || lower.includes("funny") || lower.includes("joke") || lower.includes("hehe") || lower.includes("wink")) return "playful";
    if (lower.includes("happy") || lower.includes("harmony") || lower.includes("glad") || lower.includes("joy") || lower.includes("wonderful") || lower.includes("love") || lower.includes("smile")) return "happy";
    if (lower.includes("wow") || lower.includes("awesome") || lower.includes("excited") || lower.includes("amazing") || lower.includes("yay") || lower.includes("incredible") || lower.includes("hype")) return "excited";
    if (lower.includes("really?") || lower.includes("curious") || lower.includes("interest") || lower.includes("tell me more") || lower.includes("why") || lower.includes("how") || lower.includes("wonder")) return "curious";
    if (lower.includes("think") || lower.includes("calculat") || lower.includes("analyz") || lower.includes("hmmm") || lower.includes("process") || lower.includes("let me see") || lower.includes("conclude")) return "thinking";
    if (lower.includes("proud") || lower.includes("achieved") || lower.includes("expert") || lower.includes("skill") || lower.includes("confidence") || lower.includes("succeed")) return "proud";
    if (lower.includes("sad") || lower.includes("sorry") || lower.includes("unfortunate") || lower.includes("grief") || lower.includes("bad") || lower.includes("regret") || lower.includes("alas") || lower.includes("cry")) return "sad";
    if (lower.includes("shock") || lower.includes("surprise") || lower.includes("gasp") || lower.includes("unexpected") || lower.includes("seriously") || lower.includes("oh my")) return "surprised";
    if (lower.includes("blush") || lower.includes("shy") || lower.includes("embarrass") || lower.includes("nervous") || lower.includes("oops") || lower.includes("sorry about")) return "embarrassed";
    if (lower.includes("what?") || lower.includes("confus") || lower.includes("puzzled") || lower.includes("dont know") || lower.includes("not sure") || lower.includes("wait")) return "confused";
    return "idle";
  };
  const [modelCaption, setModelCaption] = useState<string>("");
  const [activeProjectorUrl, setActiveProjectorUrl] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState<boolean>(false);
  const [showDesktopChat, setShowDesktopChat] = useState<boolean>(false);
  const [showDesktopConversations, setShowDesktopConversations] = useState<boolean>(false);
  const [desktopConversationId, setDesktopConversationId] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [storedConversationId, setStoredConversationId] = useState<string | null>(null);
  const [showConvPanel, setShowConvPanel] = useState<boolean>(false);

  // Sara Autopilot system controller state
  const [browserTrigger, setBrowserTrigger] = useState<{
    type: string;
    args: any;
    id: string;
    callback: (res: any) => void;
  } | null>(null);

  // Sara recollections database core state
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState<boolean>(false);
  const [memoriesError, setMemoriesError] = useState<string | null>(null);
  const [showMemoryDashboard, setShowMemoryDashboard] = useState<boolean>(false);
  const [showTaskManager, setShowTaskManager] = useState(false);
  const [showResearchLearning, setShowResearchLearning] = useState(false);
  const [showStudio, setShowStudio] = useState(false);
  const [showCalendarPanel, setShowCalendarPanel] = useState<boolean>(false);
  const [showSystemMonitor, setShowSystemMonitor] = useState<boolean>(false);
  const [showProjectManager, setShowProjectManager] = useState<boolean>(false);
  const [showQuickChat, setShowQuickChat] = useState<boolean>(false);
  const voiceConversationIdRef = useRef<string | null>(null);
  const voiceResponseDraftRef = useRef("");

  // V2: Settings + wake word state
  const [settings, setSettings] = useState<SaraSettings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showGesturePanel, setShowGesturePanel] = useState<boolean>(false);
  const [showCameraPanel, setShowCameraPanel] = useState<boolean>(false);
  const [cameraCommand, setCameraCommand] = useState<{
    action: string; question?: string; duration?: number; respond: (result: unknown) => void;
  } | null>(null);
  const cameraCommandRef = useRef<typeof cameraCommand>(null);
  useEffect(() => {
    if (!cameraCommand || !showCameraPanel) return;
    const resolveCommand = (result: unknown) => {
      if (cameraCommandRef.current !== cameraCommand) return;
      cameraCommandRef.current = null;
      setCameraCommand(null);
      cameraCommand.respond(result);
    };
    const expired = window.setTimeout(() => resolveCommand({ ok: false, error: "The camera action timed out; completion was not verified." }), 30_000);
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("sara-camera-action", { detail: { ...cameraCommand, respond: resolveCommand } }));
    }, 0);
    return () => { window.clearTimeout(timer); window.clearTimeout(expired); };
  }, [cameraCommand, showCameraPanel]);
  const [showMappingEditor, setShowMappingEditor] = useState<boolean>(false);
  const [showConfirmPanel, setShowConfirmPanel] = useState<boolean>(false);
  const [showAdminSecurity, setShowAdminSecurity] = useState<boolean>(false);
  const showSettingsRef = useRef<boolean>(false);
  useEffect(() => { showSettingsRef.current = showSettings; }, [showSettings]);

  // V2: Wake word detector instance (Web Speech API, lives for the app lifetime)
  const wakeDetectorRef = useRef<SaraWakeWordDetector | null>(null);
  // Ref indirection so the wake-word callback always calls the latest connect
  // handler, regardless of where it's declared in the component body.
  const connectHandlerRef = useRef<() => void>(() => {});

  // Initialize wake detector once on mount.
  useEffect(() => {
    const det = new SaraWakeWordDetector();
    wakeDetectorRef.current = det;
    return () => {
      det.stop();
    };
  }, []);

  // Auto-enable gesture control if user preference enabled
  useEffect(() => {
    try {
      if (settings.autoEnableGesture) {
        // Enable only through the active backend, and surface HTTP-level agent
        // failures instead of treating any resolved fetch as success.
        fetch('/api/vision/enable', { method: 'POST' })
          .then(async (response) => {
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result?.ok === false) {
              console.warn('[Vision] Gesture control was not enabled:', result?.error || response.statusText);
            }
          })
          .catch((error) => console.warn('[Vision] Gesture control request failed:', error));
      }
    } catch (e) { /* ignore */ }
  }, [settings.autoEnableGesture]);

  // Start / stop wake word detection when the setting changes.
  useEffect(() => {
    const det = wakeDetectorRef.current;
    if (!det) return;
    if (settings.wakeWordEnabled && state === "disconnected" && !muted) {
      det.start({
        phrase: settings.wakePhrase,
        sensitivity: settings.sensitivity,
        onTriggered: () => {
          // When wake word fires, stop detector and connect SARA.
          det.stop();
          connectHandlerRef.current();
        },
      });
    } else {
      det.stop();
    }
  }, [settings.wakeWordEnabled, settings.wakePhrase, settings.sensitivity, state, muted]);

  // Handle settings changes: persist to localStorage + update state.
  const handleSettingsChange = (patch: Partial<SaraSettings>) => {
    const next = saveSettings(patch);
    setSettings(next);
  };

  const sessionRef = useRef<SaraAudioSession | null>(null);

  const loadMemories = async () => {
    setMemoriesLoading(true);
    setMemoriesError(null);
    try {
      const response = await apiFetch("/api/memories", { cache: "no-store" });
      if (!response.ok) throw new Error(`Memory service returned ${response.status}.`);
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error("Memory service returned an invalid response.");
      setMemories(data);
    } catch (err) {
      console.error("[Recall] Memory load failed:", err);
      setMemoriesError("Unable to load memories.");
    } finally {
      setMemoriesLoading(false);
    }
  };

  // Fetch initial recollections from the existing memory service.
  useEffect(() => { void loadMemories(); }, []);

  const handleAddManualMemory = async (category: MemoryCategory, text: string, expiresAt?: string) => {
    const resp = await apiFetch("/api/memories", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, text, expiresAt }),
    });
    const saved = await resp.json();
    if (!resp.ok || !saved?.id) throw new Error(saved?.error || "Could not save memory.");
    setMemories((prev) => [...prev, saved]);
  };

  const handleUpdateMemory = async (id: string, category: MemoryCategory, text: string, expiresAt?: string) => {
    const resp = await apiFetch(`/api/memories/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, text, expiresAt }),
    });
    const saved = await resp.json();
    if (!resp.ok || !saved?.id) throw new Error(saved?.error || "Could not update memory.");
    setMemories((prev) => prev.map((memory) => memory.id === id ? saved : memory));
  };

  const handleDeleteMemory = async (id: string) => {
    try {
      const resp = await apiFetch(`/api/memories/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
      const resObj = await resp.json();
      if (!resp.ok || !resObj?.success) throw new Error(resObj?.error || "Could not delete memory.");
      if (resObj && resObj.success) {
        setMemories((prev) => prev.filter(m => m.id !== id));
      }
    } catch (err) {
      console.error("Manual memory delete execution failed:", err);
    }
  };

  // Initialize the audio session handlers once on mount
  useEffect(() => {
    sessionRef.current = new SaraAudioSession({
      onStateChange: (newState) => {
        setState(newState);
        if (newState === "disconnected") {
          // Reset captions on disconnect
          setUserCaption("");
          setModelCaption("");
          setActiveEmotion("idle");
          setCharacterState("idle");
        } else if (newState === "listening") {
          // Return to receptive resting state
          setActiveEmotion("idle");
          setCharacterState("idle");
        } else if (newState === "speaking") {
          setCharacterState("talking");
        }
      },
      onTranscription: (role, transcriptText) => {
        const conversationId = voiceConversationIdRef.current;
        if (role === "user") {
          voiceResponseDraftRef.current = "";
          if (conversationId && transcriptText.trim()) {
            window.dispatchEvent(new CustomEvent("sara.voiceConversationTurn", { detail: { conversationId, role: "user", text: transcriptText.trim() } }));
          }
          setUserCaption(transcriptText);
          // Auto-clear the other caption when user starts talking
          setModelCaption("");
          setCharacterState("thinking");
          try {
            const lower = String(transcriptText || "").toLowerCase();
            // Camera actions are performed only through camera_vision's
            // result-bearing tool call. A transcription alone is not consent or
            // evidence of capture; firing here also duplicated a model tool.
            const galleryRe = /(?:open|show) (?:camera )?gallery/i;
            const enableGestureRe = /enable hand gesture control|enable gestures|turn on gestures/i;
            const disableGestureRe = /disable hand gesture control|disable gestures|turn off gestures/i;
            if (galleryRe.test(transcriptText)) {
              setShowCameraPanel(true);
              window.dispatchEvent(new CustomEvent('sara-camera-action', { detail: { action: 'openGallery' } }));
            } else if (enableGestureRe.test(transcriptText)) {
              window.dispatchEvent(new CustomEvent('sara-vision-action', { detail: { action: 'enable' } }));
            } else if (disableGestureRe.test(transcriptText)) {
              window.dispatchEvent(new CustomEvent('sara-vision-action', { detail: { action: 'disable' } }));
            }
          } catch (e) { console.warn('Voice camera command parse failed', e); }
        } else if (role === "model") {
          voiceResponseDraftRef.current += transcriptText;
          const conversationId = voiceConversationIdRef.current;
          const modelText = voiceResponseDraftRef.current.trim();
          if (conversationId && modelText) {
            window.dispatchEvent(new CustomEvent("sara.voiceConversationTurn", { detail: { conversationId, role: "assistant", text: modelText } }));
          }
          voiceResponseDraftRef.current = "";
          setModelCaption((prev) => {
            const next = prev + transcriptText;
            const newEmotion = detectEmotionFromText(next);
            setActiveEmotion(newEmotion);
            return next;
          });
          // Clear user caption when model replies
          setUserCaption("");
        }
      },
      onToolCall: (name, args, callback) => {
        // Argument values may include private camera requests; do not log them.
        console.log(`[App] Tool call triggered: ${name}`);
        if (name === "camera_vision") {
          const action = String(args?.action || "");
          if (!["start", "stop", "status", "analyze", "photo", "record_start", "record_stop"].includes(action)) {
            callback({ ok: false, error: "Unsupported camera action." });
            return;
          }
          if (cameraCommandRef.current) {
            callback({ ok: false, error: "Another camera request is still pending." });
            return;
          }
          const command = { action, question: typeof args.question === "string" ? args.question.slice(0, 400) : undefined,
            duration: typeof args.duration === "number" ? args.duration : undefined, respond: callback };
          cameraCommandRef.current = command;
          setCameraCommand(command);
          setShowCameraPanel(true);
          return;
        }

        const browserTools = [
          "browserOpen",
          "browserSearch",
          "browserClick",
          "browserMediaControl",
          "browserScroll",
          "browserType",
          "browserGoBack",
          "browserTabAction",
          "openWebsite"
        ];

        if (browserTools.includes(name)) {
          // Bring up the Holographic Browser Controller if it is not active
          if (!activeProjectorUrl) {
            let startingUrl = "https://youtube.com";
            if ((name === "browserOpen" || name === "openWebsite") && args.url) {
              startingUrl = args.url;
            }
            setActiveProjectorUrl(startingUrl);
          }

          // Map instructions directly onto Browser Agent
          setBrowserTrigger({
            type: name === "openWebsite" ? "browserOpen" : name,
            args,
            id: Math.random().toString(),
            callback: (res) => {
              callback(res);
              setBrowserTrigger(null);
            }
          });
        } else if (name === "changeBackground") {
          const colorName = args.color?.toLowerCase();
          const validColors = ["violet", "crimson", "emerald", "celestial", "gold", "rose", "charcoal"];
          
          if (colorName && validColors.includes(colorName)) {
            setThemeColor(colorName);
            callback({ result: `Successfully shifted aesthetic atmosphere to ${colorName}.` });
          } else {
            callback({ error: `Unsupported color '${colorName}'. Supported themes are: ${validColors.join(", ")}` });
          }
        } else {
          callback({ error: `Tool ${name} is not implemented.` });
        }
      },
      onError: (err) => {
        setErrorText(err);
      },
      onMemorySync: (updatedMemories) => {
        console.log("[App] WebSocket memories sync triggered:", updatedMemories);
        if (Array.isArray(updatedMemories)) {
          setMemories(updatedMemories);
        }
      },
      onAutomationEvent: (event) => {
        const task = event?.task;
        if (!task) return;
        window.dispatchEvent(new CustomEvent("sara.automationEvent", { detail: {
          task_id: task.task_id, status: task.status, conversationId: task.conversationId,
        } }));
        const label = task.tool === "youtube_play" ? "YouTube" : String(task.tool || "Task");
        // Only one toast per meaningful transition; progress remains in the
        // task panel rather than piling up over the user's next voice turn.
        if (event.type === "automation:completed") showToast(`${label}: verified and completed`);
        else if (event.type === "automation:failed") showToast(`${label}: stopped or failed; check task status`);
        else if (event.type === "RECOVERY_PAUSED") showToast(`${label}: outcome needs review`);
        else if (event.type === "automation:cancel_requested") showToast(`${label}: stop requested; result pending`);
        else if (event.type === "automation:started") showToast(`${label}: working in background`);
      },
      onDesktopEvent: (event) => {
        if (event?.event === "application_opened") {
          const output = event.output || {};
          const label = output?.raw_result?.resolved?.label || output?.resolved?.label || output?.application || event.tool || "Application";
          const title = output?.raw_result?.window?.title || output?.window?.title;
          showToast(`SARA opened ${label}${title ? ` — ${title}` : ""}`);
        } else if (event?.event === "application_open_failed") {
          showToast(`SARA could not open ${event.application || event.tool || "the application"}`);
        }
      }
      ,
      onWake: async (info) => {
        try {
          if (sessionRef.current?.isMuted()) {
            showToast("Wake ignored: microphone is muted in this app.");
            return;
          }
          // Play a brief activation chime locally
          const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
          if (Ctx) {
            const ctx: AudioContext = new Ctx();
            const now = ctx.currentTime;
            const notes = [ { f: 880, t: 0 }, { f: 1320, t: 0.09 } ];
            notes.forEach(({ f, t }) => {
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.type = 'sine';
              osc.frequency.value = f;
              gain.gain.setValueAtTime(0.0001, now + t);
              gain.gain.exponentialRampToValueAtTime(0.15, now + t + 0.01);
              gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.18);
              osc.connect(gain);
              gain.connect(ctx.destination);
              osc.start(now + t);
              osc.stop(now + t + 0.2);
            });
            setTimeout(() => ctx.close().catch(() => {}), 600);
          }

          // If disconnected, connect the live audio session so the mic is captured
          if (sessionRef.current && state === 'disconnected') {
            voiceConversationIdRef.current = desktopConversationId || window.localStorage.getItem("sara.conversationId");
            await sessionRef.current.connect(voiceConversationIdRef.current);
            try { sessionRef.current.setMuted(false); } catch {}
            setMuted(false);
            showToast('Listening...');
          } else if (sessionRef.current && sessionRef.current.isMuted && sessionRef.current.isMuted()) {
            try { sessionRef.current.setMuted(false); } catch {}
            setMuted(false);
          }
        } catch (e) { console.warn('Wake handler failed', e); }
      }
    });

    return () => {
      if (sessionRef.current) {
        sessionRef.current.disconnect();
      }
    };
  }, []);

  // Initialize muted state from localStorage on first load
  useEffect(() => {
    try {
      const v = window.localStorage.getItem("sara.muted");
      if (v === "1") {
        setMuted(true);
        try { sessionRef.current?.setMuted(true); } catch {}
      } else {
        setMuted(false);
        try { sessionRef.current?.setMuted(false); } catch {}
      }
    } catch {}
  }, []);

  // Track stored conversationId in localStorage so the header control can show it
  useEffect(() => {
    try {
      const s = window.localStorage.getItem("sara.conversationId");
      setStoredConversationId(s);
      if (!s) {
        setShowQuickChat(false);
        setShowDesktopChat(true);
      }
    } catch {}
    const onStorage = (e: StorageEvent) => {
      if (e.key === "sara.conversationId") setStoredConversationId(e.newValue ?? null);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const handleResumeStoredConversation = async () => {
    if (!storedConversationId) return;
    try {
      // Ensure local copy exists and open chat panel
      window.localStorage.setItem("sara.conversationId", storedConversationId);
      setDesktopConversationId(storedConversationId);
      voiceConversationIdRef.current = storedConversationId;
      setShowConvPanel(false);
      if (sessionRef.current && state === "disconnected") {
        await sessionRef.current.connect(storedConversationId);
      }
    } catch (e) {
      console.error('Resume failed', e);
    }
  };

  const handleClearStoredConversation = () => {
    try {
      window.localStorage.removeItem("sara.conversationId");
      setStoredConversationId(null);
      setDesktopConversationId(null);
      setShowConvPanel(false);
    } catch (e) {}
  };

  const handleToggleConnection = async () => {
    setErrorText(null);
    if (!sessionRef.current) return;

    if (state === "disconnected") {
      // Connect the audio session
      voiceConversationIdRef.current = desktopConversationId || window.localStorage.getItem("sara.conversationId");
      // Honor the visible user's last mute choice before opening the device.
      let startMuted = false;
      try { startMuted = window.localStorage.getItem("sara.muted") === "1"; } catch {}
      sessionRef.current.setMuted(startMuted);
      setMuted(startMuted);
      await sessionRef.current.connect(voiceConversationIdRef.current);
    } else {
      // If already connected, toggle mute/unmute instead of disconnecting
      const next = !muted;
      try { sessionRef.current.setMuted(next); } catch {}
      setMuted(next);
      try { window.localStorage.setItem("sara.muted", next ? "1" : "0"); } catch {}
      showToast(next ? "Microphone muted" : "Microphone unmuted");
    }
  };

  const switchVoiceConversation = async (conversationId: string | null) => {
    voiceConversationIdRef.current = conversationId;
    try {
      if (conversationId) window.localStorage.setItem("sara.conversationId", conversationId);
      else window.localStorage.removeItem("sara.conversationId");
    } catch {}

    const session = sessionRef.current;
    if (!session || session.getState() === "disconnected") return;
    session.disconnect();
    if (conversationId) await session.connect(conversationId);
  };
  // V2: keep the ref in sync so the wake-word callback calls this exact handler.
  connectHandlerRef.current = handleToggleConnection;

  // Maps theme colors to CSS ambient light spots
  const getAmbientStyles = () => {
    switch (themeColor) {
      case "violet":
        return "from-purple-950/40 via-violet-950/20 to-slate-950";
      case "crimson":
        return "from-red-950/40 via-orange-950/20 to-slate-950";
      case "emerald":
        return "from-emerald-950/40 via-teal-950/20 to-slate-950";
      case "celestial":
        return "from-sky-950/45 via-indigo-950/25 to-slate-950";
      case "gold":
        return "from-amber-950/30 via-yellow-950/15 to-slate-950";
      case "rose":
        return "from-rose-950/40 via-pink-950/20 to-slate-950";
      case "charcoal":
      default:
        return "from-slate-900/50 via-slate-950/30 to-slate-950";
    }
  };

  const getThemeTextGlow = () => {
    switch (themeColor) {
      case "violet": return "text-purple-400 drop-shadow-[0_0_12px_rgba(168,85,247,0.5)]";
      case "crimson": return "text-rose-400 drop-shadow-[0_0_12px_rgba(244,63,94,0.5)]";
      case "emerald": return "text-emerald-400 drop-shadow-[0_0_12px_rgba(16,185,129,0.5)]";
      case "celestial": return "text-sky-400 drop-shadow-[0_0_12px_rgba(14,165,233,0.5)]";
      case "gold": return "text-amber-400 drop-shadow-[0_0_12px_rgba(245,158,11,0.5)]";
      case "rose": return "text-pink-400 drop-shadow-[0_0_12px_rgba(244,63,94,0.5)]";
      case "charcoal":
      default:
        return "text-indigo-400 drop-shadow-[0_0_12px_rgba(99,102,241,0.5)]";
    }
  };

  const getOrbRingColor = () => {
    switch (state) {
      case "listening": return "border-indigo-500/50 shadow-[0_0_30px_rgba(99,102,241,0.3)] bg-indigo-500/10";
      case "speaking": return "border-purple-500/70 shadow-[0_0_40px_rgba(168,85,247,0.4)] bg-purple-500/10";
      case "connecting": return "border-amber-500/50 animate-pulse bg-amber-500/10";
      case "disconnected":
      default:
        return "border-white/10 hover:border-indigo-500/30 bg-white/5";
    }
  };

  return (
    <div
      id="sara-holographic-desktop"
      className={`relative w-full h-screen overflow-hidden bg-[#020205] text-white ${getAmbientStyles()} theme-transition flex flex-col justify-between p-6 sm:p-10 select-none`}
    >
      {/* Ambient Background Gradients matching Frosted Glass theme */}
      <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] bg-purple-900/15 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] bg-cyan-900/15 rounded-full blur-[150px] pointer-events-none" />
      <div className="absolute top-[20%] right-[10%] w-[300px] h-[300px] bg-indigo-800/10 rounded-full blur-[100px] pointer-events-none" />

      {/* Decorative grid pattern background */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.012)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.012)_1px,transparent_1px)] bg-[size:32px_32px] pointer-events-none opacity-40" />

      {/* FULL VIEWPORT HOLOGRAPHIC STAGE: Sara materializes across the entire screen */}
      <div className="absolute inset-0 z-0 pointer-events-none select-none">
        <SaraCoreVisualizer
          session={sessionRef.current}
          state={state}
          themeColor={themeColor}
          activeEmotion={activeEmotion}
          characterState={characterState}
        />
      </div>

      {/* HEADER SECTION - Minimalist typography */}
      <header className="relative z-30 flex items-center justify-between w-full max-w-5xl mx-auto select-none">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-[0.4em] text-white/50 uppercase font-sans">
            Sara
          </span>
          <div className={`w-1.5 h-1.5 rounded-full ${
            state === "listening" || state === "speaking" 
              ? "bg-cyan-400" 
              : "bg-white/10"
          }`} />
        </div>

        <div className="flex items-center gap-5">
          {/* Faint utilities hidden in margin */}
          <button
            onClick={() => setShowGuide(!showGuide)}
            className="flex items-center gap-1 opacity-25 hover:opacity-100 text-white transition text-xs font-mono tracking-widest cursor-pointer"
            title="Sway Themes and Info"
          >
            <Compass size={14} />
            <span className="hidden sm:inline">TOPICS</span>
          </button>
          
          <button 
            onClick={() => setShowMemoryDashboard(!showMemoryDashboard)}
            className="flex items-center gap-1 opacity-25 hover:opacity-100 text-white transition text-xs font-mono tracking-widest cursor-pointer"
            title="Recollections Database"
          >
            <Brain size={14} />
            <span className="hidden sm:inline">RECALLS</span>
          </button>

          <VisualAccessIndicator onOpen={() => setShowTaskManager(true)} browserSharing={isScreenSharing}
            browserPaused={isScreenSharingPaused} onStopBrowserSharing={stopScreenSharing} />
          <button
            onClick={() => setShowTaskManager((value) => !value)}
            aria-label="Open task workflows"
            className={`flex items-center gap-1 transition text-xs font-mono tracking-widest cursor-pointer ${showTaskManager ? "text-cyan-400 opacity-100" : "opacity-25 hover:opacity-100 text-white"}`}
            title="Reviewed tasks and browser workflows"
          >
            <ListTodo size={14} />
            <span className="hidden sm:inline">TASKS</span>
          </button>

          <button onClick={() => { setShowResearchLearning(true); setShowStudio(false); }}
            className="flex items-center gap-1 text-xs font-mono tracking-widest text-white/55 hover:text-cyan-300"
            aria-label="Open research and learning dashboard" title="Source-grounded learning (local owner only)">
            <BookOpen size={14} /><span className="hidden sm:inline">LEARN</span>
          </button>
          <button onClick={() => { setShowStudio(true); setShowResearchLearning(false); }}
            className="flex items-center gap-1 text-xs font-mono tracking-widest text-white/55 hover:text-fuchsia-300"
            aria-label="Open creative studio" title="Validated private artifact workspace (local owner only)">
            <Sparkles size={14} /><span className="hidden sm:inline">CREATE</span>
          </button>

          {/* Real-time screen sharing toggler button inside Sara glass style header */}
          <button
            onClick={() => setShowCalendarPanel((value) => !value)}
            className={`flex items-center gap-1 transition text-xs font-mono tracking-widest cursor-pointer ${
              showCalendarPanel ? "text-cyan-400 opacity-100 font-semibold" : "opacity-25 hover:opacity-100 text-white"
            }`}
            title="Local calendar"
            aria-label="Open local calendar"
          >
            <CalendarDays size={14} />
            <span className="hidden sm:inline">CALENDAR</span>
          </button>

          <button
            onClick={() => setShowSystemMonitor(true)}
            className={`flex items-center gap-1 transition text-xs font-mono tracking-widest cursor-pointer ${
              showSystemMonitor ? "text-cyan-400 opacity-100 font-semibold" : "opacity-25 hover:opacity-100 text-white"
            }`}
            title="System resource monitor"
            aria-label="Open system resource monitor"
          >
            <Activity size={14} />
            <span className="hidden sm:inline">SYSTEM</span>
          </button>

          <button
            onClick={() => setShowProjectManager(true)}
            className={`flex items-center gap-1 transition text-xs font-mono tracking-widest cursor-pointer ${
              showProjectManager ? "text-cyan-400 opacity-100 font-semibold" : "opacity-25 hover:opacity-100 text-white"
            }`}
            title="General project and task manager"
            aria-label="Open project manager"
          >
            <FolderKanban size={14} />
            <span className="hidden sm:inline">PROJECTS</span>
          </button>

          <button 
            onClick={isScreenSharing ? stopScreenSharing : startScreenSharing}
            className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer ${
              isScreenSharing 
                ? "text-cyan-400 opacity-100 font-semibold" 
                : "opacity-25 hover:opacity-100 text-white"
            }`}
            title="Share Screen with Sara"
          >
            <Monitor size={14} className={isScreenSharing && !isScreenSharingPaused ? "animate-pulse text-cyan-400" : ""} />
            <span>{isScreenSharing ? "SHARING" : "SHARE SCREEN"}</span>
          </button>

          <button
            onClick={() => setShowQuickChat((v) => !v)}
            className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer ${
              showQuickChat
                ? "text-cyan-400 opacity-100 font-semibold"
                : "opacity-25 hover:opacity-100 text-white"
            }`}
            title="Quick chat with Sara"
          >
            <MessageSquareOff size={14} className={showQuickChat ? "text-cyan-300" : ""} />
            <span>QUICK CHAT</span>
          </button>

          <button
            onClick={() => setShowAdminSecurity(!showAdminSecurity)}
            className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer ${
              showAdminSecurity
                ? "text-cyan-400 opacity-100 font-semibold"
                : "opacity-25 hover:opacity-100 text-white"
            }`}
            title="Owner & Security Dashboard"
          >
            <ShieldCheck size={14} className={showAdminSecurity ? "text-cyan-300 animate-pulse" : ""} />
            <span className="hidden sm:inline">SECURITY</span>
          </button>

          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer ${
              showSettings
                ? "text-cyan-400 opacity-100 font-semibold"
                : "opacity-25 hover:opacity-100 text-white"
            }`}
            title="Sara Configuration"
          >
            <SettingsIcon size={14} className={showSettings ? "animate-spin [animation-duration:6s]" : ""} />
            <span>SETTINGS</span>
          </button>
          <button
            onClick={() => setShowCameraPanel((v) => !v)}
            className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer ${
              showCameraPanel
                ? "text-cyan-400 opacity-100 font-semibold"
                : "opacity-25 hover:opacity-100 text-white"
            }`}
            title="Camera"
          >
            <Play size={14} />
            <span>CAMERA</span>
          </button>
        </div>
      </header>

      {showGesturePanel && <GestureControlPanel onClose={() => setShowGesturePanel(false)} />}
      {showCameraPanel && <CameraPanel onClose={() => {
        const pending = cameraCommandRef.current;
        if (pending) {
          cameraCommandRef.current = null;
          setCameraCommand(null);
          pending.respond({ ok: false, error: "Camera panel was closed before this action completed." });
        }
        setShowCameraPanel(false);
      }} />}
      <CalendarPanel isOpen={showCalendarPanel} onClose={() => setShowCalendarPanel(false)} />
      <SystemMonitorPanel
        isOpen={showSystemMonitor}
        onClose={() => setShowSystemMonitor(false)}
        onOpenMonitor={() => setShowSystemMonitor(true)}
      />
      <ProjectManagerPanel isOpen={showProjectManager} onClose={() => setShowProjectManager(false)}
        onOpenStudio={() => { setShowProjectManager(false); setShowResearchLearning(false); setShowStudio(true); }} />
      {showMappingEditor && <GestureMappingEditor onClose={() => setShowMappingEditor(false)} />}
      {showConfirmPanel && <ConfirmationPanel onClose={() => setShowConfirmPanel(false)} />}

      {/* Persistent security warning delivered by the local live connection */}
      <AnimatePresence>
        {securityAlert && (
          <motion.div
            role="alert"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="fixed right-6 top-6 z-[60] flex max-w-sm items-start gap-3 rounded-xl border border-amber-400/40 bg-amber-950/95 p-4 text-left text-amber-100 shadow-2xl"
          >
            <CircleAlert size={18} className="mt-0.5 shrink-0 text-amber-300" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-widest text-amber-300">Security warning</p>
              <p className="mt-1 text-xs leading-relaxed">{securityAlert}</p>
            </div>
            <button type="button" onClick={() => setSecurityAlert(null)} className="shrink-0 text-amber-200 hover:text-white" aria-label="Dismiss security warning">
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast notifications */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={`fixed right-6 ${securityAlert ? "top-24" : "top-6"} z-50`}
          >
            <div className="px-3 py-2 rounded-lg bg-slate-900/90 border border-white/8 text-sm text-white shadow-lg">
              {toast}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* CORE AVATAR AND VISUALS */}
      <main className="relative z-10 flex-1 w-full max-w-4xl mx-auto flex flex-col items-center justify-between py-6">
        
        {/* Holographic Projection Screen Widget (if website opened) */}
        <AnimatePresence>
          {activeProjectorUrl && (
            <div className="absolute inset-x-0 top-0 z-30 flex justify-center p-2">
              <motion.div
                initial={{ opacity: 0, y: -20, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -20, scale: 0.95 }}
                className="flex items-center justify-between gap-4 p-3.5 rounded-2xl border border-indigo-500/20 bg-indigo-950/45 backdrop-blur-xl shadow-lg w-full max-w-md"
              >
                <div className="flex items-center gap-3 overflow-hidden text-left">
                  <div className="p-2 ml-1 rounded-xl bg-indigo-500/20 text-indigo-300">
                    <Globe size={18} />
                  </div>
                  <div className="overflow-hidden">
                    <h4 className="text-xs font-bold font-mono tracking-wide text-indigo-200 uppercase">Holographic Projection Broadcast</h4>
                    <p className="text-xs text-indigo-400 truncate max-w-[200px]">{activeProjectorUrl}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setActiveProjectorUrl(activeProjectorUrl)}
                    className="p-2 rounded-xl bg-indigo-500 text-white hover:bg-indigo-400 transition"
                    title="View Frame"
                  >
                    <Maximize2 size={14} />
                  </button>
                  <button
                    onClick={() => setActiveProjectorUrl(null)}
                    className="p-2 rounded-xl hover:bg-white/5 text-slate-400 hover:text-white transition"
                  >
                    <X size={14} />
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Space Spacer to avoid head area */}
        <div className="h-10 sm:h-20" />

        {/* Cinematic dialogue layer overlay - Smooth, delicate text transitions with soft focus blur */}
        <div id="cinematic-subtitles" className="w-full max-w-3xl flex flex-col items-center justify-center text-center px-6 relative z-25 mt-auto mb-6 pointer-events-none min-h-[6rem]">
          <AnimatePresence mode="wait">
            {(() => {
              const textType = modelCaption 
                ? "model" 
                : userCaption 
                  ? "user" 
                  : "status";

              const activeText = modelCaption 
                ? modelCaption 
                : userCaption 
                  ? userCaption 
                  : state === "listening" 
                    ? "I am listening. Speak freely..." 
                    : state === "connecting" 
                      ? "Materializing presence links..." 
                      : "Connect memory core to awaken my voice.";

              return (
                <motion.div
                  key={textType}
                  initial={{ opacity: 0, y: 15, filter: "blur(6px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: -15, filter: "blur(6px)" }}
                  transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  className="flex flex-col items-center justify-center w-full"
                >
                  {textType === "model" && (
                    <h2 className="text-xl sm:text-2xl font-light text-white leading-relaxed tracking-wide font-display max-w-2xl drop-shadow-[0_2px_20px_rgba(0,0,0,0.9)]">
                      {activeText}
                    </h2>
                  )}

                  {textType === "user" && (
                    <p className="text-cyan-300 font-mono text-sm sm:text-base tracking-wider flex items-center justify-center gap-2 drop-shadow-[0_1px_10px_rgba(0,0,0,0.85)] font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                      <span>&ldquo;{activeText}&rdquo;</span>
                    </p>
                  )}

                  {textType === "status" && (
                    <span className="text-xs sm:text-sm uppercase tracking-[0.3em] font-medium text-white/30 font-sans tracking-widest drop-shadow-[0_1px_4px_rgba(0, 0, 0, 0.5)]">
                      {activeText}
                    </span>
                  )}
                </motion.div>
              );
            })()}
          </AnimatePresence>
        </div>

        {/* Interactive suggestions prompt guide */}
        <AnimatePresence>
          {showGuide && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="mt-6 p-5 rounded-2xl border border-white/10 bg-slate-900/85 backdrop-blur-2xl max-w-md text-left w-full absolute z-40 shadow-2xl"
            >
              <div className="flex items-center justify-between mb-3 text-white">
                <div className="flex items-center gap-1.5 font-display text-sm font-bold tracking-wide">
                  <Compass size={16} className="text-indigo-400" />
                  <span>PLAYFUL CORE SUGGESTIONS</span>
                </div>
                <button 
                  onClick={() => setShowGuide(false)}
                  className="text-slate-400 hover:text-white transition"
                >
                  <X size={14} />
                </button>
              </div>
              <p className="text-xs text-slate-400 mb-4 font-mono leading-relaxed">
                Sara is equipped with dynamic visual modules and standard text browser projectors. Here are clever triggers to try speaking aloud:
              </p>
              <div className="space-y-2 text-xs font-serif italic text-indigo-300">
                <div className="p-2.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition cursor-pointer font-sans normal-case text-slate-200">
                  âš¡ &quot;Sara, change atmosphere of your core to crimson&quot; <span className="text-[10px] font-mono text-indigo-400 block mt-0.5 font-medium">Shifts theme color background</span>
                </div>
                <div className="p-2.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition cursor-pointer font-sans normal-case text-slate-200">
                  âš¡ &quot;Open youtube.com on my screen please&quot; <span className="text-[10px] font-mono text-indigo-400 block mt-0.5 font-medium">Invokes browser projector panel</span>
                </div>
                <div className="p-2.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition cursor-pointer font-sans normal-case text-slate-200">
                  âš¡ &quot;Tell me a witty joke and change background to gold&quot; <span className="text-[10px] font-mono text-indigo-400 block mt-0.5 font-medium">Combines tools & voice</span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Global Error Banner */}
        <AnimatePresence>
          {errorText && (
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 15 }}
              className="mt-6 flex items-start gap-3 p-4 rounded-2xl border border-rose-500/20 bg-rose-950/40 backdrop-blur-xl max-w-md w-full text-left"
            >
              <CircleAlert className="text-rose-400 shrink-0 mt-0.5" size={18} />
              <div>
                <h4 className="text-xs font-bold uppercase tracking-widest text-rose-300 font-mono">Core Error Protocol</h4>
                <p className="text-xs text-rose-200 mt-1 leading-relaxed">{errorText}</p>
                <button
                  onClick={() => setErrorText(null)}
                  className="mt-2 text-[10px] font-bold text-rose-400 underline font-mono uppercase"
                >
                  Dismiss Code
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </main>

      {/* FOOTER INTERFACE WITH WAVEFORM AND CONTROLS */}
      <footer className="relative z-10 w-full max-w-2xl mx-auto flex flex-col items-center gap-5 mt-auto">
        
        {/* Dynamic Minimalist Waveform Visualizer */}
        <div className="flex items-center justify-center gap-1 h-8 w-44">
          {[12, 28, 16, 32, 20, 8].map((baseHeight, idx) => {
            let heightFactor = 0.35;
            if (state === "speaking") {
              heightFactor = 0.35 + Math.sin(Date.now() * 0.02 + idx * 0.9) * 0.65;
            } else if (state === "listening") {
              heightFactor = 0.2 + Math.sin(Date.now() * 0.01 + idx * 0.5) * 0.4;
            } else {
              heightFactor = idx % 2 === 0 ? 0.25 : 0.12;
            }
            const calculatedHeight = Math.max(3, baseHeight * heightFactor);

            return (
              <div
                key={idx}
                className={`w-0.5 rounded-full transition-all duration-300 ${
                  state === "speaking" ? "bg-purple-400" : state === "listening" ? "bg-cyan-400" : "bg-white/10"
                }`}
                style={{ height: `${calculatedHeight}px` }}
              />
            );
          })}
        </div>

        {/* Glossy Beautiful Primary Connector Core Node */}
          <div className="flex items-center justify-center relative mb-4">
          <button 
            type="button"
            onClick={handleToggleConnection}
            className={`w-20 h-20 rounded-full flex items-center justify-center transition-all duration-500 cursor-pointer ${
              state === "disconnected"
                ? "bg-white/10 hover:bg-white/15 border border-white/15 text-white shadow-[0_0_20px_rgba(255,255,255,0.02)] hover:scale-105 active:scale-95"
                : state === "listening"
                ? "bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/80 text-cyan-200 shadow-[0_0_35px_rgba(34,211,238,0.3)] animate-pulse scale-105"
                : state === "speaking"
                ? "bg-purple-500/90 hover:bg-purple-600 border border-purple-400/95 text-white shadow-[0_0_35px_rgba(168,85,247,0.4)] scale-105"
                : "bg-amber-600 border border-amber-300 text-white animate-spin"
            }`}
            title={state === "disconnected" ? "Awake Sara" : (muted ? "Unmute microphone" : "Mute microphone")}
          >
            {state === "disconnected" ? (
              <Power className="opacity-80" size={24} />
            ) : state === "connecting" ? (
              <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : state === "listening" ? (
              (muted ? <MicOff size={24} className="text-cyan-200" /> : <Mic size={24} className="text-cyan-200" />)
            ) : (
              <Volume2 size={24} className="text-white" />
            )}
          </button>

          {/* Quiet Reset Projection Anchor */}
          {(activeProjectorUrl || errorText) && (
            <button 
              onClick={() => {
                if (activeProjectorUrl) setActiveProjectorUrl(null);
                setErrorText(null);
              }}
              className="absolute right-[-60px] p-2 rounded-full hover:bg-white/5 text-slate-400 hover:text-white transition duration-150 cursor-pointer"
              title="Reset Screen Broadcasts"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-300" role="status" aria-live="polite">
          <span>{state === "disconnected"
            ? settings.wakeWordEnabled && !muted ? "Voice off · wake detection enabled" : "Voice off · Live mic inactive"
            : muted ? "Live mic muted" : state === "connecting" ? "Connecting · requesting microphone"
              : "Live mic on · listening"}</span>
          {state === "speaking" && (
            <button type="button" onClick={() => {
              if (sessionRef.current?.stopSpeaking()) showToast("Speech stopped; background tasks continue");
            }} className="rounded-xl border border-purple-400/40 px-3 py-1.5 text-purple-200 hover:bg-purple-400/10"
              aria-label="Stop SARA speech without cancelling any task">Stop speaking</button>
          )}
        </div>

      </footer>

      {/* Holographic Website frame projections */}
      <AnimatePresence>
        {activeProjectorUrl && (
          <BrowserAgent
            url={activeProjectorUrl}
            onClose={() => {
              setActiveProjectorUrl(null);
              setBrowserTrigger(null);
            }}
            actionTrigger={browserTrigger}
          />
        )}
      </AnimatePresence>

      {/* Dynamic Floating Glassmorphic Screen Sharing Control Hub */}
      <AnimatePresence>
        {isScreenSharing && (
          <motion.div
            initial={{ opacity: 0, scale: 0.85, x: 50 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.85, x: 50 }}
            className={`absolute bottom-6 md:bottom-10 right-6 md:right-10 z-50 w-72 p-4 rounded-2xl border ${
              isScreenSharingPaused 
                ? "border-amber-500/20 bg-slate-950/70" 
                : "border-cyan-500/20 bg-slate-950/70"
            } backdrop-blur-2xl shadow-2xl overflow-hidden`}
          >
            {/* Header / Indicator */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isScreenSharingPaused ? "bg-amber-400" : "bg-cyan-400 animate-pulse"}`} />
                <span className="text-[10px] font-bold font-mono tracking-widest text-slate-200">
                  {isScreenSharingPaused ? "SCREEN VISION PAUSED" : "SCREEN VISION ACTIVE"}
                </span>
              </div>
              <button 
                onClick={stopScreenSharing}
                className="text-slate-400 hover:text-white transition-colors duration-150 p-1 rounded-lg hover:bg-white/5 cursor-pointer"
                title="Stop Sharing"
              >
                <X size={14} />
              </button>
            </div>

            {/* Smart Video PIP Preview Holder */}
            <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-slate-900 border border-white/5 mb-3 flex items-center justify-center group select-none">
              {screenPreviewUrl ? (
                <img
                  src={screenPreviewUrl}
                  alt="Shared screen preview"
                  className={`w-full h-full object-cover transition-opacity duration-300 ${
                    isScreenSharingPaused ? "opacity-30 blur-sm" : "opacity-90"
                  }`}
                />
              ) : (
                <video
                  ref={(el) => {
                    if (el && screenStreamRef.current && el.srcObject !== screenStreamRef.current) {
                      el.srcObject = screenStreamRef.current;
                      el.muted = true;
                      el.play().catch(err => console.log("Mini preview stream play issue:", err));
                    }
                  }}
                  className={`w-full h-full object-cover transition-opacity duration-300 ${
                    isScreenSharingPaused ? "opacity-30 blur-sm" : "opacity-90"
                  }`}
                  autoPlay
                  playsInline
                  muted
                />
              )}

              {isScreenSharingPaused && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-[10px] uppercase tracking-widest font-mono text-amber-400 font-bold px-2 py-1 bg-amber-950/40 border border-amber-500/20 rounded-md">
                    Transmission Paused
                  </span>
                </div>
              )}
              
              {!isScreenSharingPaused && screenVisionMode && (
                <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-0.5 rounded bg-cyan-950/50 border border-cyan-400/20 text-[9px] font-mono text-cyan-300">
                  <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-ping" />
                  <span>Streaming FPS: 0.5</span>
                </div>
              )}
            </div>

            {/* Quick Action Control Strip */}
            <div className="flex items-center justify-between gap-1.5 mb-2.5">
              {isScreenSharingPaused ? (
                <button
                  onClick={resumeScreenSharing}
                  className="flex-1 py-1.5 px-2 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 rounded-lg text-xs font-mono font-medium text-cyan-300 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  title="Resume Streaming Feed"
                >
                  <Play size={10} />
                  <span>Resume</span>
                </button>
              ) : (
                <button
                  onClick={pauseScreenSharing}
                  className="flex-1 py-1.5 px-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 rounded-lg text-xs font-mono font-medium text-amber-300 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  title="Pause Streaming Feed"
                >
                  <Pause size={10} />
                  <span>Pause</span>
                </button>
              )}

              <button
                onClick={switchScreenShare}
                className="py-1.5 px-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-mono text-slate-300 hover:text-white flex items-center justify-center gap-1 transition-all cursor-pointer"
                title="Choose Another Screen or Window"
              >
                <RefreshCw size={11} />
                <span>Switch</span>
              </button>

              <button
                onClick={stopScreenSharing}
                className="py-1.5 px-2 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 rounded-lg text-xs font-mono text-rose-400 flex items-center justify-center gap-1 transition-all cursor-pointer hover:scale-[1.02] active:scale-[0.98]"
                title="Terminate Stream"
              >
                <Square size={9} />
                <span>Stop</span>
              </button>
            </div>

            {/* Core Mode Configuration Toggle */}
            <div className="pt-2 border-t border-white/5 flex items-center justify-between text-left">
              <div className="flex flex-col">
                <span className="text-[10px] font-bold font-mono text-slate-200">SCREEN VISION MODE</span>
                <span className="text-[8px] text-slate-400 uppercase font-mono max-w-[150px]">Gemini Auto-Analysis</span>
              </div>
              <button
                onClick={() => setScreenVisionMode(!screenVisionMode)}
                className={`w-10 h-5 rounded-full p-0.5 transition-colors duration-200 focus:outline-none cursor-pointer ${
                  screenVisionMode ? "bg-cyan-500" : "bg-white/10"
                }`}
              >
                <div
                  className={`bg-white w-4 h-4 rounded-full shadow-md transform duration-200 ease-in-out ${
                    screenVisionMode ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {showResearchLearning && <Suspense fallback={<div role="status" className="fixed bottom-4 right-4 z-[90] text-white">Opening learning dashboard…</div>}>
        <ResearchLearningPanel isOpen onClose={() => setShowResearchLearning(false)} />
      </Suspense>}
      {showStudio && <Suspense fallback={<div role="status" className="fixed bottom-4 right-4 z-[90] text-white">Opening creative workspace…</div>}>
        <StudioWorkspace isOpen onClose={() => setShowStudio(false)} />
      </Suspense>}

      {/* Reviewed workflow panel uses the existing task store; legacy task UI remains available. */}
      <TaskManagerPanel isOpen={showTaskManager} onClose={() => setShowTaskManager(false)} activeConversationId={desktopConversationId} />

      {/* Recollections sliding core panel */}
      <MemoryDashboard
        isOpen={showMemoryDashboard}
        onClose={() => setShowMemoryDashboard(false)}
        memories={memories}
        loading={memoriesLoading}
        error={memoriesError}
        onRetry={() => { void loadMemories(); }}
        onAddMemory={handleAddManualMemory}
        onUpdateMemory={handleUpdateMemory}
        onDeleteMemory={handleDeleteMemory}
        themeColor={themeColor}
      />

      {showQuickChat && (
        <DesktopChatPanel
          isOpen={showQuickChat}
          onClose={() => setShowQuickChat(false)}
          onShowConversations={() => {
            setShowDesktopConversations(true);
            setShowQuickChat(false);
          }}
          initialConversationId={desktopConversationId}
        />
      )}

      {/* Desktop chat panel */}
      <DesktopChatPanel
        isOpen={showDesktopChat}
        onClose={() => setShowDesktopChat(false)}
        onShowConversations={() => {
          setShowDesktopConversations(true);
          setShowDesktopChat(false);
        }}
        initialConversationId={desktopConversationId}
      />

      <DesktopConversationsPanel
        isOpen={showDesktopConversations}
        onClose={() => setShowDesktopConversations(false)}
        onOpenConversation={(conversationId) => {
          setDesktopConversationId(conversationId);
          void switchVoiceConversation(conversationId);
          setShowDesktopChat(true);
          setShowDesktopConversations(false);
        }}
        onCreateNew={() => {
          setDesktopConversationId(null);
          void switchVoiceConversation(null);
          setShowDesktopChat(true);
          setShowDesktopConversations(false);
        }}
      />

      {/* V2: Settings sliding core panel */}
      <SettingsPanel
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onChange={handleSettingsChange}
        locked={state !== "disconnected"}
        themeColor={themeColor}
      />

      {/* SARA Owner / Admin Security Dashboard */}
      <AdminSecurityDashboard
        isOpen={showAdminSecurity}
        onClose={() => setShowAdminSecurity(false)}
      />
    </div>
  );
}

