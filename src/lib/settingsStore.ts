/**
 * SARA Settings Store â€” persistent user preferences (V2).
 *
 * Establishes the persistence pattern for SARA: settings are mirrored to
 * localStorage (instant local read) AND synced to the backend (settings.json)
 * so auto-start / wake-word preferences survive across browsers and the
 * Python desktop agent can read them too.
 *
 * Pattern follows the existing codebase conventions: plain state + ref mirrors.
 * No Context/Zustand â€” this is deliberately lightweight to match audio.ts/memoryTypes.ts.
 */

export interface SaraSettings {
  /** Launch SARA (backends + browser tab) silently on Windows login. */
  autoStart: boolean;
  /** Enable the always-listening wake-word detector. */
  wakeWordEnabled: boolean;
  /** Phrase that activates SARA (case-insensitive substring match). */
  wakePhrase: string;
  /** Preferred microphone device id ("" = system default). */
  micDeviceId: string;
  /** Wake-word sensitivity: 0 (strict) .. 100 (loose). Affects debounce window. */
  sensitivity: number;
  /** Preferred conversation language (en, hi, mr, gu, bn, ta, te, kn, ml, pa). */
  language: string;
  /** Auto-enable hand gesture control when SARA starts (false = manual) */
  autoEnableGesture: boolean;
  /** Master toggle for UI animations. */
  animations: boolean;
  proactiveConversation: boolean;
  smartInterruption: boolean;
  humor: boolean;
  playfulMode: boolean;
  prankMode: boolean;
  allowAutonomousUse: boolean; // default off, enables autonomous computer actions
  emotionAwareness: boolean;
  aiPerspective: boolean;
  conversationMemory: boolean;
  quietMode: boolean;
  conversationCooldown: number;
  /** Current approved SARA visual profile. */
  themeColor: string;
  /** Layout density for repeated controls and panels. */
  uiDensity: "compact" | "balanced" | "spacious";
  /** Strength of the frosted-glass surfaces, from 0 to 100. */
  glassIntensity: number;
  /** Allow SARA to suggest a bounded visual profile after a conversation. */
  adaptiveAppearance: boolean;
  /** Selected character animation persona. */
  animationProfile: string;
  /** Start camera monitoring only after the user has explicitly opted in. */
  cameraMonitoringConsent: boolean;
  /** Start screen capture only after the user has explicitly opted in. */
  screenMonitoringConsent: boolean;
  /** Persist camera observation metadata, never raw frames by default. */
  activityMetadataPersistence: boolean;
  /** Number of days to retain camera activity metadata. */
  activityMetadataRetentionDays: number;
  /** Current active model profile id. */
  activeModelId: string;
}

export const DEFAULT_SETTINGS: SaraSettings = {
  autoStart: false,
  wakeWordEnabled: false,
  wakePhrase: "hey sara",
  micDeviceId: "",
  sensitivity: 60,
  language: "en",
  allowAutonomousUse: false,
  autoEnableGesture: false,
  animations: true,
  proactiveConversation: false,
  smartInterruption: false,
  humor: true,
  playfulMode: false,
  prankMode: false,
  emotionAwareness: true,
  aiPerspective: true,
  conversationMemory: true,
  quietMode: false,
  conversationCooldown: 1800,
  themeColor: "charcoal",
  uiDensity: "balanced",
  glassIntensity: 72,
  adaptiveAppearance: true,
  animationProfile: "classic",
  cameraMonitoringConsent: false,
  screenMonitoringConsent: false,
  activityMetadataPersistence: true,
  activityMetadataRetentionDays: 7,
  activeModelId: "astra", // default active model
};

const STORAGE_KEY = "sara.settings.v2";

/** Settings keys that the browser should never persist (security). */
const NEVER_PERSIST: ReadonlySet<keyof SaraSettings> = new Set([]);

/**
 * Load settings from localStorage, merged over defaults so new keys always
 * have a sane value even when an older payload is present.
 */
export function loadSettings(): SaraSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<SaraSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persist a full or partial settings update to localStorage.
 * Returns the fully merged settings object.
 */
export function saveSettings(patch: Partial<SaraSettings>): SaraSettings {
  const current = loadSettings();
  const next: SaraSettings = { ...current, ...patch };
  if (typeof window !== "undefined") {
    try {
      // Strip any sensitive keys before writing to localStorage.
      const safe: Record<string, unknown> = {};
      (Object.keys(next) as (keyof SaraSettings)[]).forEach((k) => {
        if (!NEVER_PERSIST.has(k)) safe[k] = next[k];
      });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
    } catch {
      /* localStorage may be unavailable (private mode) â€” fail silently. */
    }
  }
  // Best-effort sync to backend so the Python agent can read auto-start state.
  void syncSettingsToBackend(next).catch(() => {});
  return next;
}

/** Push settings to the backend (server.ts persists to settings.json). */
async function syncSettingsToBackend(settings: SaraSettings): Promise<void> {
  try {
    const request = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    };
    await fetch("/api/settings", request);
    await fetch("/api/social/settings", request);
  } catch {
    /* Backend may be briefly unavailable during boot â€” non-fatal. */
  }
}

