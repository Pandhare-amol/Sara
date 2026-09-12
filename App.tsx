import { useState, useEffect, useRef } from "react";
import { SaraAudioSession, LiveState } from "./src/lib/audio";
import { SaraCoreVisualizer, SaraEmotion } from "./src/components/SaraCoreVisualizer";
import { BrowserAgent } from "./src/components/BrowserAgent";
import { DesktopChatPanel } from "./src/components/DesktopChatPanel";
import { DesktopConversationsPanel } from "./src/components/DesktopConversationsPanel";
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
  Monitor,
  Play,
  Pause,
  Square,
  RefreshCw,
  Settings as SettingsIcon,
  Hand
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Memory, MemoryCategory } from "./src/lib/memoryTypes";
import { MemoryDashboard } from "./src/components/MemoryDashboard";
import { SettingsPanel } from "./src/components/SettingsPanel";
import { TaskManagerPanel } from "./TaskManagerPanel";
import { MusicProjectsPanel } from "./src/components/MusicProjectsPanel";
import WhatsAppPanel from "./src/components/WhatsAppPanel";
import { SaraSettings, DEFAULT_SETTINGS, loadSettings, saveSettings } from "./src/lib/settingsStore";
import { SaraWakeWordDetector } from "./src/lib/wakeWord";
import { SingerPlayer } from "./src/components/SingerPlayer";

export default function App() {
  const [state, setState] = useState<LiveState>("disconnected");

  // Real-time Screen Sharing states
  const [isScreenSharing, setIsScreenSharing] = useState<boolean>(false);
  const [isScreenSharingPaused, setIsScreenSharingPaused] = useState<boolean>(false);
  const [screenVisionMode, setScreenVisionMode] = useState<boolean>(true);
  
  // Real-time Gesture Control state
  const [isGestureControlActive, setIsGestureControlActive] = useState<boolean>(false);

  // References to preserve state across intervals
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenIntervalRef = useRef<any>(null);

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

  const captureFrameAndSend = async () => {
    if (isPausedRef.current || !screenVisionRef.current) {
      return;
    }

    if (stateRef.current === "disconnected") {
      return;
    }

    try {
      const isElectron = (window as any).sara?.isDesktop;
      
      if (isElectron) {
        // Native Electron capture via IPC
        const res = await (window as any).sara.captureScreenFrame({ quality: 55, maxWidth: 960 });
        
        if (!res) {
          console.error("[Screen Capture] No response from captureScreenFrame");
          return;
        }
        
        if (!res.ok) {
          console.error("[Screen Capture] Capture failed:", res.error);
          return;
        }
        
        if (!res.frame) {
          console.error("[Screen Capture] No frame data in response");
          return;
        }
        
        console.log(`[Screen Capture] Frame captured: ${res.width}x${res.height}, ${res.frame.length} bytes`);
        
        if (sessionRef.current && stateRef.current !== "disconnected") {
          sessionRef.current.sendVideoFrame(res.frame);
        }
      } else {
        // Fallback to browser video element capture
        const video = screenVideoRef.current;
        if (!video) {
          console.warn("[Screen Capture] No video element available");
          return;
        }
        
        if (video.videoWidth === 0 || video.videoHeight === 0) {
          console.warn("[Screen Capture] Video dimensions not ready");
          return;
        }

        if (!screenCanvasRef.current) {
          screenCanvasRef.current = document.createElement("canvas");
        }
        const canvas = screenCanvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          console.error("[Screen Capture] Cannot get canvas context");
          return;
        }

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
        const dataUrl = canvas.toDataURL("image/jpeg", 0.55);
        const base64 = dataUrl.split(",")[1];

        if (sessionRef.current && stateRef.current !== "disconnected") {
          sessionRef.current.sendVideoFrame(base64);
        }
      }
    } catch (err) {
      console.error("[Screen Capture] Failed to capture/send frame:", err);
    }
  };

  const startScreenSharing = async () => {
    setErrorText(null);
    try {
      const isElectron = (window as any).sara?.isDesktop;
      
      if (isElectron) {
        // In native Electron, verify permission and immediately transition to sharing state
        console.log("[Screen Sharing] Starting Electron native screen capture...");
        
        const perm = await (window as any).sara.checkScreenPermission();
        
        console.log("[Screen Sharing] Permission check result:", perm);
        
        if (!perm.ok) {
          const detailedError = perm.message || `Screen capture unavailable (sources: ${perm.sourcesFound}, thumbnail: ${perm.thumbnailOk})`;
          console.error("[Screen Sharing] Permission denied:", detailedError);
          throw new Error(detailedError);
        }
        
        console.log("[Screen Sharing] Permission granted, starting capture loop...");
        
        setIsScreenSharing(true);
        setIsScreenSharingPaused(false);
        
        if (screenIntervalRef.current) {
          clearInterval(screenIntervalRef.current);
        }
        screenIntervalRef.current = setInterval(() => {
          captureFrameAndSend();
        }, 2000);
        
        setTimeout(() => {
          captureFrameAndSend();
        }, 500);
        
      } else {
        // Fallback for browser
        console.log("[Screen Sharing] Starting browser screen capture...");
        
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 5 }
          },
          audio: false
        });

        screenStreamRef.current = stream;

        const video = document.createElement("video");
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        video.play().catch(e => console.error("Video play warning:", e));
        screenVideoRef.current = video;

        setIsScreenSharing(true);
        setIsScreenSharingPaused(false);

        stream.getVideoTracks()[0].onended = () => {
          stopScreenSharing();
        };

        if (screenIntervalRef.current) {
          clearInterval(screenIntervalRef.current);
        }
        screenIntervalRef.current = setInterval(() => {
          captureFrameAndSend();
        }, 2000);

        setTimeout(() => {
          captureFrameAndSend();
        }, 500);
      }
    } catch (e: any) {
      console.error("Screen sharing failed:", e);
      
      const errorMessage = e?.message || String(e);
      
      if ((window as any).sara?.isDesktop) {
        // Electron-specific error messages
        if (errorMessage.includes("sources")) {
          setErrorText(`Desktop capture failed: No display sources found. Check Windows display settings or try restarting SARA.`);
        } else if (errorMessage.includes("thumbnail")) {
          setErrorText(`Desktop capture failed: Thumbnail generation failed. Your graphics driver may need updating.`);
        } else {
          setErrorText(`Desktop capture error: ${errorMessage}`);
        }
      } else {
        // Browser error handling
        if (e.name !== "NotAllowedError") {
          setErrorText(`Could not capture screen: ${errorMessage}`);
        }
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
  const [showTaskManager, setShowTaskManager] = useState<boolean>(false);
  const [showMusicProjects, setShowMusicProjects] = useState<boolean>(false);
  const [showQuickChat, setShowQuickChat] = useState<boolean>(true);
    const [showWhatsAppPanel, setShowWhatsAppPanel] = useState<boolean>(false);
  const [quickChatPinned, setQuickChatPinned] = useState<boolean>(false);
  const [quickChatDockPos, setQuickChatDockPos] = useState({ x: 0, y: 0 });
  const [quickChatDockSize, setQuickChatDockSize] = useState({ w: 416, h: 360 });
  const [quickChatDrag, setQuickChatDrag] = useState<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const [quickChatResize, setQuickChatResize] = useState<{ startX: number; startY: number; baseW: number; baseH: number } | null>(null);
  const [quickChatConversationId, setQuickChatConversationId] = useState<string>(() => {
    try {
      return window.localStorage.getItem("sara.quickChatConversationId") || `quickchat-${Date.now()}`;
    } catch {
      return `quickchat-${Date.now()}`;
    }
  });
  const [quickChatInput, setQuickChatInput] = useState<string>("");
  const [quickChatMessages, setQuickChatMessages] = useState<Array<{ role: "user" | "assistant"; text: string; ts: string }>>([]);
  const [quickChatSending, setQuickChatSending] = useState<boolean>(false);
  const [taskStrip, setTaskStrip] = useState<{ total: number; running: number; queued: number; failed: number; completed: number; status: string }>({
    total: 0,
    running: 0,
    queued: 0,
    failed: 0,
    completed: 0,
    status: "idle",
  });
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
  const [showMemoryDashboard, setShowMemoryDashboard] = useState<boolean>(false);

  // V2: Settings + wake word state
  const [settings, setSettings] = useState<SaraSettings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState<boolean>(false);
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

  const toggleWhatsAppPanel = () => setShowWhatsAppPanel((s) => !s);

  const sessionRef = useRef<SaraAudioSession | null>(null);
  const quickChatDockRef = useRef<HTMLDivElement | null>(null);

  // Fetch initial recollections from backend database
  useEffect(() => {
    fetch("/api/memories")
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) {
          setMemories(data);
        }
      })
      .catch(err => console.error("Initial persistent recollections load failure:", err));
  }, []);

  const handleAddManualMemory = async (category: MemoryCategory, text: string) => {
    try {
      const resp = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, text })
      });
      const saved = await resp.json();
      if (saved && saved.id) {
        setMemories((prev) => [...prev, saved]);
      }
    } catch (err) {
      console.error("Manual database recollect upload error:", err);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    try {
      const resp = await fetch(`/api/memories/${id}`, {
        method: "DELETE"
      });
      const resObj = await resp.json();
      if (resObj && resObj.success) {
        setMemories((prev) => prev.filter(m => m.id !== id));
      }
    } catch (err) {
      console.error("Manual memory delete execution failed:", err);
    }
  };

  useEffect(() => {
    try {
      window.localStorage.setItem("sara.quickChatConversationId", quickChatConversationId);
    } catch {}
  }, [quickChatConversationId]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/conversations?source=desktop", { cache: "no-store" });
        const all = await res.json();
        if (!mounted || !Array.isArray(all)) return;
        const existing = all.find((item: any) => item.id === quickChatConversationId);
        if (existing?.messages?.length) {
          setQuickChatMessages(
            existing.messages.map((m: any) => ({
              role: m.role === "assistant" ? "assistant" : "user",
              text: String(m.text ?? m.content ?? ""),
              ts: String(m.timestamp ?? new Date().toISOString()),
            }))
          );
        }
      } catch {}
    })();
    return () => {
      mounted = false;
    };
  }, [quickChatConversationId]);

  useEffect(() => {
    const refreshTasks = async () => {
      try {
        const res = await fetch("/api/tasks", { cache: "no-store" });
        const tasks = await res.json();
        if (!Array.isArray(tasks)) return;
        const running = tasks.filter((t: any) => t.status === "running").length;
        const queued = tasks.filter((t: any) => t.status === "queued" || t.status === "planning" || t.status === "waiting" || t.status === "retrying").length;
        const failed = tasks.filter((t: any) => t.status === "failed").length;
        const completed = tasks.filter((t: any) => t.status === "completed").length;
        setTaskStrip({ total: tasks.length, running, queued, failed, completed, status: running > 0 ? "running" : queued > 0 ? "queued" : failed > 0 ? "attention" : "idle" });
      } catch {}
    };
    void refreshTasks();
    const id = setInterval(refreshTasks, 2500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (quickChatDrag) {
        setQuickChatDockPos({
          x: Math.max(-window.innerWidth * 0.2, Math.min(window.innerWidth * 0.2, quickChatDrag.baseX + (event.clientX - quickChatDrag.startX))),
          y: Math.max(-window.innerHeight * 0.2, Math.min(window.innerHeight * 0.2, quickChatDrag.baseY + (event.clientY - quickChatDrag.startY))),
        });
      }
      if (quickChatResize) {
        setQuickChatDockSize({
          w: Math.max(320, Math.min(window.innerWidth - 16, quickChatResize.baseW + (event.clientX - quickChatResize.startX))),
          h: Math.max(280, Math.min(window.innerHeight - 16, quickChatResize.baseH + (event.clientY - quickChatResize.startY))),
        });
      }
    };
    const onUp = () => {
      setQuickChatDrag(null);
      setQuickChatResize(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [quickChatDrag, quickChatResize]);

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
      onTranscription: (role, text) => {
        if (role === "user") {
          setUserCaption(text);
          // Auto-clear the other caption when user starts talking
          setModelCaption("");
          setCharacterState("thinking");
        } else if (role === "model") {
          setModelCaption((prev) => {
            const next = prev + text;
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
        
        const openInUserBrowser = (url: string, resultLabel: string) => {
          try {
            const api = (window as any).sara;
            if (api?.openExternal) {
              api.openExternal(url);
              callback({ result: `${resultLabel} opened in your browser.` });
              return true;
            }
            window.open(url, "_blank", "noopener,noreferrer");
            callback({ result: `${resultLabel} opened in your browser.` });
            return true;
          } catch (error: any) {
            callback({ error: error?.message || `Could not open ${resultLabel.toLowerCase()}.` });
            return false;
          }
        };

        const isBrowserTool = [
          "browserOpen",
          "browserSearch",
          "browserClick",
          "browserMediaControl",
          "browserScroll",
          "browserType",
          "browserGoBack",
          "browserTabAction",
          "openWebsite",
          "searchWeb",
          "searchYouTube",
          "searchGoogle",
          "searchGitHub"
        ].includes(name);

        if (isBrowserTool) {
          const url = (() => {
            if (name === "openWebsite") {
              if (args.url) return String(args.url);
              const site = String(args.name || "").toLowerCase();
              const siteMap: Record<string, string> = {
                youtube: "https://www.youtube.com",
                gmail: "https://mail.google.com",
                google: "https://www.google.com",
                github: "https://github.com",
                chatgpt: "https://chatgpt.com",
              };
              return siteMap[site] || String(args.name || "");
            }
            if (name === "searchYouTube") {
              return `https://www.youtube.com/results?search_query=${encodeURIComponent(String(args.query || ""))}`;
            }
            if (name === "searchGoogle" || (name === "browserSearch" && String(args.engine || "google").toLowerCase() === "google")) {
              return `https://www.google.com/search?q=${encodeURIComponent(String(args.query || args.text || ""))}`;
            }
            if (name === "searchGitHub") {
              return `https://github.com/search?q=${encodeURIComponent(String(args.query || ""))}&type=repositories`;
            }
            if (name === "searchWeb") {
              const engine = String(args.engine || "google").toLowerCase();
              const query = encodeURIComponent(String(args.query || ""));
              const map: Record<string, string> = {
                google: `https://www.google.com/search?q=${query}`,
                youtube: `https://www.youtube.com/results?search_query=${query}`,
                github: `https://github.com/search?q=${query}&type=repositories`,
                duckduckgo: `https://duckduckgo.com/?q=${query}`,
                bing: `https://www.bing.com/search?q=${query}`,
              };
              return map[engine] || map.google;
            }
            if (name === "browserOpen" || name === "browserSearch") {
              return String(args.url || args.query || "https://www.google.com");
            }
            return String(args.url || "https://www.google.com");
          })();

          if (name === "browserClick" || name === "browserType" || name === "browserScroll" || name === "browserMediaControl" || name === "browserGoBack" || name === "browserTabAction") {
            callback({ result: "That browser action is now handled in your browser instead of Sara's embedded browser. Please use the user browser tab that opened." });
            return;
          }

          openInUserBrowser(url, name === "searchYouTube" ? "YouTube search" : name === "searchGoogle" ? "Google search" : name === "searchGitHub" ? "GitHub search" : name === "searchWeb" ? "Search" : "Website");
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
      }
    });

    return () => {
      if (sessionRef.current) {
        sessionRef.current.disconnect();
      }
    };
  }, []);

  // Track stored conversationId in localStorage so the header control can show it
  useEffect(() => {
    try {
      const s = window.localStorage.getItem("sara.conversationId");
      setStoredConversationId(s);
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
      setShowConvPanel(false);
      if (sessionRef.current && state === "disconnected") {
        await sessionRef.current.connect();
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
      await sessionRef.current.connect();
    } else {
      sessionRef.current.disconnect();
    }
  };
  // V2: keep the ref in sync so the wake-word callback calls this exact handler.
  connectHandlerRef.current = handleToggleConnection;

  const sendQuickChat = async () => {
    const text = quickChatInput.trim();
    if (!text || quickChatSending) return;
    const userMsg = { role: "user" as const, text, ts: new Date().toISOString() };
    const next = [...quickChatMessages, userMsg];
    setQuickChatMessages(next);
    setQuickChatInput("");
    setQuickChatSending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, history: next.map((m) => ({ role: m.role, text: m.text })), source: "desktop", conversationId: quickChatConversationId }),
      });
      const data = await res.json();
      const reply = data.text || data.result || data.error || "No response.";
      const updated = [...next, { role: "assistant" as const, text: reply, ts: new Date().toISOString() }];
      setQuickChatMessages(updated);
      try {
        await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "desktop",
            conversation: {
              id: quickChatConversationId,
              title: "Quick Chat with SARA",
              updatedAt: new Date().toISOString(),
              messages: updated.map((m) => ({
                role: m.role,
                text: m.text,
                timestamp: m.ts,
              })),
            },
          }),
        });
      } catch {}
    } catch (e: any) {
      const updated = [...next, { role: "assistant" as const, text: e?.message || "Could not reach Sara.", ts: new Date().toISOString() }];
      setQuickChatMessages(updated);
    } finally {
      setQuickChatSending(false);
    }
  };

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
    <>
      <SingerPlayer conversationId={storedConversationId} conversationIds={[quickChatConversationId]} />
      {showWhatsAppPanel && <WhatsAppPanel onClose={() => setShowWhatsAppPanel(false)} />}
      <div style={{ position: 'fixed', right: 20, bottom: 100, zIndex: 9998 }}>
        <button onClick={toggleWhatsAppPanel} style={{ padding: '8px 12px', borderRadius: 8 }}>WhatsApp</button>
      </div>
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

          {/* Real-time screen sharing toggler button inside Sara glass style header */}
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

          {/* Gesture Control status indicator */}
          <button 
            onClick={() => {
              if (isGestureControlActive) {
                setIsGestureControlActive(false);
                fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'gestureControlStop' }) }).catch(()=>{});
              } else {
                setIsGestureControlActive(true);
                fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'gestureControlStart' }) }).catch(()=>{});
              }
            }}
            className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer ${
              isGestureControlActive 
                ? "text-cyan-400 opacity-100 font-semibold" 
                : "opacity-25 hover:opacity-100 text-white"
            }`}
            title="Toggle Hand Gesture Control"
          >
            <Hand size={14} className={isGestureControlActive ? "animate-pulse text-cyan-400" : ""} />
            <span>{isGestureControlActive ? "GESTURE ON" : "GESTURE OFF"}</span>
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
        </div>
      </header>

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
            title={state === "disconnected" ? "Awake Sara" : "Sleep core"}
          >
            {state === "disconnected" ? (
              <Power className="opacity-80" size={24} />
            ) : state === "connecting" ? (
              <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : state === "listening" ? (
              <Mic size={24} className="text-cyan-200" />
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

      {/* Recollections sliding core panel */}
      <MemoryDashboard
        isOpen={showMemoryDashboard}
        onClose={() => setShowMemoryDashboard(false)}
        memories={memories}
        onAddMemory={handleAddManualMemory}
        onDeleteMemory={handleDeleteMemory}
        themeColor={themeColor}
      />

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
          setShowDesktopChat(true);
          setShowDesktopConversations(false);
        }}
        onCreateNew={() => {
          setDesktopConversationId(null);
          setShowDesktopChat(true);
          setShowDesktopConversations(false);
        }}
      />

      <TaskManagerPanel
        isOpen={showTaskManager}
        onClose={() => setShowTaskManager(false)}
      />

      <MusicProjectsPanel
        isOpen={showMusicProjects}
        onClose={() => setShowMusicProjects(false)}
      />

      {/* Quick floating chat dock */}
      <AnimatePresence>
        {showQuickChat && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.96 }}
            ref={quickChatDockRef}
            style={{
              width: `min(${quickChatDockSize.w}px, calc(100vw - 2rem))`,
              height: `min(${quickChatDockSize.h}px, calc(100vh - 2rem))`,
              transform: `translate3d(${quickChatDockPos.x}px, ${quickChatDockPos.y}px, 0)`,
            }}
            className={`fixed left-4 top-4 sm:left-auto sm:top-auto z-50 rounded-3xl border border-white/12 bg-slate-950/80 backdrop-blur-2xl shadow-[0_20px_80px_rgba(0,0,0,0.45)] overflow-hidden flex flex-col ${quickChatPinned ? "ring-1 ring-cyan-400/25" : ""}`}
          >
            <div className={`h-1 w-full bg-gradient-to-r transition-all duration-500 ${
              themeColor === "violet" ? "from-violet-400 via-cyan-300 to-fuchsia-400" :
              themeColor === "crimson" ? "from-rose-400 via-orange-300 to-amber-400" :
              themeColor === "emerald" ? "from-emerald-400 via-cyan-300 to-teal-400" :
              themeColor === "celestial" ? "from-sky-400 via-indigo-300 to-cyan-300" :
              themeColor === "gold" ? "from-amber-300 via-yellow-200 to-orange-300" :
              themeColor === "rose" ? "from-pink-400 via-rose-300 to-fuchsia-400" :
              "from-indigo-400 via-cyan-300 to-sky-400"
            }`} />
            <div
              className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/8 bg-white/5 cursor-move select-none"
              onPointerDown={(e) => {
                if (window.innerWidth < 640) return;
                setQuickChatDrag({
                  startX: e.clientX,
                  startY: e.clientY,
                  baseX: quickChatDockPos.x,
                  baseY: quickChatDockPos.y,
                });
              }}
            >
              <div>
                <div className="text-[10px] uppercase tracking-[0.28em] text-slate-400 font-mono">Quick Chat</div>
                <div className="text-sm text-white font-medium">Sara is ready</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowMusicProjects(true)}
                  className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.2em] text-cyan-200 hover:bg-cyan-400/20"
                >
                  Music
                </button>
                <button
                  onClick={() => setQuickChatPinned((v) => !v)}
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.2em] text-slate-300 hover:bg-white/10"
                >
                  {quickChatPinned ? "Pinned" : "Pin"}
                </button>
                <button
                  onClick={() => setShowQuickChat((v) => !v)}
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.2em] text-slate-300 hover:bg-white/10"
                >
                  {showQuickChat ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            <div className="px-4 pt-3">
              <div className="grid grid-cols-4 gap-2 rounded-2xl border border-white/8 bg-white/5 p-2 text-[10px] uppercase tracking-[0.2em] text-slate-300 font-mono">
                <div className="rounded-xl bg-white/5 px-2 py-1.5">
                  <div className="text-slate-500">Tasks</div>
                  <div className="mt-1 text-white">{taskStrip.total}</div>
                </div>
                <div className="rounded-xl bg-cyan-500/10 px-2 py-1.5">
                  <div className="text-cyan-200/70">Running</div>
                  <div className="mt-1 text-cyan-100">{taskStrip.running}</div>
                </div>
                <div className="rounded-xl bg-amber-500/10 px-2 py-1.5">
                  <div className="text-amber-200/70">Queued</div>
                  <div className="mt-1 text-amber-100">{taskStrip.queued}</div>
                </div>
                <div className="rounded-xl bg-emerald-500/10 px-2 py-1.5">
                  <div className="text-emerald-200/70">Done</div>
                  <div className="mt-1 text-emerald-100">{taskStrip.completed}</div>
                </div>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
              {quickChatMessages.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-3 py-4 text-xs text-slate-400">
                  Ask something here. Sara will stay responsive while tasks run.
                </div>
              ) : (
                quickChatMessages.map((msg, idx) => (
                  <div
                    key={`${msg.role}-${idx}-${msg.ts}`}
                    className={`max-w-[92%] rounded-2xl px-3 py-2 text-sm leading-6 ${
                      msg.role === "user"
                        ? "ml-auto bg-cyan-400/15 text-cyan-50 border border-cyan-300/15"
                        : "mr-auto bg-white/6 text-slate-100 border border-white/8"
                    }`}
                  >
                    {msg.text}
                  </div>
                ))
              )}
            </div>

            <div className="border-t border-white/8 bg-slate-950/80 p-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={quickChatInput}
                  onChange={(e) => setQuickChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendQuickChat();
                    }
                  }}
                  placeholder="Type a message..."
                  className="min-h-[52px] max-h-28 flex-1 resize-none rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 outline-none focus:border-cyan-400/60"
                />
                <button
                  onClick={() => void sendQuickChat()}
                  disabled={quickChatSending || !quickChatInput.trim()}
                  className="shrink-0 rounded-2xl bg-gradient-to-r from-cyan-400 to-indigo-400 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-50"
                >
                  {quickChatSending ? "..." : "Send"}
                </button>
              </div>
            </div>

            <div
              className="absolute right-2 bottom-2 h-4 w-4 cursor-nwse-resize rounded-md border border-white/10 bg-white/10"
              onPointerDown={(e) => {
                if (window.innerWidth < 640) return;
                setQuickChatResize({
                  startX: e.clientX,
                  startY: e.clientY,
                  baseW: quickChatDockSize.w,
                  baseH: quickChatDockSize.h,
                });
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* V2: Settings sliding core panel */}
      <SettingsPanel
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onChange={handleSettingsChange}
        themeColor={themeColor}
      />
      </div>
    </>
  );
}
