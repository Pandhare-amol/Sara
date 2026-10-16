export interface GlobalNotificationPayload {
  title: string;
  message: string;
  severity?: "info" | "warning" | "critical";
  tag?: string;
  source?: "system-monitor" | "automation" | "application";
  id?: number;
  createdAt?: number;
}

const VOICE_ALERTS_KEY = "sara.resourceVoiceAlerts";

export function areVoiceAlertsEnabled(): boolean {
  try {
    return window.localStorage.getItem(VOICE_ALERTS_KEY) === "true";
  } catch {
    return false;
  }
}

export function setVoiceAlertsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(VOICE_ALERTS_KEY, enabled ? "true" : "false");
  } catch {
    // Storage can be unavailable in private browser contexts.
  }
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/** Show an OS/browser notification and, only when opted in, a short local voice alert. */
export function presentGlobalNotification(payload: GlobalNotificationPayload, options: { allowVoice?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const title = String(payload.title || "SARA notification").slice(0, 100);
  const message = String(payload.message || "").slice(0, 600);

  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, {
        body: message,
        tag: payload.tag || `sara-${Date.now()}`,
        silent: true,
      });
    }
  } catch {
    // A denied or unavailable OS notification must not affect SARA.
  }

  if (!options.allowVoice || !areVoiceAlertsEnabled() || !message) return;
  try {
    if (!("speechSynthesis" in window) || !window.speechSynthesis || window.speechSynthesis.speaking) return;
    const utterance = new SpeechSynthesisUtterance(`${title}. ${message.slice(0, 220)}`);
    utterance.rate = 1;
    utterance.volume = 0.8;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Optional voice alerts are best-effort and never interrupt the main chat.
  }
}

export function dispatchGlobalNotification(payload: GlobalNotificationPayload): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("sara.globalNotification", { detail: payload }));
}
