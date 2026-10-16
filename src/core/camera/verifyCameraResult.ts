import { existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type CameraAction = "start" | "stop" | "status" | "analyze" | "photo" | "record_start" | "record_stop";

/** The browser reports camera state; saved media additionally needs a server-side file check. */
export function verifyCameraResult(action: CameraAction, output: unknown, startedAt: number, mediaRoot: string): Record<string, unknown> {
  const observed = output && typeof output === "object" ? output as Record<string, unknown> : {};
  if (observed.ok !== true) return { ok: false, verified: false, error: typeof observed.error === "string" ? observed.error : "The camera action did not complete." };
  const isPhoto = action === "photo";
  const savedRecording = action === "record_stop" || action === "record_start" && observed.saved === true;
  if (isPhoto || savedRecording) {
    const filename = typeof observed.filename === "string" ? observed.filename : "";
    const validName = isPhoto ? /^\d{13}-[a-f0-9]{12}\.(?:jpg|png)$/i.test(filename)
      : /^\d{13}-[a-f0-9]{12}\.webm$/i.test(filename);
    const expected = join(mediaRoot, isPhoto ? "photos" : "videos", filename);
    if (!validName || !existsSync(expected) || typeof observed.path !== "string" || resolve(observed.path) !== resolve(expected)) {
      return { ok: false, verified: false, error: "The expected saved camera file was not found." };
    }
    const stat = statSync(expected);
    const bytes = stat.size;
    const validSize = bytes > 100 && bytes <= (isPhoto ? 16 : 50) * 1024 * 1024 &&
      stat.mtimeMs >= startedAt - 2_000;
    const signature = readFileSync(expected, { encoding: null }).subarray(0, 8);
    const validMedia = isPhoto
      ? filename.toLowerCase().endsWith(".png") ? signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : signature.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      : signature.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    return validSize && validMedia
      ? { ok: true, verified: true, filename, path: expected, bytes, result: isPhoto ? "Photo saved and verified." : "Video saved and verified." }
      : { ok: false, verified: false, error: "The saved media file was empty, stale, oversized, or invalid." };
  }
  if (action === "analyze") {
    return typeof observed.text === "string" && observed.text.trim()
      ? { ok: true, verified: false, text: observed.text.slice(0, 3000), basis: "browser_received_provider_analysis" }
      : { ok: false, verified: false, error: "Camera analysis returned no visual description." };
  }
  return { ok: true, verified: false, stream_active: observed.streamActive === true,
    recording: observed.recording === true, status: observed.status || "unknown",
    basis: "browser_media_track_observation_not_saved_media_verification" };
}
