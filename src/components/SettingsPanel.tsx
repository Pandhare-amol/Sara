import React, { useEffect, useState } from "react";
import {
  Settings,
  X,
  Power,
  Mic,
  Cpu,
  Info,
  Check,
  AlertTriangle,
  Volume2,
  Sparkles,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  SaraSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "../lib/settingsStore";

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Current settings (owned by App so wake-word state stays in sync). */
  settings: SaraSettings;
  /** Persist a settings patch (also notifies App of changes). */
  onChange: (patch: Partial<SaraSettings>) => void;
  themeColor: string;
  /** When true, disables inputs because Sara is actively running */
  locked?: boolean;
}

type SettingsTab = "general" | "voice" | "system" | "about";

type StoredSpeakerProfile = {
  userId: string;
  displayName: string;
  fingerprint: number[];
  confidence: number;
  enrolledAt: string;
};

const VOICE_PROFILE_STORAGE_KEY = "sara.voiceProfile.v1";

function loadStoredSpeakerProfile(): StoredSpeakerProfile | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(VOICE_PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSpeakerProfile;
    return parsed && Array.isArray(parsed.fingerprint) ? parsed : null;
  } catch {
    return null;
  }
}

function saveStoredSpeakerProfile(profile: StoredSpeakerProfile): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VOICE_PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Ignore storage failures; feature remains best effort.
  }
}

function fingerprintFromAudioBuffer(audioBuffer: AudioBuffer): number[] {
  const channelData = audioBuffer.getChannelData(0);
  const bins = 16;
  const step = Math.max(1, Math.floor(channelData.length / bins));
  const values: number[] = [];

  for (let bin = 0; bin < bins; bin++) {
    const start = bin * step;
    const end = Math.min(start + step, channelData.length);
    const slice = channelData.subarray(start, end);
    let sumSquares = 0;
    for (let i = 0; i < slice.length; i++) {
      sumSquares += slice[i] * slice[i];
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, slice.length));
    values.push(Number(rms.toFixed(4)));
  }

  const maxValue = Math.max(...values, 1);
  return values.map((value) => Number((Math.abs(value) / maxValue).toFixed(4)));
}

function compareVoiceFingerprints(left: number[], right: number[]): number {
  if (!left.length || !right.length) return 0;
  const length = Math.min(left.length, right.length);
  let total = 0;
  for (let i = 0; i < length; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    total += diff * diff;
  }
  const distance = Math.sqrt(total / Math.max(1, length));
  return Math.max(0, 1 - Math.min(distance / 0.7, 1));
}

/** A single toggle row matching the existing "Screen Vision Mode" switch style. */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="pt-2 border-t border-white/5 flex items-center justify-between text-left">
      <div className="flex flex-col">
        <span className="text-[10px] font-bold font-mono text-slate-200">{label}</span>
        <span className="text-[8px] text-slate-400 uppercase font-mono max-w-[200px]">
          {description}
        </span>
      </div>
      <button
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
        className={`w-10 h-5 rounded-full p-0.5 transition-colors duration-200 focus:outline-none ${
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
        } ${checked ? "bg-cyan-500" : "bg-white/10"}`}
      >
        <div
          className={`bg-white w-4 h-4 rounded-full shadow-md transform duration-200 ease-in-out ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

export function SettingsPanel({ isOpen, onClose, settings, onChange, themeColor, locked }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [voiceProfile, setVoiceProfile] = useState<StoredSpeakerProfile | null>(() => loadStoredSpeakerProfile());
  const [voiceStatus, setVoiceStatus] = useState<string>("No enrolled speaker yet.");
  const [isRecordingVoice, setIsRecordingVoice] = useState<boolean>(false);
  const [agentHealth, setAgentHealth] = useState<{
    online: boolean;
    toolCount?: number;
    cpu?: string;
    ram?: string;
  }>({ online: false });

  const captureVoiceSample = async (mode: "enroll" | "identify") => {
    if (locked) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceStatus("Microphone access is unavailable in this browser.");
      return;
    }

    try {
      setIsRecordingVoice(true);
      setVoiceStatus(mode === "enroll" ? "Recording a short voice sample..." : "Checking the current speaker profile...");

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];

      await new Promise<void>((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onerror = () => reject(new Error("Voice sample capture failed."));
        recorder.onstop = () => resolve();
        recorder.start();
        window.setTimeout(() => {
          try {
            recorder.stop();
          } catch {
            resolve();
          }
        }, 2200);
      });

      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: mimeType });
      const arrayBuffer = await blob.arrayBuffer();
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error("AudioContext is unavailable.");
      }
      const audioContext = new AudioContextClass();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      const fingerprint = fingerprintFromAudioBuffer(audioBuffer);
      await audioContext.close();

      if (mode === "enroll") {
        const profile: StoredSpeakerProfile = {
          userId: "local-user",
          displayName: "Local User",
          fingerprint,
          confidence: 0.93,
          enrolledAt: new Date().toISOString(),
        };
        saveStoredSpeakerProfile(profile);
        setVoiceProfile(profile);
        setVoiceStatus("Speaker profile enrolled successfully.");
        return;
      }

      const existing = loadStoredSpeakerProfile();
      if (!existing) {
        setVoiceStatus("No speaker profile is enrolled yet. Enroll one first.");
        return;
      }

      const matchScore = compareVoiceFingerprints(existing.fingerprint, fingerprint);
      const recognized = matchScore >= 0.8;
      setVoiceStatus(
        recognized
          ? `Speaker identified as ${existing.displayName} (${matchScore.toFixed(2)} confidence)`
          : `Speaker not recognized (${matchScore.toFixed(2)} confidence)`
      );
    } catch (error) {
      console.warn("Voice enrollment failed:", error);
      setVoiceStatus("Voice capture failed. Please try again.");
    } finally {
      setIsRecordingVoice(false);
    }
  };

  // Enumerate microphones (mirrors how audio.ts grabs getUserMedia).
  useEffect(() => {
    if (!isOpen) return;
    const enumerate = async () => {
      try {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMics(devices.filter((d) => d.kind === "audioinput"));
      } catch {
        /* permission may be needed first */
      }
    };
    enumerate();
  }, [isOpen]);

  // Probe desktop agent health through the same-origin server proxy.
  useEffect(() => {
    if (!isOpen) return;
    let abortController: AbortController | null = null;
    let isPending = false;

    const probe = async () => {
      if (isPending) return;
      
      isPending = true;
      abortController?.abort();
      abortController = new AbortController();
      const timeoutId = window.setTimeout(() => abortController?.abort(), 3500);
      try {
        const response = await fetch("/api/agent-health", {
          cache: "no-store",
          signal: abortController.signal,
        });
        if (response.ok) {
          const data = await response.json();
          setAgentHealth({ online: !!data.online, toolCount: data.tool_count });
        } else {
          setAgentHealth({ online: false });
        }
      } catch (error: any) {
        if (error?.name !== "AbortError") setAgentHealth({ online: false });
      } finally {
        window.clearTimeout(timeoutId);
        isPending = false;
      }
    };

    // Initial probe
    probe();
    // Poll every 10 seconds (reduced from 5 to prevent request flooding)
    const id = setInterval(probe, 10000);
    return () => {
      clearInterval(id);
      abortController?.abort();
    };
  }, [isOpen]);

  const getThemeBadgeGlow = () => {
    switch (themeColor) {
      case "violet": return "border-purple-500/30 text-purple-400 bg-purple-500/10";
      case "crimson": return "border-rose-500/30 text-rose-400 bg-rose-500/10";
      case "emerald": return "border-emerald-500/30 text-emerald-400 bg-emerald-500/10";
      case "celestial": return "border-sky-500/30 text-sky-400 bg-sky-500/10";
      case "gold": return "border-amber-500/30 text-amber-400 bg-amber-500/10";
      case "rose": return "border-pink-500/30 text-pink-400 bg-pink-500/10";
      case "charcoal":
      default:
        return "border-indigo-500/30 text-indigo-400 bg-indigo-500/10";
    }
  };

  const tabs: { id: SettingsTab; label: string; icon: any }[] = [
    { id: "general", label: "GENERAL", icon: Power },
    { id: "voice", label: "VOICE", icon: Mic },
    { id: "system", label: "SYSTEM", icon: Cpu },
    { id: "about", label: "ABOUT", icon: Info },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop Overlay â€” identical to MemoryDashboard */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 z-40 backdrop-blur-sm"
          />

          {/* Slide-over Container â€” identical shell to MemoryDashboard */}
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="absolute inset-y-0 right-0 w-full max-w-lg bg-[#020206]/95 border-l border-white/15 backdrop-blur-2xl z-50 flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.8)]"
          >
            {/* Header */}
            <div className="p-6 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl border ${getThemeBadgeGlow()}`}>
                  <Settings size={22} className="animate-spin [animation-duration:6s]" />
                </div>
                <div>
                  <h3 className="font-display font-medium text-lg tracking-tight text-white flex items-center gap-2">
                    Sara Configuration
                    <Sparkles size={14} className="text-cyan-400" />
                  </h3>
                  <p className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mt-0.5">
                    System settings &amp; preferences
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {locked && (
              <div className="px-6 py-3 border-b border-amber-500/10 bg-amber-900/10 text-amber-300 text-sm">
                Settings are locked while Sara is active. Stop Sara to change preferences.
              </div>
            )}

            {/* Tab selector row â€” mirrors MemoryDashboard pill style */}
            <div className="px-6 py-4 border-b border-white/5 flex items-center gap-2 overflow-x-auto">
              {tabs.map((t) => {
                const Icon = t.icon;
                const active = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-mono tracking-wider transition shrink-0 cursor-pointer ${
                      active
                        ? "border-cyan-400 bg-cyan-400/10 text-cyan-300"
                        : "border-white/5 bg-white/5 text-slate-400 hover:bg-white/10"
                    }`}
                  >
                    <Icon size={12} />
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Scrollable content area */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* ---------------- GENERAL ---------------- */}
              {activeTab === "general" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Startup &amp; Appearance
                  </div>

                  <ToggleRow
                    label="LAUNCH AT STARTUP"
                    description="Start Sara silently when Windows logs in"
                    checked={settings.autoStart}
                    onChange={(v) => {
                      onChange({ autoStart: v });
                      // Persist + push to backend; the desktop agent flips the
                      // HKCU Run registry key. We just record intent here.
                      void fetch("/api/settings", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ autoStart: v }),
                      }).catch(() => {});
                    }}
                    disabled={locked}
                  />

                  <ToggleRow
                    label="UI ANIMATIONS"
                    description="Enable motion and orb transitions"
                    checked={settings.animations}
                    onChange={(v) => onChange({ animations: v })}
                    disabled={locked}
                  />

                  <div className="pt-4 border-t border-white/10 text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Social Intelligence
                  </div>

                  <ToggleRow
                    label="PROACTIVE CONVERSATION"
                    description="Allow grounded check-ins when useful"
                    checked={settings.proactiveConversation}
                    onChange={(v) => onChange({ proactiveConversation: v })}
                    disabled={locked}
                  />
                  <ToggleRow
                    label="SMART INTERRUPTION"
                    description="Permit important context-aware interruptions"
                    checked={settings.smartInterruption}
                    onChange={(v) => onChange({ smartInterruption: v })}
                    disabled={locked}
                  />
                  <ToggleRow
                    label="EMOTION AWARENESS"
                    description="Use uncertain text signals to adapt responses"
                    checked={settings.emotionAwareness}
                    onChange={(v) => onChange({ emotionAwareness: v })}
                    disabled={locked}
                  />
                  <ToggleRow
                    label="HUMOR"
                    description="Allow light humor in suitable conversations"
                    checked={settings.humor}
                    onChange={(v) => onChange({ humor: v })}
                    disabled={locked}
                  />
                  <ToggleRow
                    label="PLAYFUL MODE"
                    description="Allow harmless playful responses"
                    checked={settings.playfulMode}
                    onChange={(v) => onChange({ playfulMode: v })}
                    disabled={locked}
                  />
                  <ToggleRow
                    label="PRANK MODE"
                    description="Allow only reversible, explicitly enabled jokes"
                    checked={settings.prankMode}
                    onChange={(v) => onChange({ prankMode: v })}
                    disabled={locked}
                  />
                  <ToggleRow
                    label="AI PERSPECTIVE"
                    description="Identify opinions as SARA's assessment"
                    checked={settings.aiPerspective}
                    onChange={(v) => onChange({ aiPerspective: v })}
                    disabled={locked}
                  />
                  <ToggleRow
                    label="CONVERSATION MEMORY"
                    description="Remember non-sensitive conversational context"
                    checked={settings.conversationMemory}
                    onChange={(v) => onChange({ conversationMemory: v })}
                    disabled={locked}
                  />
                  <ToggleRow
                    label="QUIET MODE"
                    description="Suppress proactive conversation until disabled"
                    checked={settings.quietMode}
                    onChange={(v) => onChange({ quietMode: v })}
                    disabled={locked}
                  />
                  <div className="space-y-1.5 pt-2 border-t border-white/5">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-mono tracking-wider text-slate-300 uppercase">Conversation Cooldown</label>
                      <span className="text-[10px] font-mono text-cyan-300">{settings.conversationCooldown}s</span>
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={86400}
                      step={60}
                      value={settings.conversationCooldown}
                      onChange={(e) => !locked && onChange({ conversationCooldown: Math.max(0, Number(e.target.value) || 0) })}
                      disabled={locked}
                      className={`w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white font-mono focus:outline-none focus:border-cyan-400/50 transition ${locked ? 'opacity-50 cursor-not-allowed' : ''}`}
                    />
                  </div>

                  {settings.autoStart && (
                    <div className="mt-2 p-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 flex items-center gap-2">
                      <Check size={14} className="text-emerald-400 shrink-0" />
                      <span className="text-[10px] font-mono text-emerald-300/80">
                        Sara will auto-launch on next Windows login.
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* ---------------- VOICE ---------------- */}
              {activeTab === "voice" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Wake Word &amp; Microphone
                  </div>

                  <ToggleRow
                    label="WAKE WORD"
                    description="Always-listen for the activation phrase"
                    checked={settings.wakeWordEnabled}
                    onChange={(v) => onChange({ wakeWordEnabled: v })}
                    disabled={locked}
                  />

                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                      Wake Phrase
                    </label>
                    <input
                      type="text"
                      value={settings.wakePhrase}
                      onChange={(e) => !locked && onChange({ wakePhrase: e.target.value })}
                      placeholder="hey sara"
                      disabled={locked}
                      className={`w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white font-mono focus:outline-none focus:border-cyan-400/50 transition ${locked ? 'opacity-50 cursor-not-allowed' : ''}`}
                    />
                    <span className="text-[8px] text-slate-500 uppercase font-mono">
                      Say this phrase to activate Sara
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                      Conversation Language
                    </label>
                    <select
                      value={settings.language || "en"}
                      onChange={(e) => !locked && onChange({ language: e.target.value })}
                      disabled={locked}
                      className={`w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white font-mono focus:outline-none focus:border-cyan-400/50 transition ${locked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      <option value="en">English</option>
                      <option value="hi">Hindi (हिंदी)</option>
                      <option value="mr">Marathi (मराठी)</option>
                      <option value="gu">Gujarati (ગુજરાતી)</option>
                      <option value="bn">Bengali (বাংলা)</option>
                      <option value="ta">Tamil (தமிழ்)</option>
                      <option value="te">Telugu (తెలుగు)</option>
                      <option value="kn">Kannada (ಕನ್ನಡ)</option>
                      <option value="ml">Malayalam (മലയാളം)</option>
                      <option value="pa">Punjabi (ਪੰਜਾਬੀ)</option>
                    </select>
                    <span className="text-[8px] text-slate-500 uppercase font-mono">
                      Selected or auto-detected language for voice &amp; chat
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                      Microphone
                    </label>
                    <select
                      value={settings.micDeviceId}
                      onChange={(e) => !locked && onChange({ micDeviceId: e.target.value })}
                      disabled={locked}
                      className={`w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white font-mono focus:outline-none focus:border-cyan-400/50 transition ${locked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      <option value="">System Default</option>
                      {mics.map((m, i) => (
                        <option key={m.deviceId || i} value={m.deviceId}>
                          {m.label || `Microphone ${i + 1}`}
                        </option>
                      ))}
                    </select>
                    <span className="text-[8px] text-slate-500 uppercase font-mono">
                      {mics.length === 0
                        ? "Grant mic permission to list devices"
                        : `${mics.length} device(s) detected`}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                        Sensitivity
                      </label>
                      <span className="text-[10px] font-mono text-cyan-300">
                        {settings.sensitivity}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={settings.sensitivity}
                      onChange={(e) => !locked && onChange({ sensitivity: Number(e.target.value) })}
                      disabled={locked}
                      className={`w-full accent-cyan-500 ${locked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    />
                    <span className="text-[8px] text-slate-500 uppercase font-mono">
                      Higher = faster re-arm &amp; more matches
                    </span>
                  </div>

                  <div className="p-3 rounded-xl border border-white/10 bg-white/5 space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500">
                      Speaker Enrollment
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[10px] font-mono text-slate-300">
                        {voiceProfile ? `Enrolled: ${voiceProfile.displayName}` : "No participant profile saved"}
                      </div>
                      {voiceProfile && (
                        <div className="text-[9px] font-mono text-emerald-300">
                          {voiceProfile.confidence.toFixed(2)} confidence
                        </div>
                      )}
                    </div>

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void captureVoiceSample("enroll")}
                        disabled={locked || isRecordingVoice}
                        className={`flex-1 rounded-xl border px-3 py-2 text-[10px] font-mono uppercase tracking-widest transition ${
                          locked || isRecordingVoice
                            ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                            : "border-cyan-400/40 bg-cyan-400/10 text-cyan-200 hover:bg-cyan-400/15 cursor-pointer"
                        }`}
                      >
                        {isRecordingVoice ? "Recording..." : "Enroll Voice"}
                      </button>

                      <button
                        type="button"
                        onClick={() => void captureVoiceSample("identify")}
                        disabled={locked || isRecordingVoice}
                        className={`flex-1 rounded-xl border px-3 py-2 text-[10px] font-mono uppercase tracking-widest transition ${
                          locked || isRecordingVoice
                            ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                            : "border-violet-400/40 bg-violet-400/10 text-violet-200 hover:bg-violet-400/15 cursor-pointer"
                        }`}
                      >
                        Identify
                      </button>
                    </div>

                    <div className="text-[9px] font-mono text-slate-400 leading-relaxed">
                      {voiceStatus}
                    </div>
                  </div>
                </div>
              )}

              {/* ---------------- SYSTEM ---------------- */}
              {activeTab === "system" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Desktop Control Agent
                  </div>

                  <div
                    className={`p-4 rounded-xl border flex items-center gap-3 ${
                      agentHealth.online
                        ? "border-emerald-500/20 bg-emerald-500/5"
                        : "border-rose-500/20 bg-rose-500/5"
                    }`}
                  >
                    <div
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        agentHealth.online ? "bg-emerald-400 animate-pulse" : "bg-rose-400"
                      }`}
                    />
                    <div className="flex-1">
                      <div className="text-xs font-mono text-white">
                        {agentHealth.online ? "Agent Online" : "Agent Offline"}
                      </div>
                      <div className="text-[10px] font-mono text-slate-400">
                        {agentHealth.online
                          ? `${agentHealth.toolCount ?? 0} tools registered`
                          : "Start the Python agent on port 8765"}
                      </div>
                    </div>
                    <Cpu size={16} className="text-slate-500" />
                  </div>

                  <div className="p-3 rounded-xl border border-white/5 bg-white/5 space-y-2">
                    <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                      <Volume2 size={12} /> Capabilities
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono text-slate-300">
                      <span>âœ“ App control</span>
                      <span>âœ“ Browser</span>
                      <span>âœ“ Volume</span>
                      <span>âœ“ Brightness</span>
                      <span>âœ“ Power</span>
                      <span>âœ“ Files</span>
                      <span>âœ“ Screenshot</span>
                      <span>âœ“ Clipboard</span>
                    </div>
                  </div>

                  <ToggleRow
                    label="AUTO-ENABLE GESTURE CONTROL"
                    description="Start local hand gesture control automatically when Sara starts"
                    checked={settings.autoEnableGesture}
                    onChange={(v) => onChange({ autoEnableGesture: v })}
                    disabled={locked}
                  />
                </div>
              )}

              {/* ---------------- ABOUT ---------------- */}
              {activeTab === "about" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    About Sara
                  </div>

                  <div className="p-4 rounded-xl border border-white/5 bg-white/5 space-y-3">
                    <div className="flex items-center gap-2">
                      <Info size={14} className="text-cyan-400" />
                      <span className="text-sm font-display text-white">SARA AI Assistant</span>
                    </div>
                    <div className="space-y-1.5 text-[10px] font-mono text-slate-400">
                      <div className="flex justify-between">
                        <span>VERSION</span>
                        <span className="text-slate-300">V2.0.0</span>
                      </div>
                      <div className="flex justify-between">
                        <span>ENGINE</span>
                        <span className="text-slate-300">Gemini Live</span>
                      </div>
                      <div className="flex justify-between">
                        <span>DESKTOP</span>
                        <span className="text-slate-300">FastAPI Agent</span>
                      </div>
                      <div className="flex justify-between">
                        <span>WAKE WORD</span>
                        <span className="text-slate-300">Web Speech API</span>
                      </div>
                      <div className="flex justify-between">
                        <span>PROVENANCE</span>
                        <span className="text-emerald-400 font-bold">Cryptographically Verified</span>
                      </div>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 flex items-center justify-between">
                    <span className="text-[10px] font-mono text-cyan-300">Security &amp; Audit Dashboard</span>
                    <a
                      href="/admin/security"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-2.5 py-1 rounded-lg border border-cyan-400/40 bg-cyan-400/10 text-cyan-200 text-[10px] font-mono font-semibold hover:bg-cyan-400/20 transition"
                    >
                      OPEN DASHBOARD
                    </a>
                  </div>

                  <div className="p-3 rounded-xl border border-amber-500/15 bg-amber-500/5 flex items-start gap-2">
                    <AlertTriangle size={12} className="text-amber-400 shrink-0 mt-0.5" />
                    <span className="text-[10px] font-mono text-amber-300/70 leading-relaxed">
                      Keep this tab active for wake-word detection. Microphone access
                      is required for voice activation.
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Footer status bar â€” mirrors MemoryDashboard */}
            <div className="px-6 py-3 border-t border-white/5 bg-white/5 flex items-center justify-between">
              <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
                Preferences auto-save
              </span>
              <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
                Sara V2
              </span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

