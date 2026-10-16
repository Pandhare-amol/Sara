import type { CameraAction } from "./verifyCameraResult";

/** Model tool arguments are not authorization to start a camera or save media. */
export function cameraActionRequested(action: CameraAction, latestUserText: string): boolean {
  if (action === "stop" || action === "status" || action === "record_stop") return true;
  const text = latestUserText.trim().toLowerCase().slice(0, 500);
  if (!text) return false;
  if (action === "photo") return /\b(photo|picture|selfie|snapshot)\b/.test(text) &&
    /\b(take|capture|shoot|save|snap|click)\b/.test(text);
  if (action === "record_start") return /\b(record|recording|video|film)\b/.test(text) &&
    /\b(start|record|capture|shoot|make|take)\b/.test(text);
  return /\b(camera|webcam|photo|picture|selfie|look at me|see me|wearing|appearance|outfit|how do i look)\b/.test(text);
}
