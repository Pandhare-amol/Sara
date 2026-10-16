import { useState, useEffect, useRef } from "react";
import { SaraAudioSession, LiveState } from "./lib/audio";
import { SaraCoreVisualizer, SaraEmotion } from "./components/SaraCoreVisualizer";
import { BrowserAgent } from "./components/BrowserAgent";
import { DesktopChatPanel } from "./components/DesktopChatPanel";
import { DesktopConversationsPanel } from "./components/DesktopConversationsPanel";
import { 
  Power, 
  Volume2, 
  Info, 
  Sparkles, 
  Globe, 
  Maximize2, 
  MessageSquare,
  ListChecks,
  Compass, 
  CircleAlert,
  MicOff,
  Mic,
  X,
  Brain,
  Monitor,
  Video,
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
import { TaskOutcomeFeedback, type TaskFeedbackRating } from "./components/TaskOutcomeFeedback";
import { isVerifiedTaskSuccess } from "./types/AuthoritativeTaskResult";
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
import { presentGlobalNotification, type GlobalNotificationPayload } from "./services/globalNotifications";

export default function App() {
  const [state, setState] = useState<LiveState>("disconnected");

  // Real-time Screen Sharing states
  const [isScreenSharing, setIsScreenSharing] = useState<boolean>(false);
  const [isScreenSharingPaused, setIsScreenSharingPaused] = useState<boolean>(false);
  const [screenVisionMode, setScreenVisionMode] = useState<boolean>(true);
  const [screenPreviewUrl, setScreenPreviewUrl] = useState<string | null>(null);
  const [muted, setMuted] = useState<boolean>(false);
  const [toast, setToast] = useState<string | null>(null);
  const [securityAlert, setSecurityAlert] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const globalNotificationCursorRef = useRef(0);
  const seenGlobalNotificationsRef = useRef(new Set<string>());
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

  // Clean up streaming intervals on unmount
  useEffect(() => {
    return () => {
      if (screenIntervalRef.current) {
        clearInterval(screenIntervalRef.current);
      }
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

  const captureDesktopFrameAndSend = async (): Promise<boolean> => {
    if (isPausedRef.current || !screenVisionRef.current || desktopCaptureInFlightRef.current) return false;
    desktopCaptureInFlightRef.current = true;
    try {
      const response = await fetch("/api/vision/screen-capture", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !data.imageBase64 || !data.imageMime) {
        throw new Error(data.error || "Desktop screen capture failed.");
      }
      setScreenPreviewUrl(`data:${data.imageMime};base64,${data.imageBase64}`);
      if (sessionRef.current && stateRef.current !== "disconnected") {
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
      } catch (sdErr) {
        // If running inside Electron, attempt the desktopCapturer-based fallback
        try {
          const sara = (window as any).sara;
          if (sara && sara.isDesktop && typeof sara.getPrimaryScreenSourceId === 'function') {
            const sourceId = await sara.getPrimaryScreenSourceId();
            if (sourceId) {
              // Use legacy chromeMediaSourceId approach as a fallback
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore
              stream = await (navigator.mediaDevices as any).getUserMedia({
                audio: false,
                video: {
                  mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId,
                    minWidth: 1280,
                    minHeight: 720,
                    maxFrameRate: 5
                  }
                }
              });
            }
          }
        } catch (e) {
          console.warn('[Screen Capture] Electron fallback failed:', e);
        }
        // The VS Code embedded browser has no display-media API or Electron
        // bridge. Use the local desktop agent in that environment instead.
        if (!stream && sdErr?.name === "NotSupportedError") {
          const captured = await captureDesktopFrameAndSend();
          if (captured) {
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
      console.error("Screen sharing permission declined or missing API:", e);
      let attemptedFallback = false;
      let fallbackError: any = null;
      try {
        const sara = (window as any).sara;
        if (sara && sara.isDesktop && typeof sara.getScreenSources === 'function') {
          attemptedFallback = true;
          const sources = await sara.getScreenSources();
          if (Array.isArray(sources) && sources.length > 0) {
            for (const s of sources) {
              try {
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore
                const sStream = await (navigator.mediaDevices as any).getUserMedia({
                  audio: false,
                  video: {
                    mandatory: {
                      chromeMediaSource: 'desktop',
                      chromeMediaSourceId: s.id,
                      minWidth: 1280,
                      minHeight: 720,
                      maxFrameRate: 5
                    }
                  }
                });
                if (sStream) {
                  // Use this stream
                  screenStreamRef.current = sStream as MediaStream;
                  const video = document.createElement('video');
                  video.srcObject = sStream as MediaStream;
                  video.muted = true;
                  video.playsInline = true;
                  video.play().catch((err) => console.warn('Video play warning (fallback):', err));
                  screenVideoRef.current = video;

                  setIsScreenSharing(true);
                  setIsScreenSharingPaused(false);

                  (sStream as MediaStream).getVideoTracks()[0].onended = () => {
                    stopScreenSharing();
                  };

                  if (screenIntervalRef.current) clearInterval(screenIntervalRef.current);
                  screenIntervalRef.current = setInterval(() => { captureFrameAndSend(); }, 2000);
                  setTimeout(() => { captureFrameAndSend(); }, 500);
                  break;
                }
              } catch (subErr) {
                fallbackError = subErr;
                console.warn('[Screen Capture] fallback attempt failed for source', s, subErr);
              }
            }
          }
        }
      } catch (fbEx) {
        fallbackError = fbEx;
      }

      // If still not sharing, report full payload to server and copy to clipboard
      if (!screenStreamRef.current) {
        const payload: any = {
          errorName: e?.name || null,
          errorMessage: e?.message || String(e),
          errorStack: e?.stack || null,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
          url: typeof window !== 'undefined' ? window.location.href : null,
          timestamp: new Date().toISOString(),
          isElectron: !!((window as any).sara?.isDesktop),
          attemptedFallback,
          fallbackError: fallbackError ? (fallbackError.message || String(fallbackError)) : null
        };
        try {
          await fetch('/api/client-error', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
        } catch (postErr) { console.warn('Failed to POST client error payload', postErr); }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
            alert('Screen capture error details copied to clipboard. Paste them into the chat.');
          }
        } catch (clipErr) { console.warn('Failed to copy error payload to clipboard', clipErr); }

        if (e.name !== 'NotAllowedError') setErrorText(`Could not capture screen: ${e.message || e}`);
      }
    }
  };

  const stopScreenSharing = () => {
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
    setIsScreenSharingPaused(true);
  };

  const resumeScreenSharing = () => {
    setIsScreenSharingPaused(false);
    // Refresh first frame immediately
    setTimeout(() => {
      captureFrameAndSend();
    }, 100);
  };

  const switchScreenShare = async () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
    }
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
  const [outcomeFeedbackTask, setOutcomeFeedbackTask] = useState<{ taskId: string } | null>(null);
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
  const [showMappingEditor, setShowMappingEditor] = useState<boolean>(false);
  const [showConfirmPanel, setShowConfirmPanel] = useState<boolean>(false);
  const [showAdminSecurity, setShowAdminSecurity] = useState<boolean>(false);
  const showSettingsRef = useRef<boolean>(false);
  useEffect(() => { showSettingsRef.current = showSettings; }, [showSettings]);

  useEffect(() => {
    const setTransientToast = (message: string, durationMs = 5000) => {
      setToast(message);
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = window.setTimeout(() => setToast(null), durationMs);
    };
    const setNotificationCursor = (cursor: number) => {
      globalNotificationCursorRef.current = cursor;
      try { window.localStorage.setItem("sara.globalNotificationCursor", String(cursor)); } catch { /* storage is optional */ }
    };
    try {
      const savedCursor = Number(window.localStorage.getItem("sara.globalNotificationCursor") || 0);
      if (Number.isFinite(savedCursor) && savedCursor >= 0) globalNotificationCursorRef.current = savedCursor;
    } catch { /* storage is optional */ }

    const presentNotification = (detail: GlobalNotificationPayload) => {
      if (!detail?.message) return;
      const key = typeof detail.id === "number"
        ? `id:${detail.id}:${Number(detail.createdAt) || 0}`
        : detail.tag
          ? `tag:${detail.source || "unknown"}:${detail.tag}`
          : `${detail.source || "unknown"}:${detail.title}:${detail.message}`;
      if (seenGlobalNotificationsRef.current.has(key)) return;
      seenGlobalNotificationsRef.current.add(key);
      if (seenGlobalNotificationsRef.current.size > 250) {
        seenGlobalNotificationsRef.current = new Set(Array.from(seenGlobalNotificationsRef.current).slice(-125));
      }
      if (typeof detail.id === "number" && Number.isFinite(detail.id) && detail.id > globalNotificationCursorRef.current) {
        setNotificationCursor(detail.id);
      }
      presentGlobalNotification(detail, { allowVoice: stateRef.current === "disconnected" });
      if (detail.source !== "system-monitor") setTransientToast(`${detail.title}: ${detail.message}`, 7000);
    };

    let active = true;
    let polling = false;
    const pollGlobalNotifications = async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await fetch(`/api/notifications?since=${encodeURIComponent(globalNotificationCursorRef.current)}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json().catch(() => ({}));
        if (!active || payload?.ok !== true) return;
        const latestId = Number(payload.latestId);
        if (Number.isFinite(latestId) && latestId < globalNotificationCursorRef.current) {
          seenGlobalNotificationsRef.current.clear();
          setNotificationCursor(0);
        }
        const notifications = Array.isArray(payload.notifications) ? payload.notifications : [];
        for (const notification of notifications) presentNotification(notification as GlobalNotificationPayload);
        if (Number.isFinite(latestId) && latestId > globalNotificationCursorRef.current) setNotificationCursor(latestId);
      } catch { /* the live channel remains a best-effort fallback */ }
      finally { polling = false; }
    };

    const handleConfirmationRequired = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: unknown }>).detail;
      const action = String(detail?.action || "external action");
      setShowConfirmPanel(true);
      setTransientToast(`${action === "whatsapp_send" ? "WhatsApp message" : action === "email_send" ? "Email" : "Action"} needs your approval. Review the exact details before approving.`);
    };
    const handleGlobalNotification = (event: Event) => {
      const detail = (event as CustomEvent<GlobalNotificationPayload>).detail;
      if (detail) presentNotification(detail);
    };

    window.addEventListener("sara.confirmationRequired", handleConfirmationRequired);
    window.addEventListener("sara.globalNotification", handleGlobalNotification);
    void pollGlobalNotifications();
    const pollTimer = window.setInterval(() => { void pollGlobalNotifications(); }, 4000);
    return () => {
      active = false;
      window.clearInterval(pollTimer);
      window.removeEventListener("sara.confirmationRequired", handleConfirmationRequired);
      window.removeEventListener("sara.globalNotification", handleGlobalNotification);
    };
  }, []);

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
    if (settings.wakeWordEnabled && state === "disconnected") {
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
  }, [settings.wakeWordEnabled, settings.wakePhrase, settings.sensitivity, state]);

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
      const response = await fetch("/api/memories", { cache: "no-store" });
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

  const handleAddManualMemory = async (category: MemoryCategory, text: string) => {
    try {
      const resp = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, text })
      });
      const saved = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(saved?.error || `Memory service returned ${resp.status}.`);
      if (!saved || typeof saved.id !== "string") throw new Error("Memory service returned an invalid record.");
      setMemories((prev) => prev.some((memory) => memory.id === saved.id)
        ? prev.map((memory) => memory.id === saved.id ? saved : memory)
        : [...prev, saved]);
    } catch (err) {
      console.error("Manual memory add failed:", err);
      throw err;
    }
  };

  const handleUpdateMemory = async (id: string, category: MemoryCategory, text: string) => {
    try {
      const resp = await fetch(`/api/memories/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, text })
      });
      const updated = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(updated?.error || `Memory service returned ${resp.status}.`);
      if (!updated || updated.id !== id) throw new Error("Memory service returned an invalid record.");
      setMemories((prev) => prev.map((memory) => memory.id === id ? updated : memory));
    } catch (err) {
      console.error("Manual memory correction failed:", err);
      throw err;
    }
  };

  const handleConfirmMemory = async (id: string) => {
    try {
      const resp = await fetch(`/api/memories/${encodeURIComponent(id)}/confirm`, { method: "POST" });
      const confirmed = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(confirmed?.error || `Memory service returned ${resp.status}.`);
      if (!confirmed || confirmed.id !== id) throw new Error("Memory service returned an invalid record.");
      setMemories((prev) => prev.map((memory) => memory.id === id ? confirmed : memory));
    } catch (err) {
      console.error("Manual memory confirmation failed:", err);
      throw err;
    }
  };

  const handleDeleteMemory = async (id: string) => {
    try {
      const resp = await fetch(`/api/memories/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(result?.error || `Memory service returned ${resp.status}.`);
      if (!result?.success) throw new Error("Memory service did not confirm deletion.");
      setMemories((prev) => prev.filter((memory) => memory.id !== id));
    } catch (err) {
      console.error("Manual memory delete failed:", err);
      throw err;
    }
  };

  const handleTaskOutcomeFeedback = async (
    taskId: string,
    feedback: { rating: TaskFeedbackRating; note?: string },
  ) => {
    const response = await fetch(`/api/learning/tasks/${encodeURIComponent(taskId)}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...feedback, consentToLearn: true }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `Feedback service returned ${response.status}.`);
    setOutcomeFeedbackTask((current) => current?.taskId === taskId ? null : current);
    showToast("Feedback saved locally for future evaluation.");
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
            // Voice camera commands
            const takePhotoRe = /take (?:a )?(?:photo|picture)(?: in (\d+) seconds?)?/i;
            const startRecRe = /start (?:recording|video)(?: for (\d+) seconds?)?/i;
            const stopRecRe = /stop (?:recording|video)/i;
            const analyzeVisionRe = /how am i looking|what am i wearing|describe my appearance|check my appearance|check my outfit|what do you see/i;
            const startCamRe = /(?:open|show|start|use) camera|see me|look at me|can you see me/i;
            const stopCamRe = /(?:close|stop|hide|turn off) camera|stop seeing me|stop looking/i;
            const galleryRe = /(?:open|show) (?:camera )?gallery/i;
            const enableGestureRe = /enable hand gesture control|enable gestures|turn on gestures/i;
            const disableGestureRe = /disable hand gesture control|disable gestures|turn off gestures/i;

            let m = null;
            if (analyzeVisionRe.test(transcriptText)) {
              setShowCameraPanel(true);
              window.setTimeout(() => {
                window.dispatchEvent(new CustomEvent('sara-camera-action', { detail: { action: 'analyzeVision' } }));
              }, 0);
            } else if ((m = transcriptText.match(takePhotoRe))) {
              const delay = m[1] ? parseInt(m[1], 10) : 0;
              window.dispatchEvent(new CustomEvent('sara-camera-action', { detail: { action: 'takePhoto', delay } }));
            } else if (startRecRe.test(transcriptText)) {
              const mm = transcriptText.match(startRecRe);
              const duration = mm && mm[1] ? parseInt(mm[1], 10) : undefined;
              window.dispatchEvent(new CustomEvent('sara-camera-action', { detail: { action: 'startRecording', duration } }));
            } else if (stopRecRe.test(transcriptText)) {
              window.dispatchEvent(new CustomEvent('sara-camera-action', { detail: { action: 'stopRecording' } }));
            } else if (startCamRe.test(transcriptText)) {
              setShowCameraPanel(true);
              window.setTimeout(() => {
                window.dispatchEvent(new CustomEvent('sara-camera-action', { detail: { action: 'startCamera' } }));
              }, 0);
            } else if (stopCamRe.test(transcriptText)) {
              window.dispatchEvent(new CustomEvent('sara-camera-action', { detail: { action: 'stopCamera' } }));
            } else if (galleryRe.test(transcriptText)) {
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
        console.log(`[App] Tool call triggered: ${name}`, args);
        
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
        const tool = task.tool || task.metadata?.tool;
        const label = tool === "youtube_play" ? "YouTube" :
          ["saraAppExecuteGoal", "saraVoiceExecuteCommand"].includes(tool) ? "App task" :
            tool || task.description || "Task";
        const status = String(task.status || "").toLowerCase();
        let taskResult = task.result;
        if (typeof taskResult === "string") {
          try { taskResult = JSON.parse(taskResult); } catch { taskResult = undefined; }
        }
        const authoritativeResult = task.metadata?.taskExecutionResult || taskResult;
        const hasVerifiedAuthoritativeSuccess = task.metadata?.authoritative === true &&
          authoritativeResult && typeof authoritativeResult === "object" &&
          isVerifiedTaskSuccess(authoritativeResult);
        const autoClose = taskResult?.autoClose || taskResult?.metadata?.taskExecutionResult?.autoClose ||
          task.metadata?.taskExecutionResult?.autoClose || task.auto_close_result;
        if (status === "completed") {
          if (hasVerifiedAuthoritativeSuccess && typeof task.taskId === "string" && task.taskId) {
            setOutcomeFeedbackTask({ taskId: task.taskId });
          }
          if (autoClose && autoClose.verified !== true) {
            showToast(`${label}: completed; SARA left the app open because a graceful close could not be verified`);
          } else if (autoClose && Array.isArray(autoClose.closed) && autoClose.closed.length > 0) {
            showToast(`${label}: verified and completed; SARA closed ${autoClose.closed.length} temporary app window(s)`);
          } else {
            showToast(`${label}: verified and completed`);
          }
        } else if (status === "failed") showToast(`${label}: automation failed`);
        else if (status === "paused") showToast(`${label}: outcome needs review before retrying`);
        else if (status === "running") showToast(`${label}: working in background`);
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
      await sessionRef.current.connect(voiceConversationIdRef.current);
      // Ensure unmuted by default when connecting
      try { sessionRef.current.setMuted(false); } catch {}
      setMuted(false);
      try { window.localStorage.setItem("sara.muted", "0"); } catch {}
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

  const toolbarButtonClass = "sara-nav-button";
  const toolbarActiveClass = "is-active";

  return (
    <div
      id="sara-holographic-desktop"
      className={`sara-app-shell relative isolate w-full h-screen overflow-hidden bg-[#020205] text-white ${getAmbientStyles()} theme-transition flex flex-col justify-between px-4 pt-4 pb-5 sm:px-6 sm:pt-5 sm:pb-6 xl:px-8 select-none`}
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

      {/* Premium companion-console header. Every control keeps its existing action. */}
      <header className="sara-header relative z-30 mx-auto w-full max-w-[1320px] select-none">
        <div className="sara-brand" aria-label="SARA companion system">
          <span className="sara-brand-mark" aria-hidden="true"><Sparkles size={17} /></span>
          <span className="sara-brand-copy">
            <span className="sara-wordmark">SARA</span>
            <span className="sara-brand-caption">COMPANION SYSTEM</span>
          </span>
        </div>

        <nav className="sara-nav-shell" aria-label="SARA features">
          <div className="sara-nav-scroll">
            <div className="sara-nav-group" role="group" aria-label="Personal">
              <button type="button" onClick={() => setShowGuide((value) => !value)} className={`${toolbarButtonClass} ${showGuide ? toolbarActiveClass : ""}`} title="Sway themes and topics" aria-label="Open themes and topics" aria-pressed={showGuide}>
                <Compass size={15} /><span className="sara-nav-label">TOPICS</span>
              </button>
              <button type="button" onClick={() => setShowMemoryDashboard((value) => !value)} className={`${toolbarButtonClass} ${showMemoryDashboard ? toolbarActiveClass : ""}`} title="Memory and recollections" aria-label="Open memory dashboard" aria-pressed={showMemoryDashboard}>
                <Brain size={15} /><span className="sara-nav-label">MEMORY</span>
              </button>
              <button type="button" onClick={() => setShowCalendarPanel((value) => !value)} className={`${toolbarButtonClass} ${showCalendarPanel ? toolbarActiveClass : ""}`} title="Local calendar" aria-label="Open local calendar" aria-pressed={showCalendarPanel}>
                <CalendarDays size={15} /><span className="sara-nav-label">CALENDAR</span>
              </button>
            </div>

            <span className="sara-nav-divider" aria-hidden="true" />

            <div className="sara-nav-group" role="group" aria-label="Workspace">
              <button type="button" onClick={() => setShowSystemMonitor(true)} className={`${toolbarButtonClass} ${showSystemMonitor ? toolbarActiveClass : ""}`} title="System resource monitor" aria-label="Open system resource monitor" aria-pressed={showSystemMonitor}>
                <Activity size={15} /><span className="sara-nav-label">SYSTEM</span>
              </button>
              <button type="button" onClick={() => setShowProjectManager(true)} className={`${toolbarButtonClass} ${showProjectManager ? toolbarActiveClass : ""}`} title="Projects and tasks" aria-label="Open project manager" aria-pressed={showProjectManager}>
                <FolderKanban size={15} /><span className="sara-nav-label">PROJECTS</span>
              </button>
              <button type="button" onClick={isScreenSharing ? stopScreenSharing : startScreenSharing} className={`${toolbarButtonClass} ${isScreenSharing ? toolbarActiveClass : ""}`} title={isScreenSharing ? "Stop screen sharing" : "Share screen with SARA"} aria-label={isScreenSharing ? "Stop screen sharing" : "Share screen with SARA"} aria-pressed={isScreenSharing}>
                <Monitor size={15} className={isScreenSharing && !isScreenSharingPaused ? "animate-pulse text-cyan-300" : ""} /><span className="sara-nav-label">{isScreenSharing ? "SHARING" : "SHARE"}</span>
              </button>
            </div>

            <span className="sara-nav-divider" aria-hidden="true" />

            <div className="sara-nav-group" role="group" aria-label="Conversation and approvals">
              <button type="button" onClick={() => setShowQuickChat((value) => !value)} className={`sara-nav-button sara-nav-button-icon ${showQuickChat ? toolbarActiveClass : ""}`} title="Quick chat with SARA" aria-label={showQuickChat ? "Close quick chat" : "Open quick chat"} aria-expanded={showQuickChat}>
                <MessageSquare size={15} />
              </button>
              <button type="button" onClick={() => setShowConfirmPanel((value) => !value)} className={`sara-nav-button sara-nav-button-icon ${showConfirmPanel ? "is-warning-active" : ""}`} title="Review pending approvals" aria-label="Open pending action approvals" aria-expanded={showConfirmPanel}>
                <ListChecks size={15} />
              </button>
            </div>

            <span className="sara-nav-divider" aria-hidden="true" />

            <div className="sara-nav-group" role="group" aria-label="System settings">
              <button type="button" onClick={() => setShowAdminSecurity((value) => !value)} className={`${toolbarButtonClass} ${showAdminSecurity ? toolbarActiveClass : ""}`} title="Owner and security dashboard" aria-label="Open security dashboard" aria-pressed={showAdminSecurity}>
                <ShieldCheck size={15} /><span className="sara-nav-label">SECURITY</span>
              </button>
              <button type="button" onClick={() => setShowSettings((value) => !value)} className={`${toolbarButtonClass} ${showSettings ? toolbarActiveClass : ""}`} title="SARA settings" aria-label="Open SARA settings" aria-pressed={showSettings}>
                <SettingsIcon size={15} /><span className="sara-nav-label">SETTINGS</span>
              </button>
              <button type="button" onClick={() => setShowCameraPanel((value) => !value)} className={`${toolbarButtonClass} ${showCameraPanel ? toolbarActiveClass : ""}`} title="Camera controls" aria-label="Open camera controls" aria-pressed={showCameraPanel}>
                <Video size={15} /><span className="sara-nav-label">CAMERA</span>
              </button>
            </div>
          </div>
        </nav>

        <div className="sara-connection-status" data-state={state} role="status" aria-live="polite">
          <span className="sara-status-light" aria-hidden="true" />
          <span className="sara-status-copy">
            <span className="sara-status-caption">VOICE CORE</span>
            <span className="sara-status-value">{state === "disconnected" ? "OFFLINE" : state.toUpperCase()}</span>
          </span>
        </div>
      </header>

      {showGesturePanel && <GestureControlPanel onClose={() => setShowGesturePanel(false)} />}
      {showCameraPanel && <CameraPanel onClose={() => setShowCameraPanel(false)} />}
      <CalendarPanel isOpen={showCalendarPanel} onClose={() => setShowCalendarPanel(false)} />
      <SystemMonitorPanel
        isOpen={showSystemMonitor}
        onClose={() => setShowSystemMonitor(false)}
        onOpenMonitor={() => setShowSystemMonitor(true)}
      />
      <ProjectManagerPanel isOpen={showProjectManager} onClose={() => setShowProjectManager(false)} />
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
      <main className="sara-stage relative z-10 flex-1 min-h-0 w-full mx-auto">
        
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

        {/* Live dialogue is kept in the negative space so SARA remains unobstructed. */}
        <section id="cinematic-subtitles" className="sara-dialogue-card" aria-live="polite" aria-atomic="true">
          <div className="sara-dialogue-topline">
            <span className="sara-dialogue-eyebrow">
              <span className="sara-dialogue-signal" data-state={state} aria-hidden="true" />
              <span>VOICE CHANNEL</span>
            </span>
            <span className="sara-dialogue-mode">{state === "disconnected" ? "READY" : state.toUpperCase()}</span>
          </div>
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
                    ? "I'm listening. Speak naturally."
                    : state === "connecting"
                      ? "Connecting to your voice session…"
                      : "Connect with SARA to start a conversation.";

              return (
                <motion.div
                  key={textType}
                  initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
                  transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
                  className="sara-dialogue-copy"
                >
                  {textType === "model" && <p className="sara-dialogue-text is-assistant">{activeText}</p>}
                  {textType === "user" && (
                    <p className="sara-dialogue-text is-user">
                      <span aria-hidden="true">“</span>{activeText}<span aria-hidden="true">”</span>
                    </p>
                  )}
                  {textType === "status" && <p className="sara-dialogue-text is-status">{activeText}</p>}
                </motion.div>
              );
            })()}
          </AnimatePresence>
        </section>

        {/* Interactive suggestions prompt guide */}
        <AnimatePresence>
          {showGuide && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="sara-guide-panel mt-6 p-5 rounded-2xl border border-white/10 bg-slate-900/85 backdrop-blur-2xl max-w-md text-left w-full absolute z-40 shadow-2xl"
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
              className="sara-error-banner mt-6 flex items-start gap-3 p-4 rounded-2xl border border-rose-500/20 bg-rose-950/40 backdrop-blur-xl max-w-md w-full text-left"
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

      {/* Compact voice control dock, positioned away from the central avatar. */}
      <footer className="sara-footer" aria-label="Voice controls">
        <div className="sara-voice-dock">
          <div className={`sara-audio-meter ${state === "speaking" ? "is-speaking" : state === "listening" ? "is-listening" : ""}`} aria-hidden="true">
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

              return <span key={idx} className="sara-audio-bar" style={{ height: `${calculatedHeight}px` }} />;
            })}
          </div>
          <span className="sara-voice-divider" aria-hidden="true" />
          <div className="sara-voice-copy" aria-live="polite">
            <span className="sara-voice-kicker">VOICE CONTROL</span>
            <span className="sara-voice-state">
              {state === "disconnected"
                ? "Tap to connect"
                : state === "connecting"
                  ? "Opening voice link"
                  : state === "listening"
                    ? muted ? "Microphone muted" : "Listening now"
                    : "SARA is speaking"}
            </span>
          </div>
          <button
            type="button"
            onClick={handleToggleConnection}
            className={`sara-voice-button ${state === "listening" ? "is-listening" : state === "speaking" ? "is-speaking" : state === "connecting" ? "is-connecting" : ""}`}
            title={state === "disconnected" ? "Awake Sara" : (muted ? "Unmute microphone" : "Mute microphone")}
            aria-label={state === "disconnected" ? "Connect voice with SARA" : (muted ? "Unmute microphone" : "Mute microphone")}
            aria-busy={state === "connecting"}
          >
            {state === "disconnected" ? (
              <Power size={20} />
            ) : state === "connecting" ? (
              <span className="sara-voice-spinner" aria-hidden="true" />
            ) : state === "listening" ? (
              muted ? <MicOff size={20} /> : <Mic size={20} />
            ) : (
              <Volume2 size={20} />
            )}
          </button>

          {/* Quiet Reset Projection Anchor */}
          {(activeProjectorUrl || errorText) && (
            <button
              type="button"
              onClick={() => {
                if (activeProjectorUrl) setActiveProjectorUrl(null);
                setErrorText(null);
              }}
              className="sara-reset-button"
              title="Reset Screen Broadcasts"
              aria-label="Reset screen broadcasts and dismiss the error"
            >
              <X size={16} />
            </button>
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

      <AnimatePresence>
        {outcomeFeedbackTask && (
          <TaskOutcomeFeedback
            taskId={outcomeFeedbackTask.taskId}
            onDismiss={() => setOutcomeFeedbackTask(null)}
            onSubmit={handleTaskOutcomeFeedback}
          />
        )}
      </AnimatePresence>

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
        onConfirmMemory={handleConfirmMemory}
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
          variant="quick"
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

